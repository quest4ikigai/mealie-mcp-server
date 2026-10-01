import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const DOWNLOAD_TIMEOUT_MS = 30_000;
export const DOWNLOAD_MAX_REDIRECTS = 3;

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((r) => r.address);

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith('::ffff:')
    );
  }
  return true;
}

// Only public http(s) hosts may be fetched; every hop (including redirects) is re-validated.
async function assertSafeUrl(raw: string, resolve: HostResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('download_url is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('download_url must use http or https.');
  }
  if (url.username || url.password) {
    throw new Error('download_url must not contain credentials.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) throw new Error('download_url host could not be resolved.');
  if (addresses.some(isPrivateAddress)) {
    throw new Error('download_url points to a private or non-public address and was refused.');
  }
  return url;
}

async function readBodyBounded(res: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new Error(`Downloaded file exceeds the ${maxBytes / (1024 * 1024)} MB limit.`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}

export async function downloadBounded(
  rawUrl: string,
  maxBytes: number,
  options: { timeoutMs?: number; resolve?: HostResolver } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const resolve = options.resolve ?? defaultResolver;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let current = rawUrl;
  try {
    for (let hop = 0; hop <= DOWNLOAD_MAX_REDIRECTS; hop++) {
      const url = await assertSafeUrl(current, resolve);
      const res = await fetch(url, { redirect: 'manual', signal });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new Error(`Download failed: redirect ${res.status} without a Location header.`);
        current = new URL(location, url).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`Download failed: source responded with HTTP ${res.status}.`);
      }
      return await readBodyBounded(res, maxBytes);
    }
  } catch (error) {
    if (signal.aborted) throw new Error('Download timed out.');
    if (error instanceof Error && /^(Download|Downloaded|download_url)/.test(error.message)) throw error;
    throw new Error(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`Download failed: too many redirects (max ${DOWNLOAD_MAX_REDIRECTS}).`);
}

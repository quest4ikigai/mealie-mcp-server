import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export const DOWNLOAD_TIMEOUT_MS = 30_000;
export const DOWNLOAD_MAX_REDIRECTS = 3;

export type HostResolver = (hostname: string) => Promise<string[]>;

/** Performs one request to `url`, connecting only to `address` (already validated as public). */
export type PinnedTransport = (url: URL, address: string, signal: AbortSignal) => Promise<Response>;

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
    // Allowlist global unicast (2000::/3) minus special-use ranges; everything else is non-public.
    const groups = lower.split(':');
    const first = parseInt(groups[0] || '0', 16);
    const second = parseInt(groups[1] || '0', 16);
    if (first < 0x2000 || first > 0x3fff) return true;
    if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return true; // 2001::/23, 2001:db8::/32
    if (first === 0x2002) return true; // 6to4 (embeds IPv4)
    if (first === 0x3fff && second < 0x1000) return true; // 3fff::/20 documentation
    return false;
  }
  return true;
}

// Only public http(s) hosts may be fetched; every hop (including redirects) is re-validated.
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Download timed out.'));
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new Error('Download timed out.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function assertSafeUrl(
  raw: string,
  resolve: HostResolver,
  signal: AbortSignal,
): Promise<{ url: URL; address: string }> {
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
  const addresses = isIP(host) ? [host] : await raceAbort(resolve(host), signal).catch(() => []);
  if (addresses.length === 0) throw new Error('download_url host could not be resolved.');
  if (addresses.some(isPrivateAddress)) {
    throw new Error('download_url points to a private or non-public address and was refused.');
  }
  // Pin the connection to a validated address so a second DNS answer cannot redirect it (DNS rebinding).
  return { url, address: addresses[0] };
}

/**
 * Real transport: node:http(s) with a lookup that always answers with the validated address, so the
 * hostname (Host header, TLS SNI/certificate check) is preserved while DNS is never consulted again.
 * The connected socket's remote address is re-validated as defense in depth.
 */
export const pinnedTransport: PinnedTransport = (url, address, signal) =>
  new Promise<Response>((resolvePromise, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const family = isIP(address);
    const req = mod.request(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
      },
      (res) => {
        const remote = res.socket.remoteAddress;
        if (!remote || isPrivateAddress(remote)) {
          res.destroy();
          reject(new Error('download_url connected to a private or non-public address and was refused.'));
          return;
        }
        const headers = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new Error(`Download failed: source responded with unsupported HTTP status ${status}.`));
          return;
        }
        const nullBody = status === 204 || status === 205 || status === 304;
        resolvePromise(
          new Response(nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), {
            status,
            headers,
          }),
        );
      },
    );
    req.on('socket', (socket) => {
      socket.once('connect', () => {
        const remote = socket.remoteAddress;
        if (!remote || isPrivateAddress(remote)) {
          req.destroy(new Error('download_url connected to a private or non-public address and was refused.'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });

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
  options: { timeoutMs?: number; resolve?: HostResolver; transport?: PinnedTransport } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const resolve = options.resolve ?? defaultResolver;
  const transport = options.transport ?? pinnedTransport;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let current = rawUrl;
  try {
    for (let hop = 0; hop <= DOWNLOAD_MAX_REDIRECTS; hop++) {
      const { url, address } = await assertSafeUrl(current, resolve, signal);
      const res = await transport(url, address, signal);
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

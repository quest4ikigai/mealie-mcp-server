import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const DOWNLOAD_TIMEOUT_MS = 20_000;
export const DOWNLOAD_MAX_REDIRECTS = 3;

function ipv4Blocked(ip: string): boolean {
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

function ipBlocked(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Blocked(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  if (v6.startsWith('::ffff:')) return true;
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function assertPublicHttps(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('download_url is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new Error('download_url must use https.');
  if (url.username || url.password) throw new Error('download_url must not contain credentials.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => {
        throw new Error('Could not resolve the download host.');
      })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(ipBlocked)) {
    throw new Error('download_url points to a private or internal address, which is not allowed.');
  }
  return url;
}

// Downloads a remote file with SSRF guards: https only, public addresses only (re-checked on every
// redirect hop, redirects capped), bounded timeout, and a streamed byte cap so oversized bodies are
// never fully buffered. Note: DNS is resolved separately from the fetch, so this is best-effort
// against DNS rebinding.
export async function downloadFileBytes(rawUrl: string, maxBytes: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const tooLarge = () => new Error(`Downloaded file exceeds the ${maxBytes / (1024 * 1024)} MB limit.`);
  let current = rawUrl;

  for (let hop = 0; ; hop++) {
    const url = await assertPublicHttps(current);
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new Error(timedOut ? 'Timed out downloading the file.' : 'Failed to download the file.');
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`Download failed: redirect ${res.status} without a Location.`);
      if (hop >= DOWNLOAD_MAX_REDIRECTS) throw new Error('Download failed: too many redirects.');
      current = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Download failed with HTTP status ${res.status}.`);
    }

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    if (!res.body) return Buffer.alloc(0);

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
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
    } catch (error) {
      if (error instanceof Error && error.message.includes('MB limit')) throw error;
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new Error(timedOut ? 'Timed out downloading the file.' : 'Download was interrupted.');
    }
    return Buffer.concat(chunks);
  }
}

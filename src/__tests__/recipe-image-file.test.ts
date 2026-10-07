import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../api/recipes.js', () => ({
  uploadRecipeImage: vi.fn(),
  deleteRecipeImage: vi.fn(),
  setRecipeImageFromUrl: vi.fn(),
}));

import * as recipesApi from '../api/recipes.js';
import { setRecipeImageFromFile, setRecipeImage, RECIPE_IMAGE_MAX_BYTES } from '../lib/recipe-image.js';
import { isPrivateAddress, pinnedTransport, createPinnedTransport, downloadBounded } from '../lib/safe-download.js';
import { registerRecipeTools } from '../tools/recipes.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a....');

const resolve = () => Promise.resolve(['93.184.216.34']);
const file = (extra: Record<string, unknown> = {}) => ({
  download_url: 'https://files.example.com/a',
  file_id: 'file_1',
  ...extra,
});
const ok = (body: Buffer | Uint8Array, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(body), { status: 200, headers });

const fetchMock = vi.fn();
const transport = (url: URL, addresses: string[], signal: AbortSignal): Promise<Response> =>
  fetchMock(url, { signal, addresses }) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.mocked(recipesApi.uploadRecipeImage).mockResolvedValue({ image: 'v1' });
});

describe('setRecipeImageFromFile', () => {
  it.each([
    ['png', PNG],
    ['jpg', JPG],
    ['webp', WEBP],
    ['gif', GIF],
  ])('downloads and uploads %s', async (ext, buf) => {
    fetchMock.mockResolvedValue(ok(buf));
    const result = await setRecipeImageFromFile('soup', file(), { transport, resolve });
    expect(result).toEqual({ image: 'v1' });
    const [slug, bytes, e] = vi.mocked(recipesApi.uploadRecipeImage).mock.calls[0];
    expect(slug).toBe('soup');
    expect(e).toBe(ext);
    expect(Array.from(bytes)).toEqual(Array.from(buf));
    expect(recipesApi.deleteRecipeImage).not.toHaveBeenCalled();
  });

  it('ignores misleading or absent mime_type and file_name', async () => {
    fetchMock.mockResolvedValue(ok(PNG));
    await setRecipeImageFromFile('s', file({ mime_type: 'image/jpeg', file_name: 'x.gif' }), { transport, resolve });
    expect(vi.mocked(recipesApi.uploadRecipeImage).mock.calls[0][2]).toBe('png');
    fetchMock.mockResolvedValue(ok(JPG));
    await setRecipeImageFromFile('s', file(), { transport, resolve });
    expect(vi.mocked(recipesApi.uploadRecipeImage).mock.calls[1][2]).toBe('jpg');
  });

  it('rejects unsupported, truncated, and empty content before mutating Mealie', async () => {
    for (const body of [Buffer.from('<html>nope</html>'), Buffer.from([0x89, 0x50, 0x4e]), Buffer.alloc(0)]) {
      fetchMock.mockResolvedValueOnce(ok(body));
      await expect(setRecipeImageFromFile('s', file(), { transport, resolve })).rejects.toThrow(/Unsupported|empty/);
    }
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('rejects non-2xx responses and fetch errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 404 }));
    await expect(setRecipeImageFromFile('s', file(), { transport, resolve })).rejects.toThrow(/HTTP 404/);
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await expect(setRecipeImageFromFile('s', file(), { transport, resolve })).rejects.toThrow(/Download failed: boom/);
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('times out slow downloads', async () => {
    fetchMock.mockImplementation(
      (_u: unknown, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))),
    );
    await expect(setRecipeImageFromFile('s', file(), { transport, resolve, timeoutMs: 10 })).rejects.toThrow(/timed out/);
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('applies the timeout to hostname resolution', async () => {
    const hang = () => new Promise<string[]>(() => undefined);
    await expect(setRecipeImageFromFile('s', file(), { transport, resolve: hang, timeoutMs: 10 })).rejects.toThrow(/timed out/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces the 10 MB boundary on streamed bytes and declared length', async () => {
    const atLimit = Buffer.concat([PNG, Buffer.alloc(RECIPE_IMAGE_MAX_BYTES - PNG.length)]);
    fetchMock.mockResolvedValueOnce(ok(atLimit));
    await setRecipeImageFromFile('s', file(), { transport, resolve });
    expect(recipesApi.uploadRecipeImage).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(ok(Buffer.concat([atLimit, Buffer.from([0])])));
    await expect(setRecipeImageFromFile('s', file(), { transport, resolve })).rejects.toThrow(/limit/);

    fetchMock.mockResolvedValueOnce(ok(PNG, { 'content-length': String(RECIPE_IMAGE_MAX_BYTES + 1) }));
    await expect(setRecipeImageFromFile('s', file(), { transport, resolve })).rejects.toThrow(/limit/);
    expect(recipesApi.uploadRecipeImage).toHaveBeenCalledTimes(1);
  });

  it('follows redirects with re-validation, up to a limit', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/b' } }))
      .mockResolvedValueOnce(ok(PNG));
    await setRecipeImageFromFile('s', file(), { transport, resolve });
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://files.example.com/b');
    expect((fetchMock.mock.calls[0][1] as { addresses: string[] }).addresses).toEqual(['93.184.216.34']);

    fetchMock.mockReset();
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: '/loop' } })),
    );
    await expect(setRecipeImageFromFile('s', file(), { transport, resolve })).rejects.toThrow(/too many redirects/);
  });

  it('refuses private targets, including via redirect, and bad schemes', async () => {
    await expect(
      setRecipeImageFromFile('s', file({ download_url: 'http://127.0.0.1/x' }), { transport, resolve }),
    ).rejects.toThrow(/private/);
    await expect(
      setRecipeImageFromFile('s', file({ download_url: 'file:///etc/passwd' }), { transport, resolve }),
    ).rejects.toThrow(/http or https/);
    await expect(
      setRecipeImageFromFile('s', file(), { transport, resolve: () => Promise.resolve(['10.0.0.5']) }),
    ).rejects.toThrow(/private/);
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    await expect(setRecipeImageFromFile('s', file(), { transport, resolve })).rejects.toThrow(/private/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('classifies addresses', () => {
    for (const ip of ['10.1.1.1', '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1', '192.168.0.1', '172.16.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', 'fec0::1', '::ffff:127.0.0.1', '64:ff9b:1::1', '100::1', '2001:db8::1', 'ff02::1', '2002:7f00:1::1', '2001::1', '3fff::1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['93.184.216.34', '192.0.1.1', '2606:2800:220:1::1', '2a00:1450:4001::1']) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('existing image paths remain intact', () => {
  it('set_recipe_image still uploads base64 and deletes on null', async () => {
    await setRecipeImage('s', PNG.toString('base64'));
    expect(recipesApi.uploadRecipeImage).toHaveBeenCalledTimes(1);
    vi.mocked(recipesApi.deleteRecipeImage).mockResolvedValue({});
    await setRecipeImage('s', null);
    expect(recipesApi.deleteRecipeImage).toHaveBeenCalledWith('s');
  });
});

describe('set_recipe_image_from_file registration', () => {
  function capture() {
    const registered: Record<string, { args: unknown[]; handle: { _meta?: Record<string, unknown> } }> = {};
    const server = {
      tool: vi.fn((name: string, ...args: unknown[]) => {
        const handle = {};
        registered[name] = { args, handle };
        return handle;
      }),
    };
    registerRecipeTools(server as never);
    return registered;
  }

  it('advertises openai/fileParams and the four-property file schema', () => {
    const t = capture().set_recipe_image_from_file;
    expect(t.handle._meta).toEqual({ 'openai/fileParams': ['file'] });
    const shape = t.args[1] as z.ZodRawShape;
    const json = z.toJSONSchema(z.object(shape)) as {
      properties: { file: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(Object.keys(json.properties.file.properties).sort()).toEqual(
      ['download_url', 'file_id', 'file_name', 'mime_type'],
    );
    expect([...json.properties.file.required].sort()).toEqual(['download_url', 'file_id']);
  });

  it('keeps set_recipe_image and set_recipe_image_from_url registered without file metadata', () => {
    const reg = capture();
    expect(reg.set_recipe_image.handle._meta).toBeUndefined();
    expect(reg.set_recipe_image_from_url.handle._meta).toBeUndefined();
  });

  it('emits openai/fileParams in a real McpServer tools/list response only for the file tool', async () => {
    const server = new McpServer({ name: 'mealie-mcp-server', version: '1.0.0' });
    registerRecipeTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const { tools } = await client.listTools();
      const byName = (name: string) => tools.find((t) => t.name === name)!;
      expect(byName('set_recipe_image_from_file')._meta).toEqual({ 'openai/fileParams': ['file'] });
      expect(byName('set_recipe_image')._meta?.['openai/fileParams']).toBeUndefined();
      expect(byName('set_recipe_image_from_url')._meta?.['openai/fileParams']).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('DNS pinning', () => {
  it('connects to the validated addresses for each redirect hop, not a fresh resolution', async () => {
    const answers = [['2606:2800:220:1::1', '93.184.216.34'], ['93.184.216.35']];
    const rotating = vi.fn(() => Promise.resolve(answers.shift()!));
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://other.example.com/b' } }))
      .mockResolvedValueOnce(ok(PNG));
    await downloadBounded('https://files.example.com/a', 1024, { resolve: rotating, transport });
    expect(rotating).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => (c[1] as { addresses: string[] }).addresses)).toEqual([
      ['2606:2800:220:1::1', '93.184.216.34'],
      ['93.184.216.35'],
    ]);
  });

  it('refuses a resolver answer that mixes public and private addresses', async () => {
    await expect(
      downloadBounded('https://files.example.com/a', 1024, {
        resolve: () => Promise.resolve(['93.184.216.34', '10.0.0.5']),
        transport,
      }),
    ).rejects.toThrow(/private/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pinnedTransport falls back to the next validated address when the first is unreachable', async () => {
    const server = http.createServer((_req, res) => res.end('hi'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      // ::1 is not listening on this port, so the connection must fall back to 127.0.0.1.
      const res = await createPinnedTransport(() => false)(
        new URL(`http://pinned.invalid:${port}/`),
        ['::1', '127.0.0.1'],
        AbortSignal.timeout(5000),
      );
      expect(await res.text()).toBe('hi');
    } finally {
      server.close();
    }
  });

  it('pinnedTransport rejects out-of-range HTTP statuses without crashing', async () => {
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end('HTTP/1.1 700 Weird\r\nContent-Length: 0\r\n\r\n'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        createPinnedTransport(() => false)(
          new URL(`http://pinned.invalid:${port}/`),
          ['127.0.0.1'],
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow(/unsupported HTTP status 700/);
    } finally {
      server.close();
    }
  });

  it('pinnedTransport connects to the pinned address regardless of hostname and keeps the Host header', async () => {
    let host: string | undefined;
    const server = http.createServer((req, res) => {
      host = req.headers.host;
      res.end('hi');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      // 127.0.0.1 is private, so the defense-in-depth remote check must refuse it...
      await expect(
        pinnedTransport(new URL(`http://pinned.invalid:${port}/`), ['127.0.0.1'], AbortSignal.timeout(5000)),
      ).rejects.toThrow(/private/);
      // ...but only after connecting via the pinned address (pinned.invalid never resolves in DNS).
      expect(host).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe('safe-download edge cases', () => {
  const listen = async (server: http.Server | net.Server) => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return (server.address() as AddressInfo).port;
  };

  it('treats anything that is not an IP literal as non-public', () => {
    for (const v of ['', 'not-an-ip', 'files.example.com', '999.1.1.1']) expect(isPrivateAddress(v)).toBe(true);
  });

  it('rejects malformed URLs and URLs carrying credentials before resolving or connecting', async () => {
    const resolver = vi.fn(resolve);
    await expect(downloadBounded('not a url', 1024, { resolve: resolver, transport })).rejects.toThrow(
      'download_url is not a valid URL.',
    );
    await expect(
      downloadBounded('https://user:secret@files.example.com/a', 1024, { resolve: resolver, transport }),
    ).rejects.toThrow('download_url must not contain credentials.');
    await expect(
      downloadBounded('https://:secret@files.example.com/a', 1024, { resolve: resolver, transport }),
    ).rejects.toThrow('download_url must not contain credentials.');
    expect(resolver).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a redirect without a Location header', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302 }));
    await expect(downloadBounded('https://files.example.com/a', 1024, { resolve, transport })).rejects.toThrow(
      'Download failed: redirect 302 without a Location header.',
    );
  });

  it('treats a bodiless 204 response as an empty file and does not mutate Mealie', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(setRecipeImageFromFile('soup', file(), { resolve, transport })).rejects.toThrow(
      'Downloaded file is empty.',
    );
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('does not follow a redirect that arrives after the timeout', async () => {
    const resolver = vi.fn(resolve);
    fetchMock.mockImplementation(
      (_url: URL, { signal }: { signal: AbortSignal }) =>
        new Promise((r) =>
          signal.addEventListener('abort', () =>
            r(new Response(null, { status: 302, headers: { location: 'https://other.example.com/b' } })),
          ),
        ),
    );
    await expect(
      downloadBounded('https://files.example.com/a', 1024, { resolve: resolver, transport, timeoutMs: 20 }),
    ).rejects.toThrow('Download timed out.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('wraps unexpected transport failures, including non-Error rejections', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(downloadBounded('https://files.example.com/a', 1024, { resolve, transport })).rejects.toThrow(
      'Download failed: socket hang up',
    );
    fetchMock.mockRejectedValueOnce('boom');
    await expect(downloadBounded('https://files.example.com/a', 1024, { resolve, transport })).rejects.toThrow(
      'Download failed: boom',
    );
  });

  it('uses the system resolver and pinned transport by default, refusing a host that resolves privately', async () => {
    await expect(downloadBounded('http://localhost/a.png', 1024)).rejects.toThrow(
      'download_url points to a private or non-public address and was refused.',
    );
  });

  it('pinnedTransport uses the pinned lookup for https too (no DNS for the hostname)', async () => {
    const closed = net.createServer();
    const port = await listen(closed);
    await new Promise<void>((r) => closed.close(() => r()));
    // pinned.invalid never resolves, so ECONNREFUSED (not ENOTFOUND) proves the pinned address was dialled.
    await expect(
      createPinnedTransport(() => false)(
        new URL(`https://pinned.invalid:${port}/`),
        ['127.0.0.1'],
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('pinnedTransport answers single-address lookups when happy-eyeballs is disabled', async () => {
    const server = http.createServer((_req, res) => res.end('hi'));
    const port = await listen(server);
    const previous = net.getDefaultAutoSelectFamily();
    net.setDefaultAutoSelectFamily(false);
    try {
      const res = await createPinnedTransport(() => false)(
        new URL(`http://pinned.invalid:${port}/`),
        ['127.0.0.1'],
        AbortSignal.timeout(5000),
      );
      expect(await res.text()).toBe('hi');
    } finally {
      net.setDefaultAutoSelectFamily(previous);
      server.close();
    }
  });

  it('pinnedTransport re-validates the remote address again when the response arrives', async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.end('hi');
    });
    const port = await listen(server);
    // Public at connect time, private by the time the response arrives: the second check must still refuse it.
    let checks = 0;
    try {
      await expect(
        createPinnedTransport(() => ++checks > 1)(
          new URL(`http://pinned.invalid:${port}/`),
          ['127.0.0.1'],
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow('download_url connected to a private or non-public address and was refused.');
      expect(requests).toBe(1);
      expect(checks).toBe(2);
    } finally {
      server.close();
    }
  });
});

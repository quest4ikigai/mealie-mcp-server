import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/recipes.js', () => ({
  uploadRecipeImage: vi.fn(),
  deleteRecipeImage: vi.fn(),
  setRecipeImageFromUrl: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn((host: string) => Promise.resolve( [{ address: host === 'internal.test' ? '10.0.0.5' : '93.184.216.34', family: 4 }])),
}));

import * as recipesApi from '../api/recipes.js';
import { registerRecipeTools } from '../tools/recipes.js';
import { setRecipeImageFromFile, RECIPE_IMAGE_MAX_BYTES } from '../lib/recipe-image.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a....');
const URL_OK = 'https://files.example.com/f/1';

const ref = (over: Record<string, unknown> = {}) => ({
  download_url: URL_OK,
  file_id: 'file_1',
  ...over,
});
const ok = (body: Buffer, init: ResponseInit = {}) => new Response(new Uint8Array(body), { status: 200, ...init });

let fetchMock: ReturnType<typeof vi.fn<(url: URL, init: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(recipesApi.uploadRecipeImage).mockResolvedValue({ image: 'v1' });
});
afterEach(() => vi.unstubAllGlobals());

describe('setRecipeImageFromFile', () => {
  it.each([
    ['png', PNG],
    ['jpg', JPG],
    ['webp', WEBP],
    ['gif', GIF],
  ])('downloads and uploads %s regardless of name/mime hints', async (ext, buf) => {
    fetchMock.mockResolvedValue(ok(buf));
    for (const hints of [{}, { file_name: 'x.txt', mime_type: 'text/plain' }, { file_name: 'a.bmp', mime_type: 'image/bmp' }]) {
      vi.mocked(recipesApi.uploadRecipeImage).mockClear();
      await setRecipeImageFromFile('soup', ref(hints));
      const [slug, bytes, e] = vi.mocked(recipesApi.uploadRecipeImage).mock.calls[0];
      expect(slug).toBe('soup');
      expect(e).toBe(ext);
      expect(Array.from(bytes)).toEqual(Array.from(buf));
      fetchMock.mockResolvedValue(ok(buf));
    }
  });

  it.each([
    ['unsupported content', ok(Buffer.from('hello world'))],
    ['truncated image', ok(Buffer.from([0x89, 0x50, 0x4e]))],
    ['empty body', ok(Buffer.alloc(0))],
  ])('rejects %s before Mealie mutation', async (_n, res) => {
    fetchMock.mockResolvedValue(res);
    await expect(setRecipeImageFromFile('soup', ref())).rejects.toThrow();
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('rejects non-2xx responses', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 404 }));
    await expect(setRecipeImageFromFile('soup', ref())).rejects.toThrow(/404/);
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('reports download errors and timeouts', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    await expect(setRecipeImageFromFile('soup', ref())).rejects.toThrow(/Failed to download/);
    fetchMock.mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(setRecipeImageFromFile('soup', ref())).rejects.toThrow(/Timed out/);
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('enforces the 10 MB limit at the boundary, on the streamed bytes', async () => {
    const atLimit = Buffer.concat([PNG, Buffer.alloc(RECIPE_IMAGE_MAX_BYTES - PNG.length)]);
    fetchMock.mockResolvedValue(ok(atLimit));
    await setRecipeImageFromFile('soup', ref());
    expect(recipesApi.uploadRecipeImage).toHaveBeenCalledTimes(1);

    vi.mocked(recipesApi.uploadRecipeImage).mockClear();
    fetchMock.mockResolvedValue(ok(Buffer.concat([atLimit, Buffer.from([0])])));
    await expect(setRecipeImageFromFile('soup', ref())).rejects.toThrow(/limit/);
    fetchMock.mockResolvedValue(ok(PNG, { headers: { 'content-length': String(RECIPE_IMAGE_MAX_BYTES + 1) } }));
    await expect(setRecipeImageFromFile('soup', ref())).rejects.toThrow(/limit/);
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('follows redirects manually, re-validating each hop', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(ok(PNG));
    await setRecipeImageFromFile('soup', ref());
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://files.example.com/next');
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/x' } }));
    await expect(setRecipeImageFromFile('soup', ref())).rejects.toThrow(/private/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 302, headers: { location: '/loop' } })));
    await expect(setRecipeImageFromFile('soup', ref())).rejects.toThrow(/too many redirects/);
  });

  it.each([
    'http://files.example.com/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://169.254.169.254/latest',
    'https://192.168.1.1/a',
    'https://[::ffff:10.0.0.1]/a',
    'https://internal.test/a',
    'https://user:pw@files.example.com/a',
    'not a url',
  ])('refuses unsafe download_url %s without fetching', async (url) => {
    await expect(setRecipeImageFromFile('soup', ref({ download_url: url }))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });
});

describe('set_recipe_image_from_file tool descriptor', () => {
  it('declares the file schema and openai/fileParams metadata', () => {
    const update = vi.fn();
    const shapes = new Map<string, Record<string, { safeParse: (v: unknown) => { success: boolean } }>>();
    const server = {
      tool: vi.fn((name: string, _d: string, shape: Record<string, never>) => {
        shapes.set(name, shape);
        return name === 'set_recipe_image_from_file' ? { update } : undefined;
      }),
    };
    registerRecipeTools(server as never);

    expect(update).toHaveBeenCalledWith({ _meta: { 'openai/fileParams': ['file'] } });
    const file = shapes.get('set_recipe_image_from_file')!.file;
    const good = { download_url: 'https://x', file_id: 'f' };
    expect(file.safeParse(good).success).toBe(true);
    expect(file.safeParse({ ...good, mime_type: 'image/png', file_name: 'a.png' }).success).toBe(true);
    expect(file.safeParse({ file_id: 'f' }).success).toBe(false);
    expect(file.safeParse({ download_url: 'https://x' }).success).toBe(false);
    expect(shapes.has('set_recipe_image')).toBe(true);
    expect(shapes.has('set_recipe_image_from_url')).toBe(true);
  });
});

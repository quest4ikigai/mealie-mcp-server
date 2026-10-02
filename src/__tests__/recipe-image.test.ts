import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/recipes.js', () => ({
  uploadRecipeImage: vi.fn(),
  deleteRecipeImage: vi.fn(),
}));

import * as recipesApi from '../api/recipes.js';
import { setRecipeImage, decodeRecipeImage, RECIPE_IMAGE_MAX_BYTES } from '../lib/recipe-image.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a....');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('decodeRecipeImage', () => {
  it.each([
    ['png', PNG],
    ['jpg', JPG],
    ['webp', WEBP],
    ['gif', GIF],
  ])('detects %s', (ext, buf) => {
    expect(decodeRecipeImage(buf.toString('base64')).extension).toBe(ext);
  });

  it('accepts a data URI prefix and normalizes jpeg', () => {
    const r = decodeRecipeImage(`data:image/jpeg;base64,${JPG.toString('base64')}`, '.JPEG');
    expect(r.extension).toBe('jpg');
    expect(Array.from(r.bytes)).toEqual(Array.from(JPG));
  });

  it('rejects malformed base64, empty data, unsupported formats, mismatched extension, and oversize', () => {
    expect(() => decodeRecipeImage('not base64!!')).toThrow(/valid base64/);
    expect(() => decodeRecipeImage('')).toThrow(/valid base64/);
    expect(() => decodeRecipeImage(Buffer.from('hello world').toString('base64'))).toThrow(/Unsupported/);
    expect(() => decodeRecipeImage(PNG.toString('base64'), 'jpg')).toThrow(/does not match/);
    const big = Buffer.concat([PNG, Buffer.alloc(RECIPE_IMAGE_MAX_BYTES)]);
    expect(() => decodeRecipeImage(big.toString('base64'))).toThrow(/limit/);
  });
});

describe('setRecipeImage', () => {
  it('uploads validated bytes with the detected extension', async () => {
    vi.mocked(recipesApi.uploadRecipeImage).mockResolvedValue({ image: 'v1' });
    const result = await setRecipeImage('soup', PNG.toString('base64'));
    expect(result).toEqual({ image: 'v1' });
    const [slug, bytes, ext] = vi.mocked(recipesApi.uploadRecipeImage).mock.calls[0];
    expect(slug).toBe('soup');
    expect(ext).toBe('png');
    expect(Array.from(bytes)).toEqual(Array.from(PNG));
  });

  it('deletes the image when null', async () => {
    vi.mocked(recipesApi.deleteRecipeImage).mockResolvedValue({ message: 'deleted' });
    await setRecipeImage('soup', null);
    expect(recipesApi.deleteRecipeImage).toHaveBeenCalledWith('soup');
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
  });

  it('does not call Mealie for invalid input', async () => {
    await expect(setRecipeImage('soup', 'Zm9v')).rejects.toThrow(/Unsupported/);
    expect(recipesApi.uploadRecipeImage).not.toHaveBeenCalled();
    expect(recipesApi.deleteRecipeImage).not.toHaveBeenCalled();
  });
});

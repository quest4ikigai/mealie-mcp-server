import * as recipesApi from '../api/recipes.js';

export const RECIPE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

type ImageExtension = 'png' | 'jpg' | 'webp' | 'gif';

const STRICT_BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((b, i) => bytes[offset + i] === b);
}

// Identify the format from magic bytes so the extension sent to Mealie always matches the content.
function detectExtension(bytes: Uint8Array): ImageExtension | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  return null;
}

function normalizeExtension(ext: string): string {
  const e = ext.trim().toLowerCase().replace(/^\./, '');
  return e === 'jpeg' ? 'jpg' : e;
}

export function decodeRecipeImage(
  imageBase64: string,
  extension?: string,
): { bytes: Uint8Array<ArrayBuffer>; extension: ImageExtension } {
  // Tolerate a data URI prefix and whitespace/line wrapping in the base64 payload.
  const payload = imageBase64.replace(/^\s*data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (!payload || !STRICT_BASE64.test(payload)) {
    throw new Error('imageBase64 is not valid base64-encoded data.');
  }
  const buffer = Buffer.from(payload, 'base64');
  const bytes = new Uint8Array(buffer.length);
  bytes.set(buffer);
  if (bytes.length === 0) throw new Error('imageBase64 decoded to an empty image.');
  if (bytes.length > RECIPE_IMAGE_MAX_BYTES) {
    throw new Error(`Image exceeds the ${RECIPE_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit.`);
  }
  const detected = detectExtension(bytes);
  if (!detected) {
    throw new Error('Unsupported image data: expected PNG, JPEG, WebP, or GIF.');
  }
  if (extension !== undefined && normalizeExtension(extension) !== detected) {
    throw new Error(`extension "${extension}" does not match the image data, which is ${detected}.`);
  }
  return { bytes, extension: detected };
}

// imageBase64 === null deletes the image; a string replaces it. Input is validated before any
// Mealie request so malformed data never mutates the recipe.
export async function setRecipeImage(
  slug: string,
  imageBase64: string | null,
  extension?: string,
): Promise<Record<string, unknown>> {
  if (imageBase64 === null) {
    return recipesApi.deleteRecipeImage(slug);
  }
  const { bytes, extension: ext } = decodeRecipeImage(imageBase64, extension);
  return recipesApi.uploadRecipeImage(slug, bytes, ext);
}

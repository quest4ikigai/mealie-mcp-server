import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({ config: { baseUrl: 'http://mealie.test', apiKey: 'k' } }));

import { encodePathSegment } from '../api/client.js';
import { deleteTool } from '../api/tools.js';
import { getRecipe, setRecipeImageFromUrl, uploadRecipeImage, deleteRecipeImage } from '../api/recipes.js';
import { getFood } from '../api/foods.js';
import { getUnit } from '../api/units.js';
import { deleteCategory } from '../api/categories.js';
import { deleteTag } from '../api/tags.js';
import { deleteMealplan } from '../api/mealplans.js';
import { deleteShoppingListItem } from '../api/shopping-lists.js';

// Values that may appear in a segment and must be encoded as data within it.
const payloads = [
  '..%2F..%2Frecipes%2Fpancakes',
  '%2e%2e',
  '?x=y',
  '#fragment',
  'name with spaces',
  'unicode-✓',
];

// Values containing a path separator are rejected outright, never encoded.
const separatorPayloads = [
  '../../recipes/pancakes',
  '../bar',
  'foo/bar',
  'foo\\bar',
  '..\\..\\recipes',
  '%2e%2e/%2e%2e/recipes/pancakes',
];

describe('encodePathSegment', () => {
  it.each(payloads)('encodes %s as a single segment', (p) => {
    const out = encodePathSegment(p);
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
    expect(out).not.toMatch(/[?#\s]/);
    expect(decodeURIComponent(out)).toBe(p);
  });

  it.each(separatorPayloads)('rejects %s because it contains a path separator', (p) => {
    expect(() => encodePathSegment(p, 'toolId')).toThrow('Invalid toolId.');
  });

  it.each(['', '  ', '.', '..', ' .. '])('rejects %j', (v) => {
    expect(() => encodePathSegment(v, 'toolId')).toThrow('Invalid toolId.');
  });

  it('leaves UUIDs and slugs unchanged', () => {
    expect(encodePathSegment('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(encodePathSegment('my-recipe_2')).toBe('my-recipe_2');
  });

  it('encodes percent signs exactly once', () => {
    expect(encodePathSegment('100%')).toBe('100%25');
  });
});

describe('requests handed to fetch', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const calledUrl = () => fetchMock.mock.calls[0][0] as string;

  it.each(payloads)('tool ID %s stays under /api/organizers/tools/', async (p) => {
    await deleteTool(p);
    const url = calledUrl();
    const prefix = 'http://mealie.test/api/organizers/tools/';
    expect(url.startsWith(prefix)).toBe(true);
    const rest = url.slice(prefix.length);
    expect(rest).not.toMatch(/[/\\?#]/);
    expect(new URL(url).pathname.split('/').length).toBe(5);
    expect(decodeURIComponent(rest)).toBe(p);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it.each(['.', '..', '', '  ', ...separatorPayloads])('blank/dot/separator segment %j fails before fetch', async (v) => {
    await expect(deleteTool(v)).rejects.toThrow();
    await expect(getRecipe(v)).rejects.toThrow('Invalid slug.');
    await expect(getFood(v)).rejects.toThrow();
    await expect(getUnit(v)).rejects.toThrow();
    await expect(async () => deleteCategory(v)).rejects.toThrow('Invalid id.');
    await expect(async () => deleteTag(v)).rejects.toThrow('Invalid id.');
    await expect(async () => deleteMealplan(v)).rejects.toThrow('Invalid id.');
    await expect(async () => deleteShoppingListItem(v)).rejects.toThrow('Invalid item ID.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recipe traversal payload fails before fetch', async () => {
    await expect(getRecipe('../../organizers/tools/x')).rejects.toThrow('Invalid slug.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pre-encoded traversal is double-encoded so a single decode cannot produce a separator', async () => {
    await getRecipe('..%2F..%2Forganizers%2Ftools%2Fx');
    expect(calledUrl()).toBe('http://mealie.test/api/recipes/..%252F..%252Forganizers%252Ftools%252Fx');
  });

  it('valid slugs and UUIDs pass through unchanged', async () => {
    await getRecipe('chocolate-pancakes');
    expect(calledUrl()).toBe('http://mealie.test/api/recipes/chocolate-pancakes');
    fetchMock.mockClear();
    await deleteTool('123e4567-e89b-12d3-a456-426614174000');
    expect(calledUrl()).toBe('http://mealie.test/api/organizers/tools/123e4567-e89b-12d3-a456-426614174000');
  });

  it('encodes spaces in a slug segment', async () => {
    await getRecipe('a b');
    expect(calledUrl()).toBe('http://mealie.test/api/recipes/a%20b');
  });
});

describe('recipe image routes', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const imageCalls: [string, (slug: string) => Promise<unknown>][] = [
    ['POST (from URL)', (slug) => setRecipeImageFromUrl(slug, 'https://example.com/a.png')],
    ['PUT (upload)', (slug) => uploadRecipeImage(slug, bytes, 'png')],
    ['DELETE', (slug) => deleteRecipeImage(slug)],
  ];

  describe.each(imageCalls)('%s /api/recipes/{slug}/image', (_name, call) => {
    it.each(['.', '..', '', '  ', ...separatorPayloads])('rejects slug %j before fetch', async (v) => {
      await expect(call(v)).rejects.toThrow('Invalid slug.');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(payloads)('keeps slug %s within a single segment', async (p) => {
      await call(p);
      const url = fetchMock.mock.calls[0][0] as string;
      const prefix = 'http://mealie.test/api/recipes/';
      expect(url.startsWith(prefix)).toBe(true);
      expect(url.endsWith('/image')).toBe(true);
      const segment = url.slice(prefix.length, -'/image'.length);
      expect(segment).not.toMatch(/[/\\?#]/);
      expect(decodeURIComponent(segment)).toBe(p);
    });

    it('passes a valid slug through unchanged', async () => {
      await call('chocolate-pancakes');
      expect(fetchMock.mock.calls[0][0]).toBe('http://mealie.test/api/recipes/chocolate-pancakes/image');
    });
  });
});

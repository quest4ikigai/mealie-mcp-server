import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({ config: { baseUrl: 'http://mealie.test', apiKey: 'k' } }));

import { encodePathSegment } from '../api/client.js';
import { getTool, updateTool, deleteTool } from '../api/tools.js';
import {
  getRecipe,
  patchRecipe,
  duplicateRecipe,
  setRecipeImageFromUrl,
  uploadRecipeImage,
  deleteRecipeImage,
  deleteRecipe,
  updateRecipe,
  updateRecipeLastMade,
} from '../api/recipes.js';
import { getFood, updateFood, deleteFood, mergeFoods } from '../api/foods.js';
import { getUnit, updateUnit, deleteUnit } from '../api/units.js';
import { getCategory, getCategoryBySlug, updateCategory, deleteCategory } from '../api/categories.js';
import { getTag, getTagBySlug, updateTag, deleteTag } from '../api/tags.js';
import { getMealplan, updateMealplan, deleteMealplan } from '../api/mealplans.js';
import {
  getShoppingList,
  updateShoppingList,
  deleteShoppingList,
  addRecipeToShoppingList,
  removeRecipeFromShoppingList,
  updateShoppingListItem,
  deleteShoppingListItem,
} from '../api/shopping-lists.js';
import { updateUserRating, getSelfRating } from '../api/users.js';

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

  it.each([undefined, null, 42])('rejects non-string value %j instead of interpolating it', (v) => {
    expect(() => encodePathSegment(v as unknown as string, 'id')).toThrow('Invalid id.');
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
    expect(new URL(url).pathname.split('/')).toHaveLength(5);
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

describe('rating, last-made and food-merge routes', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const urls = () => fetchMock.mock.calls.map((c) => c[0] as string);
  const invalid = ['.', '..', '', '  ', ...separatorPayloads];

  it.each(invalid)('rejects rating slug %j before fetch', async (v) => {
    await expect(updateUserRating(uuid, v, { rating: 4 })).rejects.toThrow('Invalid slug.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(invalid)('rejects rating user ID %j before fetch', async (v) => {
    await expect(updateUserRating(v, 'soup', { rating: 4 })).rejects.toThrow('Invalid user ID.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(invalid)('rejects self-rating recipe ID %j before fetch', async (v) => {
    await expect(getSelfRating(v)).rejects.toThrow('Invalid recipe ID.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(invalid)('rejects last-made slug %j before fetch', async (v) => {
    await expect(updateRecipeLastMade(v, '2026-01-01T00:00:00Z')).rejects.toThrow('Invalid slug.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(payloads)('keeps rating slug %s within a single segment', async (p) => {
    await updateUserRating(uuid, p, { rating: 4 });
    const url = urls()[0];
    const prefix = `http://mealie.test/api/users/${uuid}/ratings/`;
    expect(url.startsWith(prefix)).toBe(true);
    const segment = url.slice(prefix.length);
    expect(segment).not.toMatch(/[/\\?#]/);
    expect(decodeURIComponent(segment)).toBe(p);
  });

  it('passes valid rating, self-rating and last-made values through unchanged', async () => {
    await updateUserRating(uuid, 'chocolate-pancakes', { isFavorite: true });
    await getSelfRating(uuid);
    await updateRecipeLastMade('chocolate-pancakes', '2026-01-01T00:00:00Z');
    expect(urls()).toEqual([
      `http://mealie.test/api/users/${uuid}/ratings/chocolate-pancakes`,
      `http://mealie.test/api/users/self/ratings/${uuid}`,
      'http://mealie.test/api/recipes/chocolate-pancakes/last-made',
    ]);
  });

  it.each(invalid)('rejects merge_foods from-food ID %j before fetch', async (v) => {
    await expect(mergeFoods(v, uuid)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(payloads)('keeps the merge verification lookup for %s within a single segment', async (p) => {
    // Every request succeeds, so mergeFoods reaches its post-merge GET /api/foods/{fromId} check.
    await expect(mergeFoods(p, uuid)).rejects.toThrow('still exists');
    const url = urls().at(-1) as string;
    const prefix = 'http://mealie.test/api/foods/';
    expect(url.startsWith(prefix)).toBe(true);
    const segment = url.slice(prefix.length);
    expect(segment).not.toMatch(/[/\\?#]/);
    expect(decodeURIComponent(segment)).toBe(p);
  });
});

describe('every dynamic API route', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const U = '123e4567-e89b-12d3-a456-426614174000';
  const ts = '2026-01-01T00:00:00Z';
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  // [route, call with the dynamic value v (other dynamic arguments fixed to U), requests made when v = U]
  const routes: [string, (v: string) => Promise<unknown>, [string, string][]][] = [
    ['getRecipe', (v) => getRecipe(v), [['GET', `/api/recipes/${U}`]]],
    ['patchRecipe', (v) => patchRecipe(v, {}), [['PATCH', `/api/recipes/${U}`]]],
    ['duplicateRecipe', (v) => duplicateRecipe(v), [['POST', `/api/recipes/${U}/duplicate`]]],
    ['updateRecipeLastMade', (v) => updateRecipeLastMade(v, ts), [['PATCH', `/api/recipes/${U}/last-made`]]],
    ['setRecipeImageFromUrl', (v) => setRecipeImageFromUrl(v, 'https://example.com/a.png'), [['POST', `/api/recipes/${U}/image`]]],
    ['uploadRecipeImage', (v) => uploadRecipeImage(v, png, 'png'), [['PUT', `/api/recipes/${U}/image`]]],
    ['deleteRecipeImage', (v) => deleteRecipeImage(v), [['DELETE', `/api/recipes/${U}/image`]]],
    ['deleteRecipe', (v) => deleteRecipe(v), [['DELETE', `/api/recipes/${U}`]]],
    ['updateRecipe', (v) => updateRecipe(v, {}), [['PUT', `/api/recipes/${U}`]]],
    ['getCategory', (v) => getCategory(v), [['GET', `/api/organizers/categories/${U}`]]],
    ['getCategoryBySlug', (v) => getCategoryBySlug(v), [['GET', `/api/organizers/categories/slug/${U}`]]],
    ['updateCategory', (v) => updateCategory(v, {}), [['PUT', `/api/organizers/categories/${U}`]]],
    ['deleteCategory', (v) => deleteCategory(v), [['DELETE', `/api/organizers/categories/${U}`]]],
    ['getTag', (v) => getTag(v), [['GET', `/api/organizers/tags/${U}`]]],
    ['getTagBySlug', (v) => getTagBySlug(v), [['GET', `/api/organizers/tags/slug/${U}`]]],
    ['updateTag', (v) => updateTag(v, {}), [['PUT', `/api/organizers/tags/${U}`]]],
    ['deleteTag', (v) => deleteTag(v), [['DELETE', `/api/organizers/tags/${U}`]]],
    ['getTool', (v) => getTool(v), [['GET', `/api/organizers/tools/${U}`]]],
    ['updateTool', (v) => updateTool(v, { name: 'Whisk' }), [['GET', `/api/organizers/tools/${U}`], ['PUT', `/api/organizers/tools/${U}`]]],
    ['deleteTool', (v) => deleteTool(v), [['DELETE', `/api/organizers/tools/${U}`]]],
    ['getFood', (v) => getFood(v), [['GET', `/api/foods/${U}`]]],
    ['updateFood', (v) => updateFood(v, { name: 'Salt' }), [['GET', `/api/foods/${U}`], ['PUT', `/api/foods/${U}`]]],
    ['deleteFood', (v) => deleteFood(v), [['DELETE', `/api/foods/${U}`]]],
    ['getUnit', (v) => getUnit(v), [['GET', `/api/units/${U}`]]],
    ['updateUnit', (v) => updateUnit(v, { name: 'gram' }), [['GET', `/api/units/${U}`], ['PUT', `/api/units/${U}`]]],
    ['deleteUnit', (v) => deleteUnit(v), [['DELETE', `/api/units/${U}`]]],
    ['getMealplan', (v) => getMealplan(v), [['GET', `/api/households/mealplans/${U}`]]],
    ['updateMealplan', (v) => updateMealplan(v, {}), [['PUT', `/api/households/mealplans/${U}`]]],
    ['deleteMealplan', (v) => deleteMealplan(v), [['DELETE', `/api/households/mealplans/${U}`]]],
    ['getShoppingList', (v) => getShoppingList(v), [['GET', `/api/households/shopping/lists/${U}`]]],
    ['updateShoppingList', (v) => updateShoppingList(v, {}), [['PUT', `/api/households/shopping/lists/${U}`]]],
    ['deleteShoppingList', (v) => deleteShoppingList(v), [['DELETE', `/api/households/shopping/lists/${U}`]]],
    ['addRecipeToShoppingList (listId)', (v) => addRecipeToShoppingList(v, U), [['POST', `/api/households/shopping/lists/${U}/recipe/${U}`]]],
    ['addRecipeToShoppingList (recipeId)', (v) => addRecipeToShoppingList(U, v), [['POST', `/api/households/shopping/lists/${U}/recipe/${U}`]]],
    ['removeRecipeFromShoppingList (listId)', (v) => removeRecipeFromShoppingList(v, U), [['POST', `/api/households/shopping/lists/${U}/recipe/${U}/delete`]]],
    ['removeRecipeFromShoppingList (recipeId)', (v) => removeRecipeFromShoppingList(U, v), [['POST', `/api/households/shopping/lists/${U}/recipe/${U}/delete`]]],
    ['updateShoppingListItem', (v) => updateShoppingListItem(v, {}), [['PUT', `/api/households/shopping/items/${U}`]]],
    ['deleteShoppingListItem', (v) => deleteShoppingListItem(v), [['DELETE', `/api/households/shopping/items/${U}`]]],
    ['updateUserRating (userId)', (v) => updateUserRating(v, U, { rating: 4 }), [['POST', `/api/users/${U}/ratings/${U}`]]],
    ['updateUserRating (slug)', (v) => updateUserRating(U, v, { rating: 4 }), [['POST', `/api/users/${U}/ratings/${U}`]]],
    ['getSelfRating', (v) => getSelfRating(v), [['GET', `/api/users/self/ratings/${U}`]]],
  ];

  it.each(routes)('%s sends a valid value unchanged', async (_name, call, expected) => {
    await call(U);
    const sent = fetchMock.mock.calls.map((c) => [(c[1] as RequestInit).method ?? 'GET', c[0] as string]);
    expect(sent).toEqual(expected.map(([method, path]) => [method, `http://mealie.test${path}`]));
  });

  it.each(routes)('%s rejects traversal values before fetch', async (_name, call) => {
    for (const v of ['../x', 'a\\b', '..']) {
      await expect(async () => call(v)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

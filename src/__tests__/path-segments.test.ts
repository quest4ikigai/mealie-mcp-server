import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({ config: { baseUrl: 'http://mealie.test', apiKey: 'k' } }));

import { encodePathSegment } from '../api/client.js';
import { deleteTool } from '../api/tools.js';
import { getRecipe } from '../api/recipes.js';
import { getFood } from '../api/foods.js';
import { getUnit } from '../api/units.js';
import { deleteCategory } from '../api/categories.js';
import { deleteTag } from '../api/tags.js';
import { deleteMealplan } from '../api/mealplans.js';
import { deleteShoppingListItem } from '../api/shopping-lists.js';

const payloads = [
  '../../recipes/pancakes',
  '../bar',
  'foo/bar',
  'foo\\bar',
  '%2e%2e/%2e%2e/recipes/pancakes',
  '?x=y',
  '#fragment',
  'name with spaces',
  'unicode-✓',
];

describe('encodePathSegment', () => {
  it.each(payloads)('encodes %s as a single segment', (p) => {
    const out = encodePathSegment(p);
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
    expect(out).not.toMatch(/[?#\s]/);
    expect(decodeURIComponent(out)).toBe(p);
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

  it.each(['.', '..', '', '  '])('blank/dot segment %j fails before fetch', async (v) => {
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

  it('recipe traversal payload cannot reach another route', async () => {
    await getRecipe('../../organizers/tools/x');
    expect(calledUrl()).toBe('http://mealie.test/api/recipes/..%2F..%2Forganizers%2Ftools%2Fx');
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

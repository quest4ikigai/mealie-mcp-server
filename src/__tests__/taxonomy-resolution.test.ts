import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/categories.js', () => ({
  getCategories: vi.fn(),
}));

vi.mock('../api/tags.js', () => ({
  getTags: vi.fn(),
}));

import * as categoriesApi from '../api/categories.js';
import * as tagsApi from '../api/tags.js';
import {
  resolveTaxonomyValues,
  resolveTaxonomyFilter,
  UnresolvedTaxonomyFilterError,
} from '../lib/taxonomy-resolution.js';

function paginated<T>(items: T[]): { items: T[]; total: number; page: number; size: number } {
  return { items, total: items.length, page: 1, size: items.length };
}

const DINNER = { id: 'cat-1', name: 'Dinner', slug: 'dinner' };
const DESSERT = { id: 'cat-2', name: 'Dessert', slug: 'dessert' };
const DAIRY_FREE = { id: 'tag-1', name: 'Dairy-Free', slug: 'dairy-free' };
const QUICK = { id: 'tag-2', name: 'Quick', slug: 'quick' };

const mockGetCategories = vi.mocked(categoriesApi.getCategories);
const mockGetTags = vi.mocked(tagsApi.getTags);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCategories.mockResolvedValue(paginated([DINNER, DESSERT]));
  mockGetTags.mockResolvedValue(paginated([DAIRY_FREE, QUICK]));
});

describe('resolveTaxonomyValues', () => {
  it('resolves a category by exact slug', async () => {
    const { resolved, unresolved } = await resolveTaxonomyValues('category', ['dinner']);
    expect(resolved).toEqual([DINNER]);
    expect(unresolved).toEqual([]);
  });

  it('resolves a category by exact display name', async () => {
    const { resolved } = await resolveTaxonomyValues('category', ['Dinner']);
    expect(resolved).toEqual([DINNER]);
  });

  it('resolves a category by case-insensitive name', async () => {
    const { resolved } = await resolveTaxonomyValues('category', ['DINNER']);
    expect(resolved).toEqual([DINNER]);
  });

  it('resolves a category by case-insensitive slug, distinct from its display name', async () => {
    // Mealie slugifies names, so a name with punctuation/casing can differ from its slug
    // (e.g. "Quick & Easy" -> "quick-easy") — exercise that path specifically, not name matching.
    const QUICK_EASY = { id: 'cat-3', name: 'Quick & Easy', slug: 'quick-easy' };
    mockGetCategories.mockResolvedValue(paginated([DINNER, DESSERT, QUICK_EASY]));

    const { resolved } = await resolveTaxonomyValues('category', ['QUICK-EASY']);
    expect(resolved).toEqual([QUICK_EASY]);
  });

  it('resolves a category by ID', async () => {
    const { resolved } = await resolveTaxonomyValues('category', ['cat-1']);
    expect(resolved).toEqual([DINNER]);
  });

  it('reports an unknown category as unresolved rather than guessing', async () => {
    const { resolved, unresolved } = await resolveTaxonomyValues('category', ['Brunch']);
    expect(resolved).toEqual([]);
    expect(unresolved).toEqual(['Brunch']);
  });

  it('resolves a tag by exact slug', async () => {
    const { resolved } = await resolveTaxonomyValues('tag', ['dairy-free']);
    expect(resolved).toEqual([DAIRY_FREE]);
  });

  it('resolves a tag by exact display name', async () => {
    const { resolved } = await resolveTaxonomyValues('tag', ['Dairy-Free']);
    expect(resolved).toEqual([DAIRY_FREE]);
  });

  it('resolves a tag by case-insensitive name', async () => {
    const { resolved } = await resolveTaxonomyValues('tag', ['DAIRY-FREE']);
    expect(resolved).toEqual([DAIRY_FREE]);
  });

  it('resolves a tag by ID', async () => {
    const { resolved } = await resolveTaxonomyValues('tag', ['tag-1']);
    expect(resolved).toEqual([DAIRY_FREE]);
  });

  it('reports an unknown tag as unresolved rather than guessing', async () => {
    const { resolved, unresolved } = await resolveTaxonomyValues('tag', ['Spicy']);
    expect(resolved).toEqual([]);
    expect(unresolved).toEqual(['Spicy']);
  });

  it('resolves multiple category filters at once', async () => {
    const { resolved, unresolved } = await resolveTaxonomyValues('category', ['Dinner', 'dessert']);
    expect(resolved.map((c) => c.id).sort()).toEqual(['cat-1', 'cat-2']);
    expect(unresolved).toEqual([]);
  });

  it('resolves multiple tag filters at once', async () => {
    const { resolved, unresolved } = await resolveTaxonomyValues('tag', ['Dairy-Free', 'QUICK']);
    expect(resolved.map((t) => t.id).sort()).toEqual(['tag-1', 'tag-2']);
    expect(unresolved).toEqual([]);
  });

  it('resolves some and reports others as unresolved in a mixed list', async () => {
    const { resolved, unresolved } = await resolveTaxonomyValues('category', ['Dinner', 'Brunch']);
    expect(resolved).toEqual([DINNER]);
    expect(unresolved).toEqual(['Brunch']);
  });
});

describe('resolveTaxonomyFilter', () => {
  it('returns canonical IDs instead of the requested names', async () => {
    const result = await resolveTaxonomyFilter('category', ['Dinner']);
    expect(result).toEqual(['cat-1']);
  });

  it('resolves multiple values to their IDs, order-independent of input casing', async () => {
    const result = await resolveTaxonomyFilter('tag', ['QUICK', 'Dairy-Free']);
    expect(result?.sort()).toEqual(['tag-1', 'tag-2']);
  });

  it('throws UnresolvedTaxonomyFilterError instead of silently forwarding an unknown category', async () => {
    await expect(resolveTaxonomyFilter('category', ['Dinnner'])).rejects.toThrow(UnresolvedTaxonomyFilterError);
    await expect(resolveTaxonomyFilter('category', ['Dinnner'])).rejects.toThrow(/Dinnner/);
  });

  it('throws UnresolvedTaxonomyFilterError instead of silently forwarding an unknown tag', async () => {
    await expect(resolveTaxonomyFilter('tag', ['Spicy'])).rejects.toThrow(UnresolvedTaxonomyFilterError);
  });

  it('does not call the API at all when no values are given', async () => {
    const result = await resolveTaxonomyFilter('category', undefined);
    expect(result).toBeUndefined();
    expect(mockGetCategories).not.toHaveBeenCalled();
  });

  it('does not call the API at all for an empty array', async () => {
    const result = await resolveTaxonomyFilter('category', []);
    expect(result).toEqual([]);
    expect(mockGetCategories).not.toHaveBeenCalled();
  });

  it('never fetches the full recipe library — only categories/tags themselves', async () => {
    await resolveTaxonomyFilter('category', ['Dinner']);
    expect(mockGetCategories).toHaveBeenCalledTimes(1);
    expect(mockGetTags).not.toHaveBeenCalled();
  });
});

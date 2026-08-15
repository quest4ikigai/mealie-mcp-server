import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/recipes.js', () => ({
  getRecipe: vi.fn(),
  patchRecipe: vi.fn(),
}));

vi.mock('../api/categories.js', () => ({
  getCategories: vi.fn(),
  createCategory: vi.fn(),
}));

vi.mock('../api/tags.js', () => ({
  getTags: vi.fn(),
  createTag: vi.fn(),
}));

import * as recipesApi from '../api/recipes.js';
import * as categoriesApi from '../api/categories.js';
import * as tagsApi from '../api/tags.js';
import {
  buildTaxonomyPatch,
  updateRecipeTaxonomy,
  updateRecipeTaxonomyBatch,
  MissingTaxonomyItemsError,
} from '../lib/recipe-taxonomy.js';

const DINNER = { id: 'cat-1', name: 'Dinner', slug: 'dinner', groupId: 'group-1' };
const DESSERT = { id: 'cat-2', name: 'Dessert', slug: 'dessert', groupId: 'group-1' };
const QUICK = { id: 'tag-1', name: 'Quick', slug: 'quick', groupId: 'group-1' };
const DAIRY_FREE = { id: 'tag-2', name: 'Dairy-Free', slug: 'dairy-free', groupId: 'group-1' };

function baseRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'recipe-id-1',
    slug: 'chicken-shawarma',
    name: 'Chicken Shawarma',
    description: 'A tasty dish',
    recipeYield: '4 servings',
    recipeServings: 4,
    totalTime: '30 minutes',
    prepTime: '10 minutes',
    cookTime: '20 minutes',
    recipeIngredient: [{ note: '1 lb chicken' }, { note: '2 tbsp yogurt' }],
    recipeInstructions: [{ text: 'Marinate the chicken' }, { text: 'Grill until done' }],
    nutrition: { calories: '450' },
    settings: { public: true, disableComments: false },
    image: 'chicken-shawarma.jpg',
    notes: [{ title: 'Tip', text: 'Use fresh garlic' }],
    tools: [{ id: 'tool-1', name: 'Grill', slug: 'grill' }],
    rating: 4.5,
    assets: [{ name: 'photo.jpg' }],
    orgURL: 'https://example.com/original',
    recipeCategory: [DINNER],
    tags: [QUICK],
    ...overrides,
  };
}

function paginated<T>(items: T[]): { items: T[]; total: number; page: number; size: number } {
  return { items, total: items.length, page: 1, size: items.length };
}

const mockGetRecipe = vi.mocked(recipesApi.getRecipe);
const mockPatchRecipe = vi.mocked(recipesApi.patchRecipe);
const mockGetCategories = vi.mocked(categoriesApi.getCategories);
const mockCreateCategory = vi.mocked(categoriesApi.createCategory);
const mockGetTags = vi.mocked(tagsApi.getTags);
const mockCreateTag = vi.mocked(tagsApi.createTag);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRecipe.mockResolvedValue(baseRecipe());
  mockPatchRecipe.mockImplementation((slug, data) => Promise.resolve({ ...baseRecipe(), ...data }));
  mockGetCategories.mockResolvedValue(paginated([DINNER, DESSERT]));
  mockGetTags.mockResolvedValue(paginated([QUICK, DAIRY_FREE]));
});

describe('updateRecipeTaxonomy', () => {
  it('adds a category while preserving existing categories and tags', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', { categories: ['Dessert'] });

    expect(result.categories?.final.map((c) => c.name).sort()).toEqual(['Dessert', 'Dinner']);
    expect(result.categories?.added.map((c) => c.name)).toEqual(['Dessert']);
    expect(result.categories?.removed).toEqual([]);
    expect(result.tags).toBeUndefined();

    const [, patchData] = mockPatchRecipe.mock.calls[0];
    expect(patchData).toHaveProperty('recipeCategory');
    expect(patchData).not.toHaveProperty('tags');
    expect((patchData.recipeCategory as unknown[]).map((c) => (c as { name: string }).name).sort()).toEqual([
      'Dessert',
      'Dinner',
    ]);
  });

  it('adds a tag while preserving existing categories and tags', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', { tags: ['Dairy-Free'] });

    expect(result.tags?.final.map((t) => t.name).sort()).toEqual(['Dairy-Free', 'Quick']);
    expect(result.tags?.added.map((t) => t.name)).toEqual(['Dairy-Free']);
    expect(result.categories).toBeUndefined();

    const [, patchData] = mockPatchRecipe.mock.calls[0];
    expect(patchData).toHaveProperty('tags');
    expect(patchData).not.toHaveProperty('recipeCategory');
  });

  it('replaces categories, dropping ones not in the new list', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', {
      categories: ['Dessert'],
      mode: 'replace',
    });

    expect(result.categories?.final.map((c) => c.name)).toEqual(['Dessert']);
    expect(result.categories?.added.map((c) => c.name)).toEqual(['Dessert']);
    expect(result.categories?.removed.map((c) => c.name)).toEqual(['Dinner']);
  });

  it('replaces tags, dropping ones not in the new list', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', {
      tags: ['Dairy-Free'],
      mode: 'replace',
    });

    expect(result.tags?.final.map((t) => t.name)).toEqual(['Dairy-Free']);
    expect(result.tags?.removed.map((t) => t.name)).toEqual(['Quick']);
  });

  it('clears a collection when an explicit empty array is supplied in replace mode', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', { categories: [], mode: 'replace' });

    expect(result.categories?.final).toEqual([]);
    expect(result.categories?.removed.map((c) => c.name)).toEqual(['Dinner']);

    const [, patchData] = mockPatchRecipe.mock.calls[0];
    expect(patchData.recipeCategory).toEqual([]);
  });

  it('leaves a collection unchanged when omitted', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', { tags: ['Dairy-Free'] });

    expect(result.categories).toBeUndefined();
    const [, patchData] = mockPatchRecipe.mock.calls[0];
    expect(patchData).not.toHaveProperty('recipeCategory');
  });

  it('resolves categories by id, slug, and name', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', {
      categories: ['cat-2', 'dinner'],
      mode: 'replace',
    });

    expect(result.categories?.final.map((c) => c.id).sort()).toEqual(['cat-1', 'cat-2']);
    expect(mockCreateCategory).not.toHaveBeenCalled();
  });

  it('matches names and slugs case-insensitively', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', {
      categories: ['DINNER', 'DeSSert'],
      mode: 'replace',
    });

    expect(result.categories?.final.map((c) => c.name).sort()).toEqual(['Dessert', 'Dinner']);
    expect(mockCreateCategory).not.toHaveBeenCalled();
  });

  it('deduplicates repeated requested values that resolve to the same item', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', {
      categories: ['Dinner', 'dinner', 'DINNER', 'cat-1'],
      mode: 'replace',
    });

    expect(result.categories?.final).toHaveLength(1);
    expect(result.categories?.final[0].name).toBe('Dinner');
  });

  it('errors clearly when a value does not exist and createMissing is false', async () => {
    await expect(updateRecipeTaxonomy('chicken-shawarma', { categories: ['Brunch'] })).rejects.toThrow(
      MissingTaxonomyItemsError,
    );
    await expect(updateRecipeTaxonomy('chicken-shawarma', { categories: ['Brunch'] })).rejects.toThrow(/Brunch/);
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });

  it('creates missing categories/tags when createMissing is true', async () => {
    mockCreateCategory.mockResolvedValue({ id: 'cat-3', name: 'Brunch', slug: 'brunch' });

    const result = await updateRecipeTaxonomy('chicken-shawarma', {
      categories: ['Brunch'],
      createMissing: true,
    });

    expect(mockCreateCategory).toHaveBeenCalledWith('Brunch');
    expect(result.categories?.created.map((c) => c.name)).toEqual(['Brunch']);
    expect(result.categories?.final.map((c) => c.name).sort()).toEqual(['Brunch', 'Dinner']);
  });

  it('creates missing tags when createMissing is true and deduplicates repeated creation requests', async () => {
    mockCreateTag.mockResolvedValue({ id: 'tag-3', name: 'Spicy', slug: 'spicy' });

    const result = await updateRecipeTaxonomy('chicken-shawarma', {
      tags: ['Spicy', 'spicy'],
      createMissing: true,
    });

    expect(mockCreateTag).toHaveBeenCalledTimes(1);
    expect(mockCreateTag).toHaveBeenCalledWith('Spicy');
    expect(result.tags?.created.map((t) => t.name)).toEqual(['Spicy']);
    expect(result.tags?.final.map((t) => t.name).sort()).toEqual(['Quick', 'Spicy']);
  });

  it('preserves all unrelated recipe fields, only patching category/tag collections', async () => {
    await updateRecipeTaxonomy('chicken-shawarma', { categories: ['Dessert'] });

    const [slug, patchData] = mockPatchRecipe.mock.calls[0];
    expect(slug).toBe('chicken-shawarma');
    expect(Object.keys(patchData)).toEqual(['recipeCategory']);
    expect(patchData).not.toHaveProperty('recipeIngredient');
    expect(patchData).not.toHaveProperty('recipeInstructions');
    expect(patchData).not.toHaveProperty('nutrition');
    expect(patchData).not.toHaveProperty('settings');
    expect(patchData).not.toHaveProperty('totalTime');
    expect(patchData).not.toHaveProperty('image');
    expect(patchData).not.toHaveProperty('notes');
    expect(patchData).not.toHaveProperty('tools');
    expect(patchData).not.toHaveProperty('rating');
  });

  it('does not call the API at all when both categories and tags are omitted', async () => {
    const result = await updateRecipeTaxonomy('chicken-shawarma', {});

    expect(result.categories).toBeUndefined();
    expect(result.tags).toBeUndefined();
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });
});

describe('buildTaxonomyPatch', () => {
  it('operates on an already-fetched recipe without refetching', async () => {
    const recipe = baseRecipe();
    await buildTaxonomyPatch(recipe, { tags: ['Dairy-Free'] });

    expect(mockGetRecipe).not.toHaveBeenCalled();
  });
});

describe('updateRecipeTaxonomyBatch', () => {
  it('reports partial failures without aborting the rest of the batch', async () => {
    mockGetRecipe.mockImplementation((slug: string) => {
      if (slug === 'broken-recipe') {
        return Promise.reject(new Error('Mealie API error 404: Not Found'));
      }
      return Promise.resolve(baseRecipe({ slug }));
    });

    const results = await updateRecipeTaxonomyBatch([
      { slug: 'chicken-shawarma', categories: ['Dessert'] },
      { slug: 'broken-recipe', categories: ['Dessert'] },
      { slug: 'another-recipe', tags: ['Dairy-Free'] },
    ]);

    const bySlug = new Map(results.map((r) => [r.slug, r]));

    expect(bySlug.get('chicken-shawarma')?.success).toBe(true);
    expect(bySlug.get('another-recipe')?.success).toBe(true);

    const failed = bySlug.get('broken-recipe');
    expect(failed?.success).toBe(false);
    if (failed && !failed.success) {
      expect(failed.error).toMatch(/Not Found/);
    }
  });

  it('bounds concurrency instead of firing all requests at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    mockGetRecipe.mockImplementation((slug: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight--;
          resolve(baseRecipe({ slug }));
        }, 5);
      });
    });

    const updates = Array.from({ length: 12 }, (_, i) => ({ slug: `recipe-${i}`, tags: ['Quick'] }));
    await updateRecipeTaxonomyBatch(updates);

    expect(maxInFlight).toBeLessThanOrEqual(5);
  });
});

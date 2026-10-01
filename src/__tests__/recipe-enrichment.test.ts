import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/recipes.js', () => ({ getRecipes: vi.fn(), getRecipe: vi.fn() }));

import * as recipesApi from '../api/recipes.js';
import {
  getRecipesForDataEnrichment,
  isDimensionFlagged,
  InvalidDimensionsError,
  InvalidLimitError,
} from '../lib/recipe-enrichment.js';
import { auditRecipe } from '../lib/recipe-audit.js';

const mockGetRecipes = vi.mocked(recipesApi.getRecipes);
const mockGetRecipe = vi.mocked(recipesApi.getRecipe);

const complete = {
  id: 'c', slug: 'complete', name: 'Complete', image: 'abc',
  recipeCategory: [{ id: '1', name: 'Dinner', slug: 'dinner' }],
  tags: [{ id: '2', name: 'Quick', slug: 'quick' }],
  tools: [{ id: '3', name: 'Whisk', slug: 'whisk' }],
  recipeIngredient: [
    { title: 'Sauce', referenceId: 'r0' },
    { referenceId: 'r1', quantity: 1, unit: { id: 'u', name: 'cup' }, food: { id: 'f', name: 'flour' } },
  ],
  recipeInstructions: [{ text: 'mix', ingredientReferences: [{ referenceId: 'r1' }] }],
};
const bare = {
  id: 'b', slug: 'bare', name: 'Bare', image: '',
  recipeCategory: [], tags: [], tools: [],
  recipeIngredient: [{ referenceId: 'r1', note: '1 cup flour', food: null }],
  recipeInstructions: [{ text: 'mix', ingredientReferences: [] }],
};

function listItem(r: { id: string; slug: string }, n: number) {
  return { id: r.id, slug: r.slug, createdAt: `2024-01-0${n}T00:00:00Z` };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRecipes.mockResolvedValue({
    items: [listItem(complete, 1), listItem(bare, 2), { id: 'x', slug: 'broken', createdAt: '2024-01-03T00:00:00Z' }],
    total_pages: 1,
  } as never);
  mockGetRecipe.mockImplementation((slug: string) => {
    if (slug === 'complete') return Promise.resolve(complete);
    if (slug === 'bare') return Promise.resolve(bare);
    return Promise.reject(new Error('boom'));
  });
});

describe('isDimensionFlagged', () => {
  it('flags nothing on a complete recipe', () => {
    const audit = auditRecipe(complete);
    for (const d of ['ingredient_parsing', 'ingredient_sections', 'instruction_ingredient_links', 'tools', 'taxonomy', 'image'] as const) {
      expect(isDimensionFlagged(audit, d)).toBe(false);
    }
  });

  it('flags every dimension on a bare recipe', () => {
    const audit = auditRecipe(bare);
    for (const d of ['ingredient_parsing', 'ingredient_sections', 'instruction_ingredient_links', 'tools', 'taxonomy', 'image'] as const) {
      expect(isDimensionFlagged(audit, d)).toBe(true);
    }
  });

  it('flags dangling instruction references', () => {
    const audit = auditRecipe({ ...complete, recipeInstructions: [{ ingredientReferences: [{ referenceId: 'nope' }] }] });
    expect(isDimensionFlagged(audit, 'instruction_ingredient_links')).toBe(true);
  });

  it('does not flag sections or links when there is nothing to section or link', () => {
    const audit = auditRecipe({ ...complete, recipeIngredient: [], recipeInstructions: [] });
    expect(isDimensionFlagged(audit, 'ingredient_sections')).toBe(false);
    expect(isDimensionFlagged(audit, 'instruction_ingredient_links')).toBe(false);
  });
});

describe('getRecipesForDataEnrichment', () => {
  it('returns only flagged recipes and isolates per-recipe failures', async () => {
    const page = await getRecipesForDataEnrichment({});
    expect(page.items.map((i) => i.slug)).toEqual(['bare']);
    expect(page.items[0].flaggedDimensions).toHaveLength(6);
    expect(page.items[0].audit.toolCount).toBe(0);
    expect(page.failures).toEqual([expect.objectContaining({ slug: 'broken', error: 'boom' })]);
    expect(page.scannedCount).toBe(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('filters by selected dimensions', async () => {
    mockGetRecipe.mockImplementation((slug: string) =>
      Promise.resolve(slug === 'bare' ? { ...bare, image: 'x' } : slug === 'complete' ? complete : { ...complete, id: 'x' }));
    const page = await getRecipesForDataEnrichment({ dimensions: ['image'] });
    expect(page.items).toEqual([]);
  });

  it('returns every recipe with onlyFlagged=false', async () => {
    const page = await getRecipesForDataEnrichment({ onlyFlagged: false });
    expect(page.items.map((i) => i.slug)).toEqual(['complete', 'bare']);
    expect(page.items[0].flaggedDimensions).toEqual([]);
  });

  it('paginates with a cursor when the limit is reached', async () => {
    const page = await getRecipesForDataEnrichment({ limit: 1, onlyFlagged: false });
    expect(page.returnedCount).toBe(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('validates limit and dimensions', async () => {
    await expect(getRecipesForDataEnrichment({ limit: 0 })).rejects.toBeInstanceOf(InvalidLimitError);
    await expect(getRecipesForDataEnrichment({ dimensions: [] })).rejects.toBeInstanceOf(InvalidDimensionsError);
    await expect(getRecipesForDataEnrichment({ dimensions: ['bogus' as never] })).rejects.toBeInstanceOf(InvalidDimensionsError);
  });
});

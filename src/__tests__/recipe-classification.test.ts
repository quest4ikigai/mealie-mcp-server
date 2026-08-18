import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/recipes.js', () => ({
  getRecipes: vi.fn(),
  getRecipe: vi.fn(),
  getRecipesBatch: vi.fn(),
  createRecipe: vi.fn(),
  patchRecipe: vi.fn(),
  duplicateRecipe: vi.fn(),
  updateRecipeLastMade: vi.fn(),
  setRecipeImageFromUrl: vi.fn(),
  deleteRecipe: vi.fn(),
  updateRecipe: vi.fn(),
}));

import * as recipesApi from '../api/recipes.js';
import {
  getRecipesForClassification,
  InvalidLimitError,
  InvalidCursorError,
  CLASSIFICATION_DEFAULT_LIMIT,
  CLASSIFICATION_MAX_LIMIT,
} from '../lib/recipe-classification.js';

const mockGetRecipes = vi.mocked(recipesApi.getRecipes);
const mockGetRecipe = vi.mocked(recipesApi.getRecipe);
const mockPatchRecipe = vi.mocked(recipesApi.patchRecipe);
const mockUpdateRecipe = vi.mocked(recipesApi.updateRecipe);
const mockCreateRecipe = vi.mocked(recipesApi.createRecipe);
const mockDeleteRecipe = vi.mocked(recipesApi.deleteRecipe);

interface Named {
  id: string;
  name: string;
  slug: string;
}

const CAT_DINNER: Named = { id: 'cat-dinner', name: 'Dinner', slug: 'dinner' };
const TAG_QUICK: Named = { id: 'tag-quick', name: 'Quick', slug: 'quick' };

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'id-default',
    slug: 'slug-default',
    name: 'Recipe',
    createdAt: '2024-01-01T00:00:00.000000',
    recipeCategory: [],
    tags: [],
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'id-default',
    slug: 'slug-default',
    name: 'Recipe',
    description: 'A tasty recipe',
    totalTime: '30 minutes',
    prepTime: '10 minutes',
    cookTime: '20 minutes',
    recipeServings: 4,
    recipeYieldQuantity: 4,
    recipeYield: '4 servings',
    orgURL: 'https://example.com/original',
    recipeIngredient: [
      { referenceId: 'ref-1', display: '2 cups flour', note: '', quantity: 2, unit: { id: 'u-1', name: 'cup' }, food: { id: 'f-1', name: 'flour' } },
    ],
    recipeInstructions: [{ id: 'instr-1', title: '', text: 'Mix well', ingredientReferences: [], summary: '' }],
    recipeCategory: [],
    tags: [],
    nutrition: { calories: '200' },
    settings: { public: true, disableComments: false },
    assets: [{ name: 'photo.jpg' }],
    image: 'recipe.jpg',
    notes: [],
    comments: [{ id: 'c-1', text: 'nice' }],
    userId: 'user-1',
    groupId: 'group-1',
    householdId: 'household-1',
    rating: 4.2,
    tools: [],
    lastMade: null,
    ...overrides,
  };
}

/** Wires getRecipes/getRecipe mocks against an in-memory dataset, mimicking Mealie's real
 * page/perPage pagination semantics so the scan logic under test drives real pagination math. */
function setupServer(items: Record<string, unknown>[], detailsBySlug: Record<string, Record<string, unknown>>) {
  mockGetRecipes.mockImplementation((params) => {
    const page = params?.page ?? 1;
    const perPage = params?.perPage ?? 50;
    const start = (page - 1) * perPage;
    const pageItems = items.slice(start, start + perPage);
    return Promise.resolve({ items: pageItems, total: items.length, page, size: pageItems.length });
  });
  mockGetRecipe.mockImplementation((slug: string) => {
    const found = detailsBySlug[slug];
    if (!found) return Promise.reject(new Error(`Recipe not found: ${slug}`));
    return Promise.resolve(found);
  });
}

function recipe(i: number, overrides: { categories?: Named[]; tags?: Named[] } = {}) {
  const id = `id-${i}`;
  const slug = `recipe-${i}`;
  const createdAt = `2024-01-01T00:00:${String(i).padStart(2, '0')}.000000`;
  const categories = overrides.categories ?? [];
  const tags = overrides.tags ?? [];
  return {
    summary: summary({ id, slug, name: `Recipe ${i}`, createdAt, recipeCategory: categories, tags }),
    detail: detail({ id, slug, name: `Recipe ${i}`, recipeCategory: categories, tags }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('taxonomyState filtering', () => {
  it('defaults to missing_either', async () => {
    const r1 = recipe(1); // missing both -> matches
    const r2 = recipe(2, { categories: [CAT_DINNER], tags: [TAG_QUICK] }); // has both -> no match
    const r3 = recipe(3, { categories: [CAT_DINNER] }); // missing tags -> matches
    setupServer(
      [r1.summary, r2.summary, r3.summary],
      { [r1.detail.slug as string]: r1.detail, [r2.detail.slug as string]: r2.detail, [r3.detail.slug as string]: r3.detail },
    );

    const result = await getRecipesForClassification({});

    expect(result.items.map((i) => i.slug)).toEqual(['recipe-1', 'recipe-3']);
  });

  it('missing_both only returns recipes with no categories and no tags', async () => {
    const r1 = recipe(1); // missing both
    const r2 = recipe(2, { categories: [CAT_DINNER] }); // missing only tags
    const r3 = recipe(3, { tags: [TAG_QUICK] }); // missing only categories
    setupServer(
      [r1.summary, r2.summary, r3.summary],
      { [r1.detail.slug as string]: r1.detail, [r2.detail.slug as string]: r2.detail, [r3.detail.slug as string]: r3.detail },
    );

    const result = await getRecipesForClassification({ taxonomyState: 'missing_both' });

    expect(result.items.map((i) => i.slug)).toEqual(['recipe-1']);
  });

  it('missing_categories returns recipes with an empty category list regardless of tags', async () => {
    const r1 = recipe(1, { tags: [TAG_QUICK] }); // has tags but no categories -> matches
    const r2 = recipe(2, { categories: [CAT_DINNER], tags: [TAG_QUICK] }); // fully classified -> no match
    setupServer([r1.summary, r2.summary], { [r1.detail.slug as string]: r1.detail, [r2.detail.slug as string]: r2.detail });

    const result = await getRecipesForClassification({ taxonomyState: 'missing_categories' });

    expect(result.items.map((i) => i.slug)).toEqual(['recipe-1']);
  });

  it('missing_tags returns recipes with an empty tag list regardless of categories', async () => {
    const r1 = recipe(1, { categories: [CAT_DINNER] }); // has categories but no tags -> matches
    const r2 = recipe(2, { categories: [CAT_DINNER], tags: [TAG_QUICK] }); // fully classified -> no match
    setupServer([r1.summary, r2.summary], { [r1.detail.slug as string]: r1.detail, [r2.detail.slug as string]: r2.detail });

    const result = await getRecipesForClassification({ taxonomyState: 'missing_tags' });

    expect(result.items.map((i) => i.slug)).toEqual(['recipe-1']);
  });

  it('any returns every recipe regardless of taxonomy state', async () => {
    const r1 = recipe(1);
    const r2 = recipe(2, { categories: [CAT_DINNER], tags: [TAG_QUICK] });
    setupServer([r1.summary, r2.summary], { [r1.detail.slug as string]: r1.detail, [r2.detail.slug as string]: r2.detail });

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(result.items.map((i) => i.slug)).toEqual(['recipe-1', 'recipe-2']);
  });

  it('a recipe with categories but no tags is included under missing_either', async () => {
    const r1 = recipe(1, { categories: [CAT_DINNER] });
    setupServer([r1.summary], { [r1.detail.slug as string]: r1.detail });

    const result = await getRecipesForClassification({});

    expect(result.items).toHaveLength(1);
  });

  it('a recipe with tags but no categories is included under missing_either', async () => {
    const r1 = recipe(1, { tags: [TAG_QUICK] });
    setupServer([r1.summary], { [r1.detail.slug as string]: r1.detail });

    const result = await getRecipesForClassification({});

    expect(result.items).toHaveLength(1);
  });
});

describe('compact output', () => {
  it('includes existing categories and tags so a client can preserve them', async () => {
    const r1 = recipe(1, { categories: [CAT_DINNER], tags: [] });
    setupServer([r1.summary], { [r1.detail.slug as string]: r1.detail });

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(result.items[0].categories).toEqual([{ id: 'cat-dinner', name: 'Dinner', slug: 'dinner' }]);
    expect(result.items[0].tags).toEqual([]);
  });

  it('prefers the formatted display text for ingredients', async () => {
    const r1 = recipe(1);
    r1.detail.recipeIngredient = [
      { referenceId: 'ref-1', display: '2 cups all-purpose flour', note: 'sifted', quantity: 2, unit: { name: 'cup' }, food: { name: 'flour' } },
    ];
    setupServer([r1.summary], { [r1.detail.slug as string]: r1.detail });

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(result.items[0].ingredients).toEqual(['2 cups all-purpose flour']);
  });

  it('falls back through note, then reconstructed quantity/unit/food, then original text', async () => {
    const r1 = recipe(1);
    r1.detail.recipeIngredient = [
      { referenceId: 'a', note: '1 tsp fine sea salt' }, // no display -> falls back to note
      { referenceId: 'b', quantity: 3, unit: { name: 'tbsp' }, food: { name: 'sugar' } }, // no display/note -> reconstructed
      { referenceId: 'c', originalText: 'a pinch of love' }, // nothing else -> original text
      { referenceId: 'd', note: '', quantity: null, unit: null, food: null, originalText: '' }, // fully empty -> dropped
    ];
    setupServer([r1.summary], { [r1.detail.slug as string]: r1.detail });

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(result.items[0].ingredients).toEqual(['1 tsp fine sea salt', '3 tbsp sugar', 'a pinch of love']);
  });

  it('preserves instruction order and section headings, dropping ids and references', async () => {
    const r1 = recipe(1);
    r1.detail.recipeInstructions = [
      { id: 'i1', title: 'Prep', text: 'Chop the onions', ingredientReferences: [{ referenceId: 'ref-1' }], summary: 'chop' },
      { id: 'i2', title: '', text: 'Saute the onions', ingredientReferences: [] },
      { id: 'i3', title: 'Cook', text: 'Add the broth' },
      { id: 'i4', title: 'Cook', text: 'Simmer for 20 minutes' },
    ];
    setupServer([r1.summary], { [r1.detail.slug as string]: r1.detail });

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(result.items[0].instructions).toEqual([
      'Prep',
      'Chop the onions',
      'Saute the onions',
      'Cook',
      'Add the broth',
      'Simmer for 20 minutes',
    ]);
  });

  it('omits internal ids and null-heavy structures not needed for classification', async () => {
    const r1 = recipe(1);
    setupServer([r1.summary], { [r1.detail.slug as string]: r1.detail });

    const result = await getRecipesForClassification({ taxonomyState: 'any' });
    const serialized = JSON.stringify(result.items[0]);

    expect(result.items[0]).not.toHaveProperty('nutrition');
    expect(result.items[0]).not.toHaveProperty('settings');
    expect(result.items[0]).not.toHaveProperty('assets');
    expect(result.items[0]).not.toHaveProperty('image');
    expect(result.items[0]).not.toHaveProperty('comments');
    expect(result.items[0]).not.toHaveProperty('userId');
    expect(result.items[0]).not.toHaveProperty('groupId');
    expect(result.items[0]).not.toHaveProperty('householdId');
    expect(serialized).not.toContain('referenceId');
    expect(serialized).not.toContain('ingredientReferences');
    expect(serialized).not.toContain('"u-1"');
    expect(serialized).not.toContain('"f-1"');
  });
});

describe('limit validation', () => {
  it('defaults to CLASSIFICATION_DEFAULT_LIMIT', async () => {
    const items = Array.from({ length: 30 }, (_, i) => recipe(i));
    setupServer(
      items.map((r) => r.summary),
      Object.fromEntries(items.map((r) => [r.detail.slug as string, r.detail])),
    );

    const result = await getRecipesForClassification({});

    expect(result.items).toHaveLength(CLASSIFICATION_DEFAULT_LIMIT);
    expect(result.hasMore).toBe(true);
  });

  it('honors the maximum allowed limit', async () => {
    const items = Array.from({ length: 60 }, (_, i) => recipe(i));
    setupServer(
      items.map((r) => r.summary),
      Object.fromEntries(items.map((r) => [r.detail.slug as string, r.detail])),
    );

    const result = await getRecipesForClassification({ limit: CLASSIFICATION_MAX_LIMIT });

    expect(result.items).toHaveLength(CLASSIFICATION_MAX_LIMIT);
  });

  it('rejects a limit above the maximum', async () => {
    await expect(getRecipesForClassification({ limit: CLASSIFICATION_MAX_LIMIT + 1 })).rejects.toThrow(InvalidLimitError);
  });

  it('rejects a limit below 1', async () => {
    await expect(getRecipesForClassification({ limit: 0 })).rejects.toThrow(InvalidLimitError);
  });

  it('rejects a non-integer limit', async () => {
    await expect(getRecipesForClassification({ limit: 3.5 })).rejects.toThrow(InvalidLimitError);
  });
});

describe('pagination', () => {
  it('starts from the beginning of the collection when no cursor is given', async () => {
    const items = Array.from({ length: 3 }, (_, i) => recipe(i));
    setupServer(
      items.map((r) => r.summary),
      Object.fromEntries(items.map((r) => [r.detail.slug as string, r.detail])),
    );

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(mockGetRecipes).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
    expect(result.items.map((i) => i.slug)).toEqual(['recipe-0', 'recipe-1', 'recipe-2']);
  });

  it('continues from nextCursor without skipping or repeating recipes', async () => {
    const items = Array.from({ length: 5 }, (_, i) => recipe(i));
    setupServer(
      items.map((r) => r.summary),
      Object.fromEntries(items.map((r) => [r.detail.slug as string, r.detail])),
    );

    const page1 = await getRecipesForClassification({ taxonomyState: 'any', limit: 2 });
    expect(page1.items.map((i) => i.slug)).toEqual(['recipe-0', 'recipe-1']);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await getRecipesForClassification({ taxonomyState: 'any', limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.slug)).toEqual(['recipe-2', 'recipe-3']);
    expect(page2.hasMore).toBe(true);

    const page3 = await getRecipesForClassification({ taxonomyState: 'any', limit: 2, cursor: page2.nextCursor! });
    expect(page3.items.map((i) => i.slug)).toEqual(['recipe-4']);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor with a clear error', async () => {
    await expect(getRecipesForClassification({ cursor: 'not-valid!!' })).rejects.toThrow(InvalidCursorError);
    await expect(getRecipesForClassification({ cursor: Buffer.from('{"v":1}').toString('base64url') })).rejects.toThrow(
      InvalidCursorError,
    );
    await expect(
      getRecipesForClassification({ cursor: Buffer.from(JSON.stringify({ v: 2 })).toString('base64url') }),
    ).rejects.toThrow(InvalidCursorError);
  });

  it('advances the underlying page when the scan spans more than one Mealie page', async () => {
    // Page 1 (50 recipes): even indices are unclassified (match), odd indices are fully
    // classified (no match) -> only 25 matches available without leaving page 1.
    const pageOneItems = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0 ? recipe(i) : recipe(i, { categories: [CAT_DINNER], tags: [TAG_QUICK] }),
    );
    // Page 2 (5 recipes): all unclassified -> the remaining 5 matches needed.
    const pageTwoItems = Array.from({ length: 5 }, (_, i) => recipe(50 + i));
    const all = [...pageOneItems, ...pageTwoItems];
    setupServer(
      all.map((r) => r.summary),
      Object.fromEntries(all.map((r) => [r.detail.slug as string, r.detail])),
    );

    const result = await getRecipesForClassification({ limit: 30 });

    expect(result.items).toHaveLength(30);
    expect(result.items[29].slug).toBe('recipe-54');
    expect(mockGetRecipes).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
  });

  it('does not skip recipes when a scanned recipe changes taxonomy state between calls', async () => {
    // A, C, E currently lack taxonomy; B, D are already fully classified.
    const dataset = [
      recipe(1), // A - matches
      recipe(2, { categories: [CAT_DINNER], tags: [TAG_QUICK] }), // B - no match
      recipe(3), // C - matches (will gain taxonomy before the next call)
      recipe(4, { categories: [CAT_DINNER], tags: [TAG_QUICK] }), // D - no match
      recipe(5), // E - matches
    ];
    const detailsBySlug = Object.fromEntries(dataset.map((r) => [r.detail.slug as string, r.detail]));
    setupServer(
      dataset.map((r) => r.summary),
      detailsBySlug,
    );

    const page1 = await getRecipesForClassification({ limit: 2 });
    expect(page1.items.map((i) => i.slug)).toEqual(['recipe-1', 'recipe-3']);
    expect(page1.scannedCount).toBe(3); // A, B, C scanned; B filtered out
    expect(page1.hasMore).toBe(true);

    // Simulate recipe-3 (C) being classified by another client in between calls.
    dataset[2].summary.recipeCategory = [CAT_DINNER];
    dataset[2].summary.tags = [TAG_QUICK];

    const page2 = await getRecipesForClassification({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.slug)).toEqual(['recipe-5']);
    expect(page2.scannedCount).toBe(2); // D, E scanned; C is never re-visited or re-matched
    expect(page2.hasMore).toBe(false);

    // Across both calls every recipe was scanned exactly once: no skips, no duplicates.
    expect(page1.scannedCount + page2.scannedCount).toBe(dataset.length);
  });

  it('sorts deterministically by createdAt then id, independent of server-returned order', async () => {
    const rB = recipe(0); // createdAt ...00, id-0
    rB.summary.id = 'r-b';
    rB.summary.slug = 'recipe-b';
    rB.summary.createdAt = '2024-01-02T00:00:00.000000';
    rB.detail.id = 'r-b';
    rB.detail.slug = 'recipe-b';

    const rA = recipe(1);
    rA.summary.id = 'r-a';
    rA.summary.slug = 'recipe-a';
    rA.summary.createdAt = '2024-01-01T00:00:00.000000';
    rA.detail.id = 'r-a';
    rA.detail.slug = 'recipe-a';

    const rC1 = recipe(2);
    rC1.summary.id = 'r-c1';
    rC1.summary.slug = 'recipe-c1';
    rC1.summary.createdAt = '2024-01-01T00:00:00.000000'; // tie with rA
    rC1.detail.id = 'r-c1';
    rC1.detail.slug = 'recipe-c1';

    const rC2 = recipe(3);
    rC2.summary.id = 'r-c2';
    rC2.summary.slug = 'recipe-c2';
    rC2.summary.createdAt = '2024-01-01T00:00:00.000000'; // tie with rA and rC1
    rC2.detail.id = 'r-c2';
    rC2.detail.slug = 'recipe-c2';

    // Server returns them scrambled.
    const scrambled = [rB, rC2, rA, rC1];
    setupServer(
      scrambled.map((r) => r.summary),
      Object.fromEntries(scrambled.map((r) => [r.detail.slug as string, r.detail])),
    );

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(result.items.map((i) => i.id)).toEqual(['r-a', 'r-c1', 'r-c2', 'r-b']);
  });

  it('returns a partial page with a continuation cursor when the internal deadline is exceeded', async () => {
    const items = Array.from({ length: 5 }, (_, i) => recipe(i));
    setupServer(
      items.map((r) => r.summary),
      Object.fromEntries(items.map((r) => [r.detail.slug as string, r.detail])),
    );

    let counter = 0;
    const now = () => {
      counter += 1;
      return counter * 100;
    };

    const result = await getRecipesForClassification({ taxonomyState: 'any', limit: 10 }, { now, deadlineMs: 250 });

    expect(result.items.length).toBeLessThan(5);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeTruthy();
  });
});

describe('partial failures', () => {
  it('reports one failed detail fetch without dropping the successful ones', async () => {
    const items = Array.from({ length: 3 }, (_, i) => recipe(i));
    const detailsBySlug = Object.fromEntries(items.map((r) => [r.detail.slug as string, r.detail]));
    delete detailsBySlug['recipe-1'];
    setupServer(items.map((r) => r.summary), detailsBySlug);

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(result.items.map((i) => i.slug).sort()).toEqual(['recipe-0', 'recipe-2']);
    expect(result.failures).toEqual([{ slug: 'recipe-1', id: 'id-1', error: 'Recipe not found: recipe-1' }]);
    expect(result.returnedCount).toBe(2);
  });

  it('reports multiple failures without rejecting the whole call', async () => {
    const items = Array.from({ length: 4 }, (_, i) => recipe(i));
    const detailsBySlug = Object.fromEntries(items.map((r) => [r.detail.slug as string, r.detail]));
    delete detailsBySlug['recipe-0'];
    delete detailsBySlug['recipe-2'];
    setupServer(items.map((r) => r.summary), detailsBySlug);

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((f) => f.slug).sort()).toEqual(['recipe-0', 'recipe-2']);
    expect(result.items).toHaveLength(2);
  });
});

describe('concurrency', () => {
  it('bounds concurrent detail fetches instead of firing them all at once', async () => {
    const items = Array.from({ length: 8 }, (_, i) => recipe(i));
    setupServer(items.map((r) => r.summary), {});

    let inFlight = 0;
    let maxInFlight = 0;
    mockGetRecipe.mockImplementation(async (slug: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      const match = items.find((r) => r.detail.slug === slug);
      return match!.detail;
    });

    const result = await getRecipesForClassification({ taxonomyState: 'any' });

    expect(result.items).toHaveLength(8);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });
});

describe('read-only behavior', () => {
  it('never issues a write request against Mealie', async () => {
    const items = Array.from({ length: 3 }, (_, i) => recipe(i, { categories: [CAT_DINNER] }));
    setupServer(
      items.map((r) => r.summary),
      Object.fromEntries(items.map((r) => [r.detail.slug as string, r.detail])),
    );

    await getRecipesForClassification({ taxonomyState: 'any' });

    expect(mockPatchRecipe).not.toHaveBeenCalled();
    expect(mockUpdateRecipe).not.toHaveBeenCalled();
    expect(mockCreateRecipe).not.toHaveBeenCalled();
    expect(mockDeleteRecipe).not.toHaveBeenCalled();
  });
});

describe('regression: production timeout scenario', () => {
  it('returns 25 compact records with bounded concurrency and a payload far smaller than a detailed batch', async () => {
    const items = Array.from({ length: 25 }, (_, i) => recipe(i));
    setupServer(items.map((r) => r.summary), {});

    let inFlight = 0;
    let maxInFlight = 0;
    mockGetRecipe.mockImplementation(async (slug: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      const match = items.find((r) => r.detail.slug === slug);
      return match!.detail;
    });

    const result = await getRecipesForClassification({ taxonomyState: 'any', limit: 25 });

    expect(result.items).toHaveLength(25);
    expect(result.failures).toHaveLength(0);
    expect(maxInFlight).toBeLessThanOrEqual(4);

    const compactSize = JSON.stringify(result.items).length;
    const detailedBatchEquivalentSize = JSON.stringify(
      Object.fromEntries(items.map((r) => [r.detail.slug, r.detail])),
    ).length;
    expect(compactSize).toBeLessThan(detailedBatchEquivalentSize * 0.6);
  });
});

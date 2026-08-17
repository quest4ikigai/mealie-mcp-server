import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/foods.js', () => ({
  getFoods: vi.fn(),
}));

vi.mock('../api/recipes.js', () => ({
  getRecipeSuggestions: vi.fn(),
  searchRecipesByFilter: vi.fn(),
}));

import * as foodsApi from '../api/foods.js';
import * as recipesApi from '../api/recipes.js';
import { findRecipesForIngredients } from '../lib/find-recipes-for-ingredients.js';

function paginated<T>(items: T[]): { items: T[]; total: number; page: number; size: number } {
  return { items, total: items.length, page: 1, size: items.length };
}

function food(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'food-id', name: 'Salmon', pluralName: null, aliases: [], ...overrides };
}

function recipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'recipe-id',
    name: 'Whole Roasted Branzino',
    slug: 'whole-roasted-branzino',
    description: 'A simple roasted fish',
    recipeCategory: [{ name: 'Dinner', slug: 'dinner' }],
    tags: [{ name: 'Mediterranean', slug: 'mediterranean' }],
    totalTime: 'PT35M',
    ...overrides,
  };
}

function suggestionItem(
  recipeObj: Record<string, unknown>,
  missingFoods: Record<string, unknown>[] = [],
): { recipe: Record<string, unknown>; missingFoods: Record<string, unknown>[]; missingTools: Record<string, unknown>[] } {
  return { recipe: recipeObj, missingFoods, missingTools: [] };
}

const mockGetFoods = vi.mocked(foodsApi.getFoods);
const mockGetRecipeSuggestions = vi.mocked(recipesApi.getRecipeSuggestions);
const mockSearchRecipesByFilter = vi.mocked(recipesApi.searchRecipesByFilter);

beforeEach(() => {
  vi.clearAllMocks();
  // Safe default for tests that don't care about the zero-results text-search fallback.
  mockSearchRecipesByFilter.mockResolvedValue(paginated([]));
});

describe('ingredient resolution', () => {
  it('resolves an exact case-sensitive food-name match', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockResolvedValue({ items: [] });

    const result = await findRecipesForIngredients({ ingredients: ['Salmon'] });

    expect(result.resolvedIngredients).toEqual([
      { query: 'Salmon', foodId: 'salmon-id', foodName: 'Salmon', matchType: 'exact-name' },
    ]);
    expect(result.unresolvedIngredients).toEqual([]);
  });

  it('resolves a food name case-insensitively', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockResolvedValue({ items: [] });

    const result = await findRecipesForIngredients({ ingredients: ['SALMON'] });

    expect(result.resolvedIngredients[0]).toMatchObject({ foodId: 'salmon-id', matchType: 'exact-name' });
  });

  it('resolves via exact plural-name/alias match when the name itself does not match exactly (no slug field on Food)', async () => {
    mockGetFoods.mockResolvedValue(
      paginated([food({ id: 'salmon-id', name: 'Salmon', pluralName: 'Salmons', aliases: [{ name: 'Atlantic Salmon' }] })]),
    );
    mockGetRecipeSuggestions.mockResolvedValue({ items: [] });

    const result = await findRecipesForIngredients({ ingredients: ['salmons'] });

    expect(result.resolvedIngredients[0]).toMatchObject({
      foodId: 'salmon-id',
      matchType: 'exact-alternate-name',
    });
  });

  it('reports an unknown ingredient as unresolved with reason not-found', async () => {
    mockGetFoods.mockResolvedValue(paginated([]));
    mockSearchRecipesByFilter.mockResolvedValue(paginated([]));

    const result = await findRecipesForIngredients({ ingredients: ['branzino'] });

    expect(result.resolvedIngredients).toEqual([]);
    expect(result.unresolvedIngredients).toEqual([{ query: 'branzino', reason: 'not-found' }]);
    expect(result.matchSource).toBe('none');
    expect(result.recipes).toEqual([]);
  });

  it('reports an ambiguous ingredient with candidate names instead of guessing', async () => {
    mockGetFoods.mockResolvedValue(
      paginated([food({ id: 'f1', name: 'Whitefish' }), food({ id: 'f2', name: 'Catfish' })]),
    );
    mockSearchRecipesByFilter.mockResolvedValue(paginated([]));

    const result = await findRecipesForIngredients({ ingredients: ['fish'] });

    expect(result.unresolvedIngredients).toEqual([
      { query: 'fish', reason: 'ambiguous', candidates: ['Whitefish', 'Catfish'] },
    ]);
    expect(mockGetRecipeSuggestions).not.toHaveBeenCalled();
  });
});

describe('recipe matching', () => {
  it('handles multiple resolved ingredients, merging recipes and tracking which ones matched', async () => {
    mockGetFoods.mockImplementation(({ search }) => {
      if (search === 'salmon') return Promise.resolve(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
      if (search === 'broccoli') return Promise.resolve(paginated([food({ id: 'broccoli-id', name: 'Broccoli' })]));
      return Promise.resolve(paginated([]));
    });

    const sharedRecipe = recipe({ name: 'Salmon & Broccoli Bake', slug: 'salmon-broccoli-bake' });
    const salmonOnlyRecipe = recipe({ name: 'Pan-Seared Salmon', slug: 'pan-seared-salmon' });

    mockGetRecipeSuggestions.mockImplementation(({ foods }) => {
      if (foods?.[0] === 'salmon-id') {
        return Promise.resolve({ items: [suggestionItem(sharedRecipe), suggestionItem(salmonOnlyRecipe)] });
      }
      if (foods?.[0] === 'broccoli-id') {
        return Promise.resolve({ items: [suggestionItem(sharedRecipe)] });
      }
      return Promise.resolve({ items: [] });
    });

    const result = await findRecipesForIngredients({ ingredients: ['salmon', 'broccoli'] });

    expect(result.matchSource).toBe('suggestions');
    const shared = result.recipes.find((r) => r.slug === 'salmon-broccoli-bake');
    expect(shared?.matchedIngredients.sort()).toEqual(['broccoli', 'salmon']);
    const salmonOnly = result.recipes.find((r) => r.slug === 'pan-seared-salmon');
    expect(salmonOnly?.matchedIngredients).toEqual(['salmon']);
    // Recipes matching more requested ingredients rank first
    expect(result.recipes[0].slug).toBe('salmon-broccoli-bake');
  });

  it('still searches with the resolved ingredient when another ingredient in the same call is unresolved', async () => {
    mockGetFoods.mockImplementation(({ search }) => {
      if (search === 'salmon') return Promise.resolve(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
      return Promise.resolve(paginated([]));
    });
    mockGetRecipeSuggestions.mockResolvedValue({ items: [suggestionItem(recipe())] });

    const result = await findRecipesForIngredients({ ingredients: ['salmon', 'mystery vegetable'] });

    expect(result.resolvedIngredients).toHaveLength(1);
    expect(result.resolvedIngredients[0].foodName).toBe('Salmon');
    expect(result.unresolvedIngredients).toEqual([{ query: 'mystery vegetable', reason: 'not-found' }]);
    expect(mockGetRecipeSuggestions).toHaveBeenCalledTimes(1);
    expect(mockSearchRecipesByFilter).not.toHaveBeenCalled();
    expect(result.recipes).toHaveLength(1);
    expect(result.notes.some((n) => n.includes('mystery vegetable'))).toBe(true);
  });

  it('returns an empty recipe list without error when nothing matches anywhere, including the text-search fallback', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockResolvedValue({ items: [] });
    mockSearchRecipesByFilter.mockResolvedValue(paginated([]));

    const result = await findRecipesForIngredients({ ingredients: ['salmon'] });

    expect(result.matchSource).toBe('none');
    expect(result.recipes).toEqual([]);
  });

  it('always sends a permissive maxMissingFoods so Mealie does not silently exclude recipes with several other ingredients', async () => {
    // Regression test: Mealie's suggestions endpoint defaults maxMissingFoods to 5 and excludes
    // any recipe with more *other* structured-Food ingredients than that — a real recipe
    // ("Lemon Herb Grilled Salmon", 6 other foods) was silently dropped even though it referenced
    // the exact requested salmon Food ID.
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockResolvedValue({ items: [suggestionItem(recipe())] });

    await findRecipesForIngredients({ ingredients: ['salmon'] });

    const params = mockGetRecipeSuggestions.mock.calls[0][0];
    expect(params.maxMissingFoods).toBeGreaterThanOrEqual(100);
  });

  it('falls back to text search when the resolved ingredient has zero Recipe Finder results', async () => {
    // Regression test: a Food that resolves successfully but whose structured suggestions
    // search yields nothing (e.g. no recipe references it in a structured ingredient yet, or an
    // unrelated Mealie-side quirk) should still fall back to normal recipe text search rather
    // than reporting no results outright.
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'branzino-id', name: 'Branzino' })]));
    mockGetRecipeSuggestions.mockResolvedValue({ items: [] });
    mockSearchRecipesByFilter.mockResolvedValue(
      paginated([recipe({ name: 'Whole Roasted Branzino', slug: 'whole-roasted-branzino' })]),
    );

    const result = await findRecipesForIngredients({ ingredients: ['branzino'] });

    expect(mockSearchRecipesByFilter).toHaveBeenCalledWith(expect.objectContaining({ search: 'branzino' }));
    expect(result.matchSource).toBe('text-search');
    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({ slug: 'whole-roasted-branzino', matchSource: 'text-search' });
    expect(result.notes.some((n) => n.includes('Recipe Finder'))).toBe(true);
  });

  it('falls back to text search when the requireAllIngredients food-filter yields zero results', async () => {
    mockGetFoods.mockImplementation(({ search }) => {
      if (search === 'salmon') return Promise.resolve(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
      if (search === 'broccoli') return Promise.resolve(paginated([food({ id: 'broccoli-id', name: 'Broccoli' })]));
      return Promise.resolve(paginated([]));
    });
    mockSearchRecipesByFilter.mockImplementation(({ foods, search }) => {
      if (foods) return Promise.resolve(paginated([]));
      // Same recipe surfaces for both text searches, so it survives the requireAllIngredients intersection.
      if (search) return Promise.resolve(paginated([recipe({ slug: 'surf-and-turf' })]));
      return Promise.resolve(paginated([]));
    });

    const result = await findRecipesForIngredients({
      ingredients: ['salmon', 'broccoli'],
      requireAllIngredients: true,
    });

    expect(result.matchSource).toBe('text-search');
    expect(result.recipes.length).toBeGreaterThan(0);
  });

  it('falls back to Mealie normal recipe search when the ingredient has no Food match', async () => {
    mockGetFoods.mockResolvedValue(paginated([]));
    mockSearchRecipesByFilter.mockResolvedValue(paginated([recipe({ name: 'Sea Bass Piccata', slug: 'sea-bass-piccata' })]));

    const result = await findRecipesForIngredients({ ingredients: ['sea bass'] });

    expect(mockSearchRecipesByFilter).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'sea bass' }),
    );
    expect(result.matchSource).toBe('text-search');
    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      name: 'Sea Bass Piccata',
      slug: 'sea-bass-piccata',
      matchSource: 'text-search',
      matchedIngredients: ['sea bass'],
    });
  });

  it('returns a structured response with recipe name and slug for a successful exact match', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockResolvedValue({
      items: [suggestionItem(recipe({ name: 'Pan-Seared Salmon', slug: 'pan-seared-salmon' }))],
    });

    const result = await findRecipesForIngredients({ ingredients: ['salmon'], categories: ['Dinner'] });

    expect(result.recipes[0]).toMatchObject({ name: 'Pan-Seared Salmon', slug: 'pan-seared-salmon' });
  });
});

describe('taxonomy filtering', () => {
  it('filters suggestions results by category client-side', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockResolvedValue({
      items: [
        suggestionItem(recipe({ slug: 'dinner-salmon', recipeCategory: [{ name: 'Dinner', slug: 'dinner' }] })),
        suggestionItem(recipe({ slug: 'breakfast-salmon', recipeCategory: [{ name: 'Breakfast', slug: 'breakfast' }] })),
      ],
    });

    const result = await findRecipesForIngredients({ ingredients: ['salmon'], categories: ['Dinner'] });

    expect(result.recipes.map((r) => r.slug)).toEqual(['dinner-salmon']);
  });

  it('filters suggestions results by tag client-side', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockResolvedValue({
      items: [
        suggestionItem(recipe({ slug: 'df-salmon', tags: [{ name: 'Dairy-Free', slug: 'dairy-free' }] })),
        suggestionItem(recipe({ slug: 'other-salmon', tags: [{ name: 'Spicy', slug: 'spicy' }] })),
      ],
    });

    const result = await findRecipesForIngredients({ ingredients: ['salmon'], tags: ['Dairy-Free'] });

    expect(result.recipes.map((r) => r.slug)).toEqual(['df-salmon']);
  });

  it('passes categories/tags directly to Mealie for the requireAllIngredients food-filter path', async () => {
    mockGetFoods.mockImplementation(({ search }) => {
      if (search === 'salmon') return Promise.resolve(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
      if (search === 'broccoli') return Promise.resolve(paginated([food({ id: 'broccoli-id', name: 'Broccoli' })]));
      return Promise.resolve(paginated([]));
    });
    mockSearchRecipesByFilter.mockResolvedValue(paginated([recipe()]));

    await findRecipesForIngredients({
      ingredients: ['salmon', 'broccoli'],
      requireAllIngredients: true,
      categories: ['Dinner'],
      tags: ['Dairy-Free'],
      requireAllCategories: true,
    });

    expect(mockSearchRecipesByFilter).toHaveBeenCalledWith(
      expect.objectContaining({
        foods: ['salmon-id', 'broccoli-id'],
        requireAllFoods: true,
        categories: ['Dinner'],
        tags: ['Dairy-Free'],
        requireAllCategories: true,
      }),
    );
    expect(mockGetRecipeSuggestions).not.toHaveBeenCalled();
  });

  it('applies the category filter to text-search fallback results, with a note when recipes are excluded', async () => {
    // Regression test: Mealie's own category/tag query params only match by slug/ID for non-UUID
    // values. A name like "Dinner" that doesn't exactly equal the real slug ("dinner") resolves
    // to zero category IDs server-side, and Mealie's filter-building code then silently *skips*
    // the filter entirely rather than filtering to zero results — so an unresolved ingredient
    // (branzino) falling back to text search would return recipes regardless of category.
    mockGetFoods.mockResolvedValue(paginated([]));
    mockSearchRecipesByFilter.mockResolvedValue(
      paginated([
        recipe({ slug: 'dinner-branzino', name: 'Dinner Branzino', recipeCategory: [{ name: 'Dinner', slug: 'dinner' }] }),
        recipe({ slug: 'lunch-branzino', name: 'Lunch Branzino', recipeCategory: [{ name: 'Lunch', slug: 'lunch' }] }),
      ]),
    );

    const result = await findRecipesForIngredients({ ingredients: ['branzino'], categories: ['Dinner'] });

    expect(result.matchSource).toBe('text-search');
    expect(result.recipes.map((r) => r.slug)).toEqual(['dinner-branzino']);
    expect(result.notes.some((n) => n.includes('excluded by the requested categories/tags filter'))).toBe(true);
  });

  it('applies the category filter to the zero-suggestions text-search fallback for a resolved ingredient', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'branzino-id', name: 'Branzino' })]));
    mockGetRecipeSuggestions.mockResolvedValue({ items: [] });
    mockSearchRecipesByFilter.mockResolvedValue(
      paginated([
        recipe({ slug: 'dinner-branzino', recipeCategory: [{ name: 'Dinner', slug: 'dinner' }] }),
        recipe({ slug: 'lunch-branzino', recipeCategory: [{ name: 'Lunch', slug: 'lunch' }] }),
      ]),
    );

    const result = await findRecipesForIngredients({ ingredients: ['branzino'], categories: ['Dinner'] });

    expect(result.matchSource).toBe('text-search');
    expect(result.recipes.map((r) => r.slug)).toEqual(['dinner-branzino']);
  });

  it('reports the categories/tags exclusion only once, not once per discarded attempt', async () => {
    // Regression test: when the primary suggestions attempt finds a candidate that gets excluded
    // by the category filter (leaving zero results) and falls back to text search, which also
    // excludes a non-matching candidate, the discarded primary attempt's note shouldn't survive
    // alongside the fallback's — the caller only cares about the data actually being returned.
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'branzino-id', name: 'Branzino' })]));
    mockGetRecipeSuggestions.mockResolvedValue({
      items: [suggestionItem(recipe({ slug: 'brunch-branzino', recipeCategory: [{ name: 'Brunch', slug: 'brunch' }] }))],
    });
    mockSearchRecipesByFilter.mockResolvedValue(
      paginated([
        recipe({ slug: 'dinner-branzino', recipeCategory: [{ name: 'Dinner', slug: 'dinner' }] }),
        recipe({ slug: 'lunch-branzino', recipeCategory: [{ name: 'Lunch', slug: 'lunch' }] }),
      ]),
    );

    const result = await findRecipesForIngredients({ ingredients: ['branzino'], categories: ['Dinner'] });

    expect(result.matchSource).toBe('text-search');
    expect(result.recipes.map((r) => r.slug)).toEqual(['dinner-branzino']);
    const exclusionNotes = result.notes.filter((n) => n.includes('excluded by the requested categories/tags filter'));
    expect(exclusionNotes).toHaveLength(1);
  });

  it('applies the category filter as a client-side safety net on the food-filter path too', async () => {
    mockGetFoods.mockImplementation(({ search }) => {
      if (search === 'salmon') return Promise.resolve(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
      if (search === 'broccoli') return Promise.resolve(paginated([food({ id: 'broccoli-id', name: 'Broccoli' })]));
      return Promise.resolve(paginated([]));
    });
    // Simulates Mealie silently not applying its own category filter (the underlying bug), so
    // both a matching and non-matching recipe come back from the server.
    mockSearchRecipesByFilter.mockResolvedValue(
      paginated([
        recipe({ slug: 'dinner-hit', recipeCategory: [{ name: 'Dinner', slug: 'dinner' }] }),
        recipe({ slug: 'lunch-hit', recipeCategory: [{ name: 'Lunch', slug: 'lunch' }] }),
      ]),
    );

    const result = await findRecipesForIngredients({
      ingredients: ['salmon', 'broccoli'],
      requireAllIngredients: true,
      categories: ['Dinner'],
    });

    expect(result.recipes.map((r) => r.slug)).toEqual(['dinner-hit']);
  });
});

describe('limit handling', () => {
  it('clamps an excessive limit and truncates merged results to it', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    const items = Array.from({ length: 5 }, (_, i) => suggestionItem(recipe({ slug: `salmon-${i}`, name: `Salmon ${i}` })));
    mockGetRecipeSuggestions.mockResolvedValue({ items });

    const result = await findRecipesForIngredients({ ingredients: ['salmon'], limit: 2 });

    expect(result.recipes).toHaveLength(2);
  });

  it('clamps a limit below 1 up to 1', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockResolvedValue({
      items: [suggestionItem(recipe({ slug: 'a' })), suggestionItem(recipe({ slug: 'b' }))],
    });

    const result = await findRecipesForIngredients({ ingredients: ['salmon'], limit: 0 });

    expect(result.recipes).toHaveLength(1);
  });
});

describe('failure handling', () => {
  it('throws when the only resolved ingredient fails its suggestions lookup', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockRejectedValue(new Error('Mealie API error 500: boom'));

    await expect(findRecipesForIngredients({ ingredients: ['salmon'] })).rejects.toThrow(/salmon/);
  });

  it('tolerates one failing ingredient among several and still returns the rest', async () => {
    mockGetFoods.mockImplementation(({ search }) => {
      if (search === 'salmon') return Promise.resolve(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
      if (search === 'broccoli') return Promise.resolve(paginated([food({ id: 'broccoli-id', name: 'Broccoli' })]));
      return Promise.resolve(paginated([]));
    });
    mockGetRecipeSuggestions.mockImplementation(({ foods }) => {
      if (foods?.[0] === 'salmon-id') return Promise.reject(new Error('Mealie API error 503: unavailable'));
      return Promise.resolve({ items: [suggestionItem(recipe())] });
    });

    const result = await findRecipesForIngredients({ ingredients: ['salmon', 'broccoli'] });

    expect(result.recipes).toHaveLength(1);
    expect(result.notes.some((n) => n.includes('salmon'))).toBe(true);
  });
});

describe('efficiency', () => {
  it('never fetches the full food or recipe library', async () => {
    mockGetFoods.mockResolvedValue(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
    mockGetRecipeSuggestions.mockResolvedValue({ items: [suggestionItem(recipe())] });

    await findRecipesForIngredients({ ingredients: ['salmon'] });

    expect(mockGetFoods).toHaveBeenCalledTimes(1);
    const foodsCallParams = mockGetFoods.mock.calls[0][0];
    expect(foodsCallParams?.perPage).toBeGreaterThan(0);
    expect(foodsCallParams?.perPage).toBeLessThan(1000);

    expect(mockGetRecipeSuggestions).toHaveBeenCalledTimes(1);
    const suggestionsParams = mockGetRecipeSuggestions.mock.calls[0][0];
    expect(suggestionsParams.limit).toBeGreaterThan(0);
    expect(suggestionsParams.limit).toBeLessThanOrEqual(100);
  });

  it('issues at most one search call per ingredient term, not per candidate recipe', async () => {
    mockGetFoods.mockImplementation(({ search }) => {
      if (search === 'salmon') return Promise.resolve(paginated([food({ id: 'salmon-id', name: 'Salmon' })]));
      if (search === 'broccoli') return Promise.resolve(paginated([food({ id: 'broccoli-id', name: 'Broccoli' })]));
      return Promise.resolve(paginated([]));
    });
    const manyRecipes = Array.from({ length: 20 }, (_, i) => suggestionItem(recipe({ slug: `r-${i}` })));
    mockGetRecipeSuggestions.mockResolvedValue({ items: manyRecipes });

    await findRecipesForIngredients({ ingredients: ['salmon', 'broccoli'], limit: 20 });

    expect(mockGetRecipeSuggestions).toHaveBeenCalledTimes(2);
  });
});

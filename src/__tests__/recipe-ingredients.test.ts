import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/recipes.js', () => ({
  patchRecipe: vi.fn(),
}));

import * as recipesApi from '../api/recipes.js';
import { MealieApiError } from '../api/client.js';
import {
  updateRecipeIngredients,
  updateRecipeIngredientsBatch,
  RecipeIngredientsBatchValidationError,
  RECIPE_INGREDIENTS_BATCH_MAX_SIZE,
} from '../lib/recipe-ingredients.js';

const mockPatchRecipe = vi.mocked(recipesApi.patchRecipe);

beforeEach(() => {
  vi.clearAllMocks();
  mockPatchRecipe.mockImplementation((_slug: string, data: Record<string, unknown>) => Promise.resolve(data));
});

describe('updateRecipeIngredients — replacing structured ingredients', () => {
  it('replaces ingredients with structured food/unit associations, preserving all sub-fields', async () => {
    await updateRecipeIngredients('chicken-shawarma', [
      {
        quantity: 2,
        unitId: 'unit-1',
        unitName: 'tablespoons',
        foodId: 'food-1',
        foodName: 'olive oil',
        note: 'extra virgin',
        display: '2 tablespoons olive oil',
        originalText: '2 tbsp olive oil',
        title: null,
        referenceId: 'ref-new-1',
      },
    ]);

    expect(mockPatchRecipe).toHaveBeenCalledTimes(1);
    const [slugArg, payload] = mockPatchRecipe.mock.calls[0];
    expect(slugArg).toBe('chicken-shawarma');
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients).toHaveLength(1);
    expect(ingredients[0]).toEqual({
      quantity: 2,
      unit: { id: 'unit-1', name: 'tablespoons' },
      food: { id: 'food-1', name: 'olive oil' },
      note: 'extra virgin',
      display: '2 tablespoons olive oil',
      originalText: '2 tbsp olive oil',
      title: null,
      referenceId: 'ref-new-1',
    });
  });
});

// PATCH keeps the outgoing payload down to exactly { recipeIngredient }, which is what protects
// unrelated *scalar* recipe fields (name, description, settings, nutrition, categories/tags, ...)
// — confirmed correct by live testing against a real Mealie instance.
//
// IMPORTANT LIMITATION, also confirmed by live testing (both omitting recipeInstructions from the
// request AND explicitly echoing it back with matching ids): recipeInstructions[].id still gets
// regenerated on every recipe PUT *or* PATCH, regardless of payload shape. This is a Mealie-side
// bug, not something fixable from the payload we send — see the comment above
// updateRecipeIngredients() in recipe-ingredients.ts for the full root-cause trace. These mocked
// tests can only verify what our own code sends; they cannot observe or claim to fix Mealie's
// server-side persistence behavior for recipeInstructions.
describe('updateRecipeIngredients — payload never contains unrelated scalar fields (PATCH, not PUT)', () => {
  it('sends a PATCH body containing only recipeIngredient — no other recipe field', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ note: 'new single ingredient' }]);

    expect(mockPatchRecipe).toHaveBeenCalledTimes(1);
    const [slugArg, payload] = mockPatchRecipe.mock.calls[0];
    expect(slugArg).toBe('chicken-shawarma');
    expect(Object.keys(payload)).toEqual(['recipeIngredient']);
  });

  it('keeps sending only recipeIngredient across repeated updates — no unrelated scalar field is ever included', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ note: 'first write' }]);
    await updateRecipeIngredients('chicken-shawarma', [{ note: 'second write' }]);

    expect(mockPatchRecipe).toHaveBeenCalledTimes(2);
    for (const [, payload] of mockPatchRecipe.mock.calls) {
      expect(Object.keys(payload)).toEqual(['recipeIngredient']);
    }
  });
});

describe('updateRecipeIngredients — replaces rather than appends', () => {
  it('the supplied list is sent verbatim as the complete new collection', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ note: 'new ingredient A' }, { note: 'new ingredient B' }]);

    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients).toHaveLength(2);
    expect(ingredients.map((i) => i.note)).toEqual(['new ingredient A', 'new ingredient B']);
  });
});

describe('updateRecipeIngredients — preserves false/zero values', () => {
  it('does not drop an explicit quantity of 0', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ quantity: 0, note: 'a pinch' }]);
    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients[0].quantity).toBe(0);
  });

  it('does not drop an explicit empty-string note or display', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ note: '', display: '' }]);
    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients[0].note).toBe('');
    expect(ingredients[0].display).toBe('');
  });
});

describe('updateRecipeIngredients — null/optional fields', () => {
  it('sends null for note/title/originalText when explicitly requested', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ note: null, title: null, originalText: null }]);
    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients[0]).toMatchObject({ note: null, title: null, originalText: null });
  });

  it('omits quantity/note/display/title/originalText/referenceId entirely when not supplied', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{}]);
    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients[0]).not.toHaveProperty('quantity');
    expect(ingredients[0]).not.toHaveProperty('note');
    expect(ingredients[0]).not.toHaveProperty('display');
    expect(ingredients[0]).not.toHaveProperty('title');
    expect(ingredients[0]).not.toHaveProperty('originalText');
    expect(ingredients[0]).not.toHaveProperty('referenceId');
    expect(ingredients[0]).toEqual({ food: null, unit: null });
  });

  it('preserves an explicit title used as a section heading', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ title: 'For the sauce' }]);
    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients[0].title).toBe('For the sauce');
  });
});

// Mealie's RecipeIngredientModel has no "display" database column at all (confirmed against the
// ORM model source) — it's a purely computed field. RecipeIngredient's `format_display`
// model_validator recomputes it from quantity/unit/food/note on every read whenever the value is
// falsy, and since nothing ever persists our supplied value, it reads back falsy on every
// subsequent load and gets recomputed every time. We still accept and forward whatever the
// caller supplies (Mealie's schema accepts it and this may change in a future Mealie version),
// but it should never be relied upon to round-trip literally.
describe('updateRecipeIngredients — display is forwarded but not guaranteed to persist', () => {
  it('forwards a caller-supplied display value in the outgoing payload as-is', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ display: 'CUSTOM TEST DISPLAY' }]);
    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients[0].display).toBe('CUSTOM TEST DISPLAY');
  });
});

describe('updateRecipeIngredients — alias/name independence', () => {
  it('keeps the food id distinct from its display name in the transformed payload', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ foodId: 'food-abc', foodName: 'Green Onion' }]);
    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients[0].food).toEqual({ id: 'food-abc', name: 'Green Onion' });
  });

  it('keeps the unit id distinct from its display name in the transformed payload', async () => {
    await updateRecipeIngredients('chicken-shawarma', [{ unitId: 'unit-abc', unitName: 'Tablespoon' }]);
    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients[0].unit).toEqual({ id: 'unit-abc', name: 'Tablespoon' });
  });

  it('rejects a foodId given without a foodName', async () => {
    await expect(updateRecipeIngredients('chicken-shawarma', [{ foodId: 'food-abc' }])).rejects.toThrow(/foodName/);
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });

  it('rejects a foodName given without a foodId', async () => {
    await expect(updateRecipeIngredients('chicken-shawarma', [{ foodName: 'Onion' }])).rejects.toThrow(/foodId/);
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });

  it('rejects a unitId given without a unitName', async () => {
    await expect(updateRecipeIngredients('chicken-shawarma', [{ unitId: 'unit-abc' }])).rejects.toThrow(/unitName/);
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });

  it('rejects a unitName given without a unitId', async () => {
    await expect(updateRecipeIngredients('chicken-shawarma', [{ unitName: 'Tablespoon' }])).rejects.toThrow(/unitId/);
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });

  it('validates ingredients before making any network call', async () => {
    await expect(updateRecipeIngredients('chicken-shawarma', [{ foodId: 'food-abc' }])).rejects.toThrow();
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });
});

describe('updateRecipeIngredients — empty ingredient collection', () => {
  it('sends an empty recipeIngredient array to intentionally clear all ingredients', async () => {
    await updateRecipeIngredients('chicken-shawarma', []);

    const [, payload] = mockPatchRecipe.mock.calls[0];
    expect(payload).toEqual({ recipeIngredient: [] });
  });
});

describe('updateRecipeIngredients — recipe not found', () => {
  it('propagates the same not-found error as other recipe tools', async () => {
    mockPatchRecipe.mockRejectedValue(new Error('Mealie API error 404: Not Found'));
    await expect(updateRecipeIngredients('missing-recipe', [{ note: 'x' }])).rejects.toThrow(/404/);
  });
});

describe('updateRecipeIngredients — Mealie API failure', () => {
  it('propagates an error from the patch call without masquerading as success', async () => {
    mockPatchRecipe.mockRejectedValue(new Error('Mealie API error 500: Internal Server Error'));
    await expect(updateRecipeIngredients('chicken-shawarma', [{ note: 'x' }])).rejects.toThrow(/500/);
  });
});

describe('updateRecipeIngredientsBatch — basic behavior', () => {
  it('updates two recipes successfully, preserving input order and reporting counts', async () => {
    const result = await updateRecipeIngredientsBatch([
      { slug: 'recipe-a', ingredients: [{ note: 'flour' }, { note: 'sugar' }] },
      { slug: 'recipe-b', ingredients: [{ note: 'butter' }] },
    ]);

    expect(result.requestedCount).toBe(2);
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.apiRequestCount).toBe(2);
    expect(result.results.map((r) => r.slug)).toEqual(['recipe-a', 'recipe-b']);
    expect(result.results[0]).toEqual({ slug: 'recipe-a', success: true, ingredientCount: 2 });
    expect(result.results[1]).toEqual({ slug: 'recipe-b', success: true, ingredientCount: 1 });
    expect(mockPatchRecipe).toHaveBeenCalledTimes(2);
  });

  it('sends only recipeIngredient for each recipe, leaving other fields untouched', async () => {
    await updateRecipeIngredientsBatch([
      { slug: 'recipe-a', ingredients: [{ note: 'flour' }] },
      { slug: 'recipe-b', ingredients: [{ note: 'butter' }] },
    ]);

    for (const [, payload] of mockPatchRecipe.mock.calls) {
      expect(Object.keys(payload)).toEqual(['recipeIngredient']);
    }
  });

  it('preserves supplied referenceId values exactly, same as the singular tool', async () => {
    await updateRecipeIngredientsBatch([
      { slug: 'recipe-a', ingredients: [{ note: 'flour', referenceId: 'ref-1' }] },
    ]);

    const [, payload] = mockPatchRecipe.mock.calls[0];
    const ingredients = payload.recipeIngredient as Record<string, unknown>[];
    expect(ingredients[0].referenceId).toBe('ref-1');
  });

  it('does not touch unrelated instruction/category/tag fields (payload is recipeIngredient only)', async () => {
    await updateRecipeIngredientsBatch([{ slug: 'recipe-a', ingredients: [{ note: 'flour' }] }]);
    const [, payload] = mockPatchRecipe.mock.calls[0];
    expect(payload).not.toHaveProperty('recipeInstructions');
    expect(payload).not.toHaveProperty('recipeCategory');
    expect(payload).not.toHaveProperty('tags');
  });

  it('does not return full recipe payloads for successful entries — only a compact summary', async () => {
    mockPatchRecipe.mockResolvedValue({
      slug: 'recipe-a',
      recipeIngredient: [{ note: 'flour' }],
      name: 'Some Recipe',
      description: 'A long description',
      nutrition: { calories: '100' },
    });

    const result = await updateRecipeIngredientsBatch([{ slug: 'recipe-a', ingredients: [{ note: 'flour' }] }]);

    expect(result.results[0]).toEqual({ slug: 'recipe-a', success: true, ingredientCount: 1 });
    expect(result.results[0]).not.toHaveProperty('name');
    expect(result.results[0]).not.toHaveProperty('nutrition');
  });
});

describe('updateRecipeIngredientsBatch — failure isolation', () => {
  it('recipe 2 fails with 404, recipes 1 and 3 stay successful', async () => {
    mockPatchRecipe.mockImplementation((slug: string) => {
      if (slug === 'recipe-2') {
        return Promise.reject(new MealieApiError(404, 'Not Found'));
      }
      return Promise.resolve({ slug, recipeIngredient: [] });
    });

    const result = await updateRecipeIngredientsBatch([
      { slug: 'recipe-1', ingredients: [{ note: 'a' }] },
      { slug: 'recipe-2', ingredients: [{ note: 'b' }] },
      { slug: 'recipe-3', ingredients: [{ note: 'c' }] },
    ]);

    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ slug: 'recipe-1', success: true });
    expect(result.results[2]).toMatchObject({ slug: 'recipe-3', success: true });
    const failed = result.results[1];
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.slug).toBe('recipe-2');
      expect(failed.error.status).toBe(404);
      expect(failed.error.message).toMatch(/404/);
    }
  });

  it('recipe 2 fails with 422, siblings still succeed', async () => {
    mockPatchRecipe.mockImplementation((slug: string) => {
      if (slug === 'recipe-2') {
        return Promise.reject(new MealieApiError(422, 'Unprocessable Entity'));
      }
      return Promise.resolve({ slug, recipeIngredient: [] });
    });

    const result = await updateRecipeIngredientsBatch([
      { slug: 'recipe-1', ingredients: [{ note: 'a' }] },
      { slug: 'recipe-2', ingredients: [{ note: 'b' }] },
      { slug: 'recipe-3', ingredients: [{ note: 'c' }] },
    ]);

    expect(result.results.filter((r) => r.success)).toHaveLength(2);
    const failed = result.results.find((r) => r.slug === 'recipe-2');
    expect(failed?.success).toBe(false);
    if (failed && !failed.success) {
      expect(failed.error.status).toBe(422);
    }
  });

  it('recipe 2 fails with 502 (transient upstream failure), siblings still succeed', async () => {
    mockPatchRecipe.mockImplementation((slug: string) => {
      if (slug === 'recipe-2') {
        return Promise.reject(new MealieApiError(502, 'Bad Gateway'));
      }
      return Promise.resolve({ slug, recipeIngredient: [] });
    });

    const result = await updateRecipeIngredientsBatch([
      { slug: 'recipe-1', ingredients: [{ note: 'a' }] },
      { slug: 'recipe-2', ingredients: [{ note: 'b' }] },
      { slug: 'recipe-3', ingredients: [{ note: 'c' }] },
    ]);

    expect(result.results.filter((r) => r.success).map((r) => r.slug)).toEqual(['recipe-1', 'recipe-3']);
    const failed = result.results.find((r) => r.slug === 'recipe-2');
    expect(failed?.success).toBe(false);
    if (failed && !failed.success) {
      expect(failed.error.status).toBe(502);
      expect(failed.error.message).toMatch(/Bad Gateway/);
    }
  });

  it('a local validation error (mismatched foodId/foodName) on one recipe is isolated, not a batch-wide failure', async () => {
    const result = await updateRecipeIngredientsBatch([
      { slug: 'recipe-1', ingredients: [{ note: 'a' }] },
      { slug: 'recipe-2', ingredients: [{ foodId: 'food-1' }] },
      { slug: 'recipe-3', ingredients: [{ note: 'c' }] },
    ]);

    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(1);
    const failed = result.results.find((r) => r.slug === 'recipe-2');
    expect(failed?.success).toBe(false);
    if (failed && !failed.success) {
      expect(failed.error.message).toMatch(/foodName/);
    }
  });

  it('one failed item does not roll back or prevent previously/subsequently successful writes', async () => {
    mockPatchRecipe.mockImplementation((slug: string) => {
      if (slug === 'recipe-2') {
        return Promise.reject(new MealieApiError(502, 'Bad Gateway'));
      }
      return Promise.resolve({ slug, recipeIngredient: [] });
    });

    await updateRecipeIngredientsBatch([
      { slug: 'recipe-1', ingredients: [{ note: 'a' }] },
      { slug: 'recipe-2', ingredients: [{ note: 'b' }] },
      { slug: 'recipe-3', ingredients: [{ note: 'c' }] },
    ]);

    expect(mockPatchRecipe).toHaveBeenCalledWith('recipe-1', expect.anything());
    expect(mockPatchRecipe).toHaveBeenCalledWith('recipe-3', expect.anything());
  });
});

describe('updateRecipeIngredientsBatch — validation', () => {
  it('rejects an empty batch', async () => {
    await expect(updateRecipeIngredientsBatch([])).rejects.toThrow(RecipeIngredientsBatchValidationError);
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });

  it('rejects a batch larger than the maximum size', async () => {
    const updates = Array.from({ length: RECIPE_INGREDIENTS_BATCH_MAX_SIZE + 1 }, (_, i) => ({
      slug: `recipe-${i}`,
      ingredients: [],
    }));

    await expect(updateRecipeIngredientsBatch(updates)).rejects.toThrow(RecipeIngredientsBatchValidationError);
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });

  it('accepts a batch at exactly the maximum size', async () => {
    const updates = Array.from({ length: RECIPE_INGREDIENTS_BATCH_MAX_SIZE }, (_, i) => ({
      slug: `recipe-${i}`,
      ingredients: [],
    }));

    const result = await updateRecipeIngredientsBatch(updates);
    expect(result.requestedCount).toBe(RECIPE_INGREDIENTS_BATCH_MAX_SIZE);
    expect(result.succeededCount).toBe(RECIPE_INGREDIENTS_BATCH_MAX_SIZE);
  });

  it('rejects duplicate recipe slugs in the same batch', async () => {
    await expect(
      updateRecipeIngredientsBatch([
        { slug: 'recipe-a', ingredients: [{ note: 'a' }] },
        { slug: 'recipe-a', ingredients: [{ note: 'b' }] },
      ]),
    ).rejects.toThrow(RecipeIngredientsBatchValidationError);
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });

  it('rejects a missing/blank recipe identifier', async () => {
    await expect(
      updateRecipeIngredientsBatch([{ slug: '', ingredients: [{ note: 'a' }] }]),
    ).rejects.toThrow(RecipeIngredientsBatchValidationError);
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });

  it('validates the whole batch before starting any write', async () => {
    await expect(
      updateRecipeIngredientsBatch([
        { slug: 'recipe-a', ingredients: [{ note: 'a' }] },
        { slug: 'recipe-a', ingredients: [{ note: 'b' }] },
      ]),
    ).rejects.toThrow();
    expect(mockPatchRecipe).not.toHaveBeenCalled();
  });
});

describe('updateRecipeIngredientsBatch — concurrency', () => {
  it('bounds concurrency instead of firing every request at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    mockPatchRecipe.mockImplementation((slug: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight--;
          resolve({ slug, recipeIngredient: [] });
        }, 5);
      });
    });

    const updates = Array.from({ length: 12 }, (_, i) => ({ slug: `recipe-${i}`, ingredients: [{ note: 'x' }] }));
    await updateRecipeIngredientsBatch(updates);

    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('preserves input order in results regardless of completion order', async () => {
    mockPatchRecipe.mockImplementation((slug: string) => {
      // Reverse the delay so later-submitted recipes resolve first.
      const index = Number(slug.split('-')[1]);
      const delay = (5 - index) * 5;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ slug, recipeIngredient: [] }), delay);
      });
    });

    const updates = Array.from({ length: 5 }, (_, i) => ({ slug: `recipe-${i}`, ingredients: [{ note: 'x' }] }));
    const result = await updateRecipeIngredientsBatch(updates);

    expect(result.results.map((r) => r.slug)).toEqual(['recipe-0', 'recipe-1', 'recipe-2', 'recipe-3', 'recipe-4']);
  });
});

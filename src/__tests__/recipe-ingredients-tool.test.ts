import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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

vi.mock('../lib/recipe-ingredients.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/recipe-ingredients.js')>('../lib/recipe-ingredients.js');
  return {
    RECIPE_INGREDIENTS_BATCH_MAX_SIZE: actual.RECIPE_INGREDIENTS_BATCH_MAX_SIZE,
    updateRecipeIngredients: vi.fn(),
    updateRecipeIngredientsBatch: vi.fn(),
  };
});

import * as ingredientsLib from '../lib/recipe-ingredients.js';
import { registerRecipeTools } from '../tools/recipes.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

function createMockServer(): { server: McpServer; handlers: Map<string, ToolHandler> } {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as ToolHandler;
      handlers.set(name, cb);
      return {};
    },
  };
  return { server: server as unknown as McpServer, handlers };
}

const mockUpdateRecipeIngredients = vi.mocked(ingredientsLib.updateRecipeIngredients);
const mockUpdateRecipeIngredientsBatch = vi.mocked(ingredientsLib.updateRecipeIngredientsBatch);

let handlers: Map<string, ToolHandler>;

beforeEach(() => {
  vi.clearAllMocks();
  const mocked = createMockServer();
  registerRecipeTools(mocked.server);
  handlers = mocked.handlers;
});

describe('update_recipe_ingredients tool', () => {
  it('is registered', () => {
    expect(handlers.has('update_recipe_ingredients')).toBe(true);
  });

  it('forwards slug and ingredients to the lib function and returns its result', async () => {
    const updated = { slug: 'chicken-shawarma', recipeIngredient: [{ note: 'olive oil' }] };
    mockUpdateRecipeIngredients.mockResolvedValue(updated);

    const handler = handlers.get('update_recipe_ingredients')!;
    const response = await handler({
      slug: 'chicken-shawarma',
      ingredients: [{ note: 'olive oil' }],
    });

    expect(mockUpdateRecipeIngredients).toHaveBeenCalledWith('chicken-shawarma', [{ note: 'olive oil' }]);
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0].text)).toEqual(updated);
  });

  it('accepts an empty ingredients array', async () => {
    mockUpdateRecipeIngredients.mockResolvedValue({ slug: 'chicken-shawarma', recipeIngredient: [] });

    const handler = handlers.get('update_recipe_ingredients')!;
    const response = await handler({ slug: 'chicken-shawarma', ingredients: [] });

    expect(mockUpdateRecipeIngredients).toHaveBeenCalledWith('chicken-shawarma', []);
    expect(response.isError).toBeUndefined();
  });

  it('surfaces a not-found error the same way as other recipe tools', async () => {
    mockUpdateRecipeIngredients.mockRejectedValue(new Error('Mealie API error 404: Not Found'));

    const handler = handlers.get('update_recipe_ingredients')!;
    const response = await handler({ slug: 'missing-recipe', ingredients: [] });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/404/);
  });

  it('surfaces a local validation error (e.g. mismatched food id/name) as an error response', async () => {
    mockUpdateRecipeIngredients.mockRejectedValue(
      new Error('foodId was given without foodName — both are required to reference an existing food.'),
    );

    const handler = handlers.get('update_recipe_ingredients')!;
    const response = await handler({
      slug: 'chicken-shawarma',
      ingredients: [{ foodId: 'food-1' }],
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/foodName/);
  });

  it('surfaces a general Mealie API failure without masquerading as success', async () => {
    mockUpdateRecipeIngredients.mockRejectedValue(new Error('Mealie API error 500: Internal Server Error'));

    const handler = handlers.get('update_recipe_ingredients')!;
    const response = await handler({ slug: 'chicken-shawarma', ingredients: [{ note: 'x' }] });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/500/);
  });
});

describe('update_recipe_ingredients_batch tool', () => {
  it('is registered', () => {
    expect(handlers.has('update_recipe_ingredients_batch')).toBe(true);
  });

  it('forwards updates to the lib batch function and returns its compact result', async () => {
    const batchResult = {
      requestedCount: 2,
      succeededCount: 2,
      failedCount: 0,
      results: [
        { slug: 'recipe-a', success: true, ingredientCount: 2 },
        { slug: 'recipe-b', success: true, ingredientCount: 1 },
      ],
      apiRequestCount: 2,
    };
    mockUpdateRecipeIngredientsBatch.mockResolvedValue(batchResult);

    const handler = handlers.get('update_recipe_ingredients_batch')!;
    const response = await handler({
      updates: [
        { slug: 'recipe-a', ingredients: [{ note: 'flour' }, { note: 'sugar' }] },
        { slug: 'recipe-b', ingredients: [{ note: 'butter' }] },
      ],
    });

    expect(mockUpdateRecipeIngredientsBatch).toHaveBeenCalledWith([
      { slug: 'recipe-a', ingredients: [{ note: 'flour' }, { note: 'sugar' }] },
      { slug: 'recipe-b', ingredients: [{ note: 'butter' }] },
    ]);
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0].text)).toEqual(batchResult);
  });

  it('surfaces a per-recipe failure inside a successful (non-error) batch response', async () => {
    mockUpdateRecipeIngredientsBatch.mockResolvedValue({
      requestedCount: 2,
      succeededCount: 1,
      failedCount: 1,
      results: [
        { slug: 'recipe-a', success: true, ingredientCount: 1 },
        { slug: 'recipe-b', success: false, error: { message: 'Mealie API error 502: Bad Gateway', status: 502 } },
      ],
      apiRequestCount: 2,
    });

    const handler = handlers.get('update_recipe_ingredients_batch')!;
    const response = await handler({
      updates: [
        { slug: 'recipe-a', ingredients: [{ note: 'a' }] },
        { slug: 'recipe-b', ingredients: [{ note: 'b' }] },
      ],
    });

    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0].text) as {
      failedCount: number;
      results: { error?: { status?: number } }[];
    };
    expect(body.failedCount).toBe(1);
    expect(body.results[1].error?.status).toBe(502);
  });

  it('surfaces a top-level validation error (e.g. duplicate slugs) as an error response', async () => {
    mockUpdateRecipeIngredientsBatch.mockRejectedValue(
      new Error('Duplicate recipe slug(s) in the same batch call: recipe-a.'),
    );

    const handler = handlers.get('update_recipe_ingredients_batch')!;
    const response = await handler({
      updates: [
        { slug: 'recipe-a', ingredients: [{ note: 'a' }] },
        { slug: 'recipe-a', ingredients: [{ note: 'b' }] },
      ],
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/Duplicate recipe slug/);
  });
});

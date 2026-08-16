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
  getRecipeSuggestions: vi.fn(),
  searchRecipesByFilter: vi.fn(),
}));

vi.mock('../api/foods.js', () => ({
  getFoods: vi.fn(),
}));

import * as foodsApi from '../api/foods.js';
import * as recipesApi from '../api/recipes.js';
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

function paginated<T>(items: T[]): { items: T[]; total: number; page: number; size: number } {
  return { items, total: items.length, page: 1, size: items.length };
}

const mockGetFoods = vi.mocked(foodsApi.getFoods);
const mockGetRecipeSuggestions = vi.mocked(recipesApi.getRecipeSuggestions);

let handlers: Map<string, ToolHandler>;

beforeEach(() => {
  vi.clearAllMocks();
  const mocked = createMockServer();
  registerRecipeTools(mocked.server);
  handlers = mocked.handlers;
});

describe('find_recipes_for_ingredients tool', () => {
  it('is registered', () => {
    expect(handlers.has('find_recipes_for_ingredients')).toBe(true);
  });

  it('returns a structured JSON result on success', async () => {
    mockGetFoods.mockResolvedValue(paginated([{ id: 'salmon-id', name: 'Salmon', aliases: [] }]));
    mockGetRecipeSuggestions.mockResolvedValue({
      items: [
        {
          recipe: { name: 'Pan-Seared Salmon', slug: 'pan-seared-salmon', recipeCategory: [], tags: [] },
          missingFoods: [],
          missingTools: [],
        },
      ],
    });

    const handler = handlers.get('find_recipes_for_ingredients')!;
    const response = await handler({ ingredients: ['salmon'] });

    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0].text) as { matchSource: string; recipes: { slug: string }[] };
    expect(body.matchSource).toBe('suggestions');
    expect(body.recipes[0].slug).toBe('pan-seared-salmon');
  });

  it('returns an error response instead of throwing on malformed input', async () => {
    const handler = handlers.get('find_recipes_for_ingredients')!;
    const response = await handler({ ingredients: [''] });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/ingredients/);
  });
});

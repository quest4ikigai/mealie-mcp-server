import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../api/recipes.js', () => ({
  getRecipes: vi.fn(),
}));

vi.mock('../api/categories.js', () => ({
  getCategories: vi.fn(),
}));

vi.mock('../api/tags.js', () => ({
  getTags: vi.fn(),
}));

import * as recipesApi from '../api/recipes.js';
import * as categoriesApi from '../api/categories.js';
import * as tagsApi from '../api/tags.js';
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

const DINNER = { id: 'cat-1', name: 'Dinner', slug: 'dinner' };
const DAIRY_FREE = { id: 'tag-1', name: 'Dairy-Free', slug: 'dairy-free' };

const mockGetRecipes = vi.mocked(recipesApi.getRecipes);
const mockGetCategories = vi.mocked(categoriesApi.getCategories);
const mockGetTags = vi.mocked(tagsApi.getTags);

let handlers: Map<string, ToolHandler>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCategories.mockResolvedValue(paginated([DINNER]));
  mockGetTags.mockResolvedValue(paginated([DAIRY_FREE]));
  mockGetRecipes.mockResolvedValue(paginated([]));

  const mocked = createMockServer();
  registerRecipeTools(mocked.server);
  handlers = mocked.handlers;
});

describe('get_recipes taxonomy filter resolution', () => {
  it('resolves a display-name category to its canonical ID before calling Mealie, instead of forwarding it unresolved', async () => {
    // Regression test: Mealie's own category query param only matches by exact slug/ID for
    // non-UUID values and silently *skips* the filter (rather than filtering to zero) when
    // nothing resolves — confirmed live: categories=["Dinner"] returned the whole library
    // unfiltered, while categories=["dinner"] correctly filtered it.
    const handler = handlers.get('get_recipes')!;
    await handler({ categories: ['Dinner'] });

    expect(mockGetRecipes).toHaveBeenCalledWith(expect.objectContaining({ categories: ['cat-1'] }));
  });

  it('resolves a display-name tag to its canonical ID before calling Mealie', async () => {
    const handler = handlers.get('get_recipes')!;
    await handler({ tags: ['Dairy-Free'] });

    expect(mockGetRecipes).toHaveBeenCalledWith(expect.objectContaining({ tags: ['tag-1'] }));
  });

  it('behaves identically whether the caller passes the display name or the exact slug', async () => {
    const handler = handlers.get('get_recipes')!;

    await handler({ categories: ['Dinner'] });
    const [callWithName] = mockGetRecipes.mock.calls.at(-1)!;

    mockGetRecipes.mockClear();
    await handler({ categories: ['dinner'] });
    const [callWithSlug] = mockGetRecipes.mock.calls.at(-1)!;

    expect(callWithName.categories).toEqual(callWithSlug.categories);
  });

  it('returns a clear error instead of silently returning the unfiltered library for an unknown category', async () => {
    const handler = handlers.get('get_recipes')!;
    const response = await handler({ categories: ['Dinnner'] });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/Dinnner/);
    expect(mockGetRecipes).not.toHaveBeenCalled();
  });

  it('returns a clear error instead of silently returning the unfiltered library for an unknown tag', async () => {
    const handler = handlers.get('get_recipes')!;
    const response = await handler({ tags: ['Spicy'] });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/Spicy/);
    expect(mockGetRecipes).not.toHaveBeenCalled();
  });

  it('passes an ID straight through', async () => {
    const handler = handlers.get('get_recipes')!;
    await handler({ categories: ['cat-1'] });

    expect(mockGetRecipes).toHaveBeenCalledWith(expect.objectContaining({ categories: ['cat-1'] }));
  });

  it('respects requireAllCategories/requireAllTags alongside resolution', async () => {
    const handler = handlers.get('get_recipes')!;
    await handler({ categories: ['Dinner'], tags: ['Dairy-Free'], requireAllCategories: true, requireAllTags: true });

    expect(mockGetRecipes).toHaveBeenCalledWith(
      expect.objectContaining({
        categories: ['cat-1'],
        tags: ['tag-1'],
        requireAllCategories: true,
        requireAllTags: true,
      }),
    );
  });

  it('does not resolve anything when no categories/tags are given', async () => {
    const handler = handlers.get('get_recipes')!;
    await handler({ search: 'chicken' });

    expect(mockGetCategories).not.toHaveBeenCalled();
    expect(mockGetTags).not.toHaveBeenCalled();
    expect(mockGetRecipes).toHaveBeenCalledWith(expect.objectContaining({ search: 'chicken' }));
  });
});

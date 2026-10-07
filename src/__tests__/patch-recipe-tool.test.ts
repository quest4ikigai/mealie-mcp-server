import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../api/client.js')>('../api/client.js');
  return {
    ...actual,
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPut: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import * as client from '../api/client.js';
import { registerRecipeTools } from '../tools/recipes.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const mockApiPatch = vi.mocked(client.apiPatch);

let handler: ToolHandler;
let inputSchema: z.ZodObject<z.ZodRawShape>;

beforeEach(() => {
  vi.clearAllMocks();
  const registered = new Map<string, unknown[]>();
  registerRecipeTools({
    tool: (name: string, ...rest: unknown[]) => {
      registered.set(name, rest);
      return {};
    },
  } as unknown as McpServer);
  const rest = registered.get('patch_recipe')!;
  handler = rest[rest.length - 1] as ToolHandler;
  inputSchema = z.object(rest[rest.length - 2] as z.ZodRawShape);
  mockApiPatch.mockResolvedValue({ slug: 'pasta' });
});

describe('patch_recipe tool', () => {
  it('forwards recipeServings, recipeYieldQuantity and orgURL in the PATCH payload', async () => {
    const args = inputSchema.parse({
      slug: 'pasta',
      recipeServings: 4,
      recipeYieldQuantity: 4,
      orgURL: 'https://example.org/r',
    });
    const response = await handler(args);

    expect(response.isError).toBeUndefined();
    expect(mockApiPatch).toHaveBeenCalledWith('/api/recipes/pasta', {
      recipeServings: 4,
      recipeYieldQuantity: 4,
      orgURL: 'https://example.org/r',
    });
  });

  it('sends nothing for the new fields when they are omitted', async () => {
    await handler(inputSchema.parse({ slug: 'pasta', name: 'Pasta' }));

    expect(mockApiPatch).toHaveBeenCalledWith('/api/recipes/pasta', { name: 'Pasta' });
  });

  it.each(['recipeServings', 'recipeYieldQuantity'])('rejects a non-number %s', (field) => {
    expect(inputSchema.safeParse({ slug: 'pasta', [field]: '4' }).success).toBe(false);
  });
});

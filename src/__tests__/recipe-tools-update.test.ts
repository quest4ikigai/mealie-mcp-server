import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../api/recipes.js', () => ({
  getRecipe: vi.fn(),
  patchRecipe: vi.fn(),
}));
vi.mock('../api/tools.js', () => ({
  getTools: vi.fn(),
  createTool: vi.fn(),
}));

import * as recipesApi from '../api/recipes.js';
import * as toolsApi from '../api/tools.js';
import { registerRecipeTools } from '../tools/recipes.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const SKILLET = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Skillet', slug: 'skillet' };
const WHISK = { id: 'aaaaaaaa-0000-0000-0000-000000000002', name: 'Whisk', slug: 'whisk' };
const SHEET = { id: 'aaaaaaaa-0000-0000-0000-000000000003', name: 'Sheet Pan', slug: 'sheet-pan' };

const mockGetRecipe = vi.mocked(recipesApi.getRecipe);
const mockPatch = vi.mocked(recipesApi.patchRecipe);
const mockGetTools = vi.mocked(toolsApi.getTools);
const mockCreateTool = vi.mocked(toolsApi.createTool);

interface Body {
  id: string;
  slug: string;
  tools: Record<'final' | 'added' | 'removed' | 'created', { name: string }[]>;
}

let handler: ToolHandler;

async function run(args: Record<string, unknown>) {
  const response = await handler({ slug: 'salmon', ...args });
  return { response, body: response.isError ? undefined : JSON.parse(response.content[0].text) as Body };
}

const names = (items: { name: string }[]) => items.map((i) => i.name);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRecipe.mockResolvedValue({
    id: 'r1',
    slug: 'salmon',
    name: 'Salmon',
    recipeIngredient: [{ note: 'salmon' }],
    tools: [SKILLET, WHISK],
  });
  mockPatch.mockResolvedValue({});
  mockGetTools.mockResolvedValue({ items: [SKILLET, WHISK, SHEET], total: 3, page: 1, size: 3 });
  mockCreateTool.mockImplementation((name: string) =>
    Promise.resolve({ id: 'new-1', name, slug: name.toLowerCase().replace(/ /g, '-') }),
  );

  const handlers = new Map<string, ToolHandler>();
  registerRecipeTools({
    tool: (name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as ToolHandler);
    },
  } as unknown as McpServer);
  handler = handlers.get('update_recipe_tools')!;
});

describe('update_recipe_tools', () => {
  it('merges by default, keeping existing tools, and PATCHes only tools', async () => {
    const { body } = await run({ tools: ['Sheet Pan', 'Whisk'] });
    expect(names(body!.tools.final)).toEqual(['Skillet', 'Whisk', 'Sheet Pan']);
    expect(names(body!.tools.added)).toEqual(['Sheet Pan']);
    expect(body!.tools.removed).toEqual([]);
    expect(mockGetTools).toHaveBeenCalledWith({ perPage: -1 });
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const [slug, data] = mockPatch.mock.calls[0];
    expect(slug).toBe('salmon');
    expect(Object.keys(data)).toEqual(['tools']);
    expect(body!.id).toBe('r1');
  });

  it('replace sets the collection and reports removals', async () => {
    const { body } = await run({ tools: ['Sheet Pan', 'Whisk'], mode: 'replace' });
    expect(names(body!.tools.final)).toEqual(['Sheet Pan', 'Whisk']);
    expect(names(body!.tools.added)).toEqual(['Sheet Pan']);
    expect(names(body!.tools.removed)).toEqual(['Skillet']);
  });

  it('replace with an empty array clears all tools', async () => {
    const { body } = await run({ tools: [], mode: 'replace' });
    expect(body!.tools.final).toEqual([]);
    expect(names(body!.tools.removed)).toEqual(['Skillet', 'Whisk']);
    expect(mockPatch.mock.calls[0][1]).toEqual({ tools: [] });
  });

  it('empty merge is a no-op with no PATCH', async () => {
    const { body } = await run({ tools: [] });
    expect(names(body!.tools.final)).toEqual(['Skillet', 'Whisk']);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('resolves by ID, slug, and case-insensitive name, collapsing duplicates', async () => {
    const { body } = await run({ tools: [SHEET.id, 'sheet-pan', 'SHEET PAN'] });
    expect(names(body!.tools.added)).toEqual(['Sheet Pan']);
    expect(body!.tools.final).toHaveLength(3);
  });

  it('fails listing all unresolved values without PATCHing or creating', async () => {
    const { response } = await run({ tools: ['Baking Sheet', 'Wok', 'Whisk'] });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/Baking Sheet, Wok/);
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockCreateTool).not.toHaveBeenCalled();
  });

  it('creates missing tools when createMissing is true', async () => {
    const { body } = await run({ tools: ['Wok'], createMissing: true });
    expect(mockCreateTool).toHaveBeenCalledWith('Wok');
    expect(names(body!.tools.created)).toEqual(['Wok']);
    expect(names(body!.tools.final)).toEqual(['Skillet', 'Whisk', 'Wok']);
  });

  it('indexes a created tool under its id, slug, and name so aliases do not create twice', async () => {
    const { body } = await run({ tools: ['Dutch Oven', 'dutch-oven'], createMissing: true });
    expect(mockCreateTool).toHaveBeenCalledTimes(1);
    expect(names(body!.tools.created)).toEqual(['Dutch Oven']);
  });

  it('rejects blank tool values in the input schema', () => {
    let schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> = {};
    registerRecipeTools({
      tool: (name: string, ...rest: unknown[]) => {
        if (name === 'update_recipe_tools') schema = rest[rest.length - 2] as typeof schema;
      },
    } as unknown as McpServer);
    expect(schema.tools.safeParse(['  ', '']).success).toBe(false);
    expect(schema.tools.safeParse([]).success).toBe(true);
    expect(schema.tools.safeParse(['Whisk']).success).toBe(true);
  });

  it('leaves earlier created tools in place and skips the PATCH when a later creation fails', async () => {
    mockCreateTool.mockReset();
    mockCreateTool
      .mockResolvedValueOnce({ id: 'new-1', name: 'Wok', slug: 'wok' })
      .mockRejectedValueOnce(new Error('second boom'));
    const { response } = await run({ tools: ['Wok', 'Steamer'], createMissing: true });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/second boom/);
    expect(mockCreateTool).toHaveBeenCalledTimes(2);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('propagates recipe-not-found, creation, and PATCH failures', async () => {
    mockGetRecipe.mockRejectedValueOnce(new Error('Recipe not found'));
    expect((await run({ tools: ['Whisk'] })).response.content[0].text).toMatch(/Recipe not found/);

    mockCreateTool.mockRejectedValueOnce(new Error('create boom'));
    const created = await run({ tools: ['Wok'], createMissing: true });
    expect(created.response.isError).toBe(true);
    expect(created.response.content[0].text).toMatch(/create boom/);
    expect(mockPatch).not.toHaveBeenCalled();

    mockPatch.mockRejectedValueOnce(new Error('patch boom'));
    const patched = await run({ tools: ['Sheet Pan'] });
    expect(patched.response.isError).toBe(true);
    expect(patched.response.content[0].text).toMatch(/patch boom/);
  });
});

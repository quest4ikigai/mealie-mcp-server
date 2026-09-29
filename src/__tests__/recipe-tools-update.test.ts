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

  describe('delta form', () => {
    it('adds tools and PATCHes only tools', async () => {
      const { body } = await run({ add: ['Sheet Pan'] });
      expect(names(body!.tools.final)).toEqual(['Skillet', 'Whisk', 'Sheet Pan']);
      expect(names(body!.tools.added)).toEqual(['Sheet Pan']);
      expect(body!.tools.removed).toEqual([]);
      expect(Object.keys(mockPatch.mock.calls[0][1])).toEqual(['tools']);
    });

    it('removes tools by name, slug, or ID', async () => {
      const { body } = await run({ remove: ['skillet', WHISK.id] });
      expect(body!.tools.final).toEqual([]);
      expect(names(body!.tools.removed)).toEqual(['Skillet', 'Whisk']);
      expect(mockPatch.mock.calls[0][1]).toEqual({ tools: [] });
    });

    it('applies combined add and remove as current - removals + additions', async () => {
      const { body } = await run({ add: ['Sheet Pan'], remove: ['Skillet'] });
      expect(names(body!.tools.final)).toEqual(['Whisk', 'Sheet Pan']);
      expect(names(body!.tools.added)).toEqual(['Sheet Pan']);
      expect(names(body!.tools.removed)).toEqual(['Skillet']);
    });

    it('fails an unknown remove before any PATCH or creation, even with createMissing', async () => {
      const { response } = await run({ add: ['Wok'], remove: ['Nonexistent'], createMissing: true });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/Nonexistent/);
      expect(mockPatch).not.toHaveBeenCalled();
      expect(mockCreateTool).not.toHaveBeenCalled();
    });

    it('rejects the same resolved tool in add and remove before creating anything', async () => {
      const { response } = await run({ add: ['skillet', 'Wok'], remove: [SKILLET.id], createMissing: true });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/both add and remove/);
      expect(mockPatch).not.toHaveBeenCalled();
      expect(mockCreateTool).not.toHaveBeenCalled();
    });

    it('skips the PATCH when the delta changes nothing', async () => {
      const { body } = await run({ add: ['Whisk'] });
      expect(names(body!.tools.final)).toEqual(['Skillet', 'Whisk']);
      expect(mockPatch).not.toHaveBeenCalled();
      const removeOnly = await run({ add: [], remove: ['Sheet Pan'] });
      expect(removeOnly.body!.tools.removed).toEqual([]);
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('creates missing additions when createMissing is true', async () => {
      const { body } = await run({ add: ['Wok'], remove: ['Skillet'], createMissing: true });
      expect(mockCreateTool).toHaveBeenCalledWith('Wok');
      expect(names(body!.tools.created)).toEqual(['Wok']);
      expect(names(body!.tools.final)).toEqual(['Whisk', 'Wok']);
    });

    it('fails on unknown additions without createMissing', async () => {
      const { response } = await run({ add: ['Wok'] });
      expect(response.isError).toBe(true);
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('cannot mix legacy and delta forms, and requires a mutation', async () => {
      for (const args of [
        { tools: ['Whisk'], add: ['Wok'] },
        { tools: ['Whisk'], remove: ['Skillet'] },
        { mode: 'replace', add: ['Whisk'] },
        {},
        { mode: 'merge' },
      ]) {
        const { response } = await run(args);
        expect(response.isError).toBe(true);
      }
      expect(mockPatch).not.toHaveBeenCalled();
      expect(mockGetRecipe).not.toHaveBeenCalled();
    });

    it('leaves unrelated recipe fields out of the PATCH body', async () => {
      await run({ add: ['Sheet Pan'] });
      expect(mockPatch.mock.calls[0][1]).not.toHaveProperty('recipeIngredient');
      expect(mockPatch.mock.calls[0][1]).not.toHaveProperty('name');
    });
  });
});

describe('update_recipe_tools_batch', () => {
  let batch: ToolHandler;
  let schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;

  beforeEach(() => {
    const handlers = new Map<string, ToolHandler>();
    registerRecipeTools({
      tool: (name: string, ...rest: unknown[]) => {
        handlers.set(name, rest[rest.length - 1] as ToolHandler);
        if (name === 'update_recipe_tools_batch') schema = rest[rest.length - 2] as typeof schema;
      },
    } as unknown as McpServer);
    batch = handlers.get('update_recipe_tools_batch')!;
    mockGetRecipe.mockImplementation((slug: string) =>
      Promise.resolve({ id: `id-${slug}`, slug, name: slug, tools: [SKILLET] }),
    );
  });

  interface BatchBody {
    requestedCount: number;
    succeededCount: number;
    failedCount: number;
    results: { slug: string; success: boolean; error?: string; tools?: Body['tools'] }[];
  }
  const runBatch = async (updates: unknown[]) => {
    const response = await batch({ updates });
    return { response, body: response.isError ? undefined : (JSON.parse(response.content[0].text) as BatchBody) };
  };

  it('handles legacy and delta entries and preserves order', async () => {
    const { body } = await runBatch([
      { slug: 'a', add: ['Whisk'], remove: ['Skillet'] },
      { slug: 'b', tools: ['Sheet Pan'], mode: 'replace' },
    ]);
    expect(body).toMatchObject({ requestedCount: 2, succeededCount: 2, failedCount: 0 });
    expect(body!.results.map((r) => r.slug)).toEqual(['a', 'b']);
    expect(names(body!.results[0].tools!.final)).toEqual(['Whisk']);
    expect(names(body!.results[1].tools!.final)).toEqual(['Sheet Pan']);
    expect(mockPatch).toHaveBeenCalledTimes(2);
  });

  it('isolates a failing recipe from its siblings', async () => {
    mockGetRecipe.mockImplementation((slug: string) =>
      slug === 'bad' ? Promise.reject(new Error('Recipe not found')) : Promise.resolve({ id: slug, slug, tools: [] }),
    );
    const { body } = await runBatch([
      { slug: 'a', add: ['Whisk'] },
      { slug: 'bad', add: ['Whisk'] },
      { slug: 'c', add: ['Whisk'] },
      { slug: 'd', add: ['Nope'] },
    ]);
    expect(body).toMatchObject({ requestedCount: 4, succeededCount: 2, failedCount: 2 });
    expect(body!.results.map((r) => r.success)).toEqual([true, false, true, false]);
    expect(body!.results[1].error).toMatch(/Recipe not found/);
    expect(body!.results[3].error).toMatch(/Nope/);
    expect(mockPatch).toHaveBeenCalledTimes(2);
  });

  it('reports per-recipe shape errors without blocking others', async () => {
    const { body } = await runBatch([
      { slug: 'a', tools: ['Whisk'], add: ['Wok'] },
      { slug: 'b', add: ['Whisk'] },
    ]);
    expect(body!.results.map((r) => r.success)).toEqual([false, true]);
  });

  it('never has more than 5 recipes in flight', async () => {
    let inFlight = 0;
    let max = 0;
    mockGetRecipe.mockImplementation(async (slug: string) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { id: slug, slug, tools: [] };
    });
    const updates = Array.from({ length: 12 }, (_, i) => ({ slug: `r${i}`, add: ['Whisk'] }));
    const { body } = await runBatch(updates);
    expect(body!.succeededCount).toBe(12);
    expect(max).toBe(5);
  });

  it('rejects duplicate slugs before any recipe read or write', async () => {
    const { response } = await runBatch([
      { slug: 'a', add: ['Whisk'] },
      { slug: 'a', remove: ['Skillet'] },
    ]);
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/Duplicate recipe slug/);
    expect(mockGetRecipe).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('validates batch size in the schema and at runtime', async () => {
    const { updates } = schema;
    const entry = (i: number) => ({ slug: `r${i}`, add: ['Whisk'] });
    expect(updates.safeParse([]).success).toBe(false);
    expect(updates.safeParse(Array.from({ length: 26 }, (_, i) => entry(i))).success).toBe(false);
    expect(updates.safeParse(Array.from({ length: 25 }, (_, i) => entry(i))).success).toBe(true);
    const { response } = await runBatch(Array.from({ length: 26 }, (_, i) => entry(i)));
    expect(response.isError).toBe(true);
    expect(mockGetRecipe).not.toHaveBeenCalled();
  });

  it('serializes createMissing so a shared new tool is created once', async () => {
    const created: { id: string; name: string; slug: string }[] = [];
    mockGetTools.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { items: [SKILLET, ...created], total: 1, page: 1, size: 1 };
    });
    mockCreateTool.mockImplementation(async (name: string) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const tool = { id: `new-${created.length}`, name, slug: name.toLowerCase() };
      created.push(tool);
      return tool;
    });
    const { body } = await runBatch([
      { slug: 'a', add: ['Wok'], createMissing: true },
      { slug: 'b', add: ['Wok'], createMissing: true },
    ]);
    expect(mockCreateTool).toHaveBeenCalledTimes(1);
    expect(body!.succeededCount).toBe(2);
    expect(names(body!.results[1].tools!.final)).toEqual(['Skillet', 'Wok']);
  });
});

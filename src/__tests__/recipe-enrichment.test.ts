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
  getRecipesForDataEnrichment,
  resolveActiveFilters,
  DEFAULT_ENRICHMENT_FILTERS,
  InvalidLimitError,
  InvalidCursorError,
  InvalidEnrichmentInputError,
  type EnrichmentFilters,
} from '../lib/recipe-enrichment.js';
import { auditRecipe } from '../lib/recipe-audit.js';
import { registerRecipeTools } from '../tools/recipes.js';

const mockGetRecipes = vi.mocked(recipesApi.getRecipes);
const mockGetRecipe = vi.mocked(recipesApi.getRecipe);

const FOOD = { id: 'f-1', name: 'flour' };
const UNIT = { id: 'u-1', name: 'cup' };

const structured = (ref = 'r-s') => ({ referenceId: ref, quantity: 2, unit: UNIT, food: FOOD, note: '', display: '2 cups flour', originalText: null, title: null });
const unparsed = (ref = 'r-u') => ({ referenceId: ref, quantity: 0, unit: null, food: null, note: '1 tbsp x', display: '1 tbsp x', originalText: null, title: null });
const partial = (ref = 'r-p') => ({ referenceId: ref, quantity: 4, unit: null, food: { id: 'f-e', name: 'egg' }, note: '', display: '4 eggs', originalText: null, title: null });
const section = (ref = 'r-sec') => ({ referenceId: ref, quantity: 0, unit: null, food: null, note: '', display: '', originalText: null, title: 'Sauce' });

const TAX = [{ id: 't-1', name: 'Dinner', slug: 'dinner' }];

/** A fully "clean" recipe: matches no default filter. Overrides make it match specific ones. */
function makeRecipe(i: number, overrides: Record<string, unknown> = {}) {
  const id = `id-${String(i).padStart(3, '0')}`;
  const slug = `recipe-${i}`;
  const createdAt = `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(Math.floor(i / 60)).padStart(6, '0')}`;
  return {
    summary: { id, slug, name: `Recipe ${i}`, createdAt },
    detail: {
      id,
      slug,
      name: `Recipe ${i}`,
      createdAt,
      updatedAt: `2024-02-01T00:00:00.000000`,
      description: 'desc',
      totalTime: '30 minutes',
      prepTime: null,
      cookTime: '20 minutes',
      recipeServings: 4,
      recipeYield: '4 servings',
      orgURL: 'https://example.com/r',
      recipeCategory: TAX,
      tags: TAX,
      tools: [{ id: 'tool-1', name: 'Whisk', slug: 'whisk' }],
      image: 'abc',
      recipeIngredient: [section(), structured('r-a'), structured('r-b')],
      recipeInstructions: [{ id: 'i-1', title: '', text: 'Mix', ingredientReferences: [{ referenceId: 'r-a' }] }],
      ...overrides,
    } as Record<string, unknown>,
  };
}

function setup(recipes: ReturnType<typeof makeRecipe>[]) {
  mockGetRecipes.mockImplementation((params) => {
    const page = params?.page ?? 1;
    const perPage = params?.perPage ?? 50;
    const items = recipes.map((r) => r.summary).slice((page - 1) * perPage, page * perPage);
    return Promise.resolve({ items, total: recipes.length, page, size: items.length } as never);
  });
  mockGetRecipe.mockImplementation((slug: string) => {
    const found = recipes.find((r) => r.detail.slug === slug);
    return found ? Promise.resolve(found.detail as never) : Promise.reject(new Error(`not found: ${slug}`));
  });
}

async function slugs(filters: EnrichmentFilters | undefined, match?: 'any' | 'all') {
  const result = await getRecipesForDataEnrichment({ filters, match });
  return result.items.map((i) => i.slug);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('input validation', () => {
  it('uses default arguments and returns only default matches', async () => {
    setup([makeRecipe(1), makeRecipe(2, { image: '' })]);
    const result = await getRecipesForDataEnrichment({});
    expect(result.items.map((i) => i.slug)).toEqual(['recipe-2']);
    expect(result.hasMore).toBe(false);
    expect(result.returnedCount).toBe(1);
    expect(result.scannedCount).toBe(2);
  });

  it('accepts limit bounds and rejects invalid limits', async () => {
    setup([makeRecipe(1)]);
    await expect(getRecipesForDataEnrichment({ limit: 1 })).resolves.toBeDefined();
    await expect(getRecipesForDataEnrichment({ limit: 50 })).resolves.toBeDefined();
    for (const limit of [0, 51, 1.5, -1, Number.NaN]) {
      await expect(getRecipesForDataEnrichment({ limit })).rejects.toBeInstanceOf(InvalidLimitError);
    }
  });

  it('rejects invalid match values and accepts any/all', async () => {
    setup([makeRecipe(1)]);
    await expect(getRecipesForDataEnrichment({ match: 'some' as never })).rejects.toBeInstanceOf(InvalidEnrichmentInputError);
    await expect(getRecipesForDataEnrichment({ match: 'any' })).resolves.toBeDefined();
    await expect(getRecipesForDataEnrichment({ match: 'all' })).resolves.toBeDefined();
  });

  it('omitted filters activate exactly DEFAULT_ENRICHMENT_FILTERS', () => {
    expect(resolveActiveFilters(undefined)).toEqual(DEFAULT_ENRICHMENT_FILTERS);
    expect(DEFAULT_ENRICHMENT_FILTERS).toEqual({
      ingredientParsing: 'unparsed_or_partial',
      ingredientSections: false,
      instructionIngredientLinks: 'missing_or_dangling',
      tools: false,
      categories: false,
      tags: false,
      image: false,
    });
  });

  it('explicit filters replace, not merge with, defaults', async () => {
    expect(resolveActiveFilters({ image: false })).toEqual({ image: false });
    // Recipe has no categories (a default condition) but an image: must NOT match image:false.
    setup([makeRecipe(1, { recipeCategory: [] })]);
    expect(await slugs({ image: false })).toEqual([]);
  });

  it('rejects an empty filters object', async () => {
    setup([makeRecipe(1)]);
    await expect(getRecipesForDataEnrichment({ filters: {} })).rejects.toThrow(/at least one dimension/);
  });

  it('rejects invalid enum values, non-boolean binaries, and unknown keys', () => {
    expect(() => resolveActiveFilters({ ingredientParsing: 'bogus' })).toThrow(InvalidEnrichmentInputError);
    expect(() => resolveActiveFilters({ instructionIngredientLinks: 'bogus' })).toThrow(InvalidEnrichmentInputError);
    for (const dim of ['ingredientSections', 'tools', 'categories', 'tags', 'image']) {
      expect(() => resolveActiveFilters({ [dim]: 'true' })).toThrow(/must be a boolean/);
      expect(() => resolveActiveFilters({ [dim]: 1 })).toThrow(/must be a boolean/);
      expect(() => resolveActiveFilters({ [dim]: true })).not.toThrow();
    }
    expect(() => resolveActiveFilters({ sortOrder: 'asc' })).toThrow(/Unknown filter/);
    expect(() => resolveActiveFilters(null)).toThrow(InvalidEnrichmentInputError);
    expect(() => resolveActiveFilters([])).toThrow(InvalidEnrichmentInputError);
  });

  it('rejects a malformed cursor', async () => {
    setup([makeRecipe(1)]);
    await expect(getRecipesForDataEnrichment({ cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

describe('individual filter predicates', () => {
  it('ingredientParsing unparsed / partial / unparsed_or_partial', async () => {
    setup([
      makeRecipe(1, { recipeIngredient: [unparsed()] }),
      makeRecipe(2, { recipeIngredient: [partial()] }),
      makeRecipe(3, { recipeIngredient: [structured()] }),
    ]);
    expect(await slugs({ ingredientParsing: 'unparsed' })).toEqual(['recipe-1']);
    expect(await slugs({ ingredientParsing: 'partial' })).toEqual(['recipe-2']);
    expect(await slugs({ ingredientParsing: 'unparsed_or_partial' })).toEqual(['recipe-1', 'recipe-2']);
  });

  it('ingredientSections true / false, zero-ingredient recipe never matches false', async () => {
    setup([
      makeRecipe(1, { recipeIngredient: [section(), structured()] }),
      makeRecipe(2, { recipeIngredient: [structured()] }),
      makeRecipe(3, { recipeIngredient: [] }),
    ]);
    expect(await slugs({ ingredientSections: true })).toEqual(['recipe-1']);
    expect(await slugs({ ingredientSections: false })).toEqual(['recipe-2']);
  });

  it('instructionIngredientLinks missing / dangling / missing_or_dangling', async () => {
    const step = (refs: unknown[]) => [{ id: 'i', title: '', text: 'x', ingredientReferences: refs }];
    setup([
      makeRecipe(1, { recipeInstructions: step([]) }), // missing
      makeRecipe(2, { recipeInstructions: step([{ referenceId: 'ghost' }]) }), // dangling
      makeRecipe(3, { recipeInstructions: step([{ referenceId: 'r-a' }]) }), // fine
      makeRecipe(4, { recipeInstructions: [] }), // zero instructions: not "missing"
    ]);
    expect(await slugs({ instructionIngredientLinks: 'missing' })).toEqual(['recipe-1']);
    expect(await slugs({ instructionIngredientLinks: 'dangling' })).toEqual(['recipe-2']);
    expect(await slugs({ instructionIngredientLinks: 'missing_or_dangling' })).toEqual(['recipe-1', 'recipe-2']);
  });

  it.each([
    ['tools', 'tools'],
    ['categories', 'recipeCategory'],
    ['tags', 'tags'],
  ])('%s true / false', async (dim, field) => {
    setup([makeRecipe(1), makeRecipe(2, { [field]: [] })]);
    expect(await slugs({ [dim]: true })).toEqual(['recipe-1']);
    expect(await slugs({ [dim]: false })).toEqual(['recipe-2']);
  });

  it('image true / false', async () => {
    setup([makeRecipe(1), makeRecipe(2, { image: null })]);
    expect(await slugs({ image: true })).toEqual(['recipe-1']);
    expect(await slugs({ image: false })).toEqual(['recipe-2']);
  });
});

describe('filter composition', () => {
  it('match any vs all with matchedDimensions', async () => {
    setup([
      makeRecipe(1, { recipeCategory: [] }),
      makeRecipe(2, { recipeCategory: [], tags: [] }),
      makeRecipe(3),
    ]);
    const filters = { categories: false, tags: false };
    const any = await getRecipesForDataEnrichment({ filters, match: 'any' });
    expect(any.items.map((i) => [i.slug, i.matchedDimensions])).toEqual([
      ['recipe-1', ['categories']],
      ['recipe-2', ['categories', 'tags']],
    ]);
    const all = await getRecipesForDataEnrichment({ filters, match: 'all' });
    expect(all.items.map((i) => i.slug)).toEqual(['recipe-2']);
    expect(all.items[0].matchedDimensions).toEqual(['categories', 'tags']);
  });

  it('matchedDimensions lists only active matching dimensions in default mode', async () => {
    setup([makeRecipe(1, { recipeCategory: [], image: '', recipeIngredient: [section(), unparsed('r-a')] })]);
    const result = await getRecipesForDataEnrichment({});
    expect(result.items[0].matchedDimensions).toEqual(['ingredientParsing', 'categories', 'image']);
  });

  it('match all on omitted filters applies to the full default set', async () => {
    const worst = makeRecipe(1, {
      recipeIngredient: [unparsed()],
      recipeInstructions: [{ id: 'i', title: '', text: 'x', ingredientReferences: [] }],
      tools: [],
      recipeCategory: [],
      tags: [],
      image: '',
    });
    setup([worst, makeRecipe(2, { image: '' })]);
    const result = await getRecipesForDataEnrichment({ match: 'all' });
    expect(result.items.map((i) => i.slug)).toEqual(['recipe-1']);
    expect(result.items[0].matchedDimensions).toEqual([
      'ingredientParsing',
      'ingredientSections',
      'instructionIngredientLinks',
      'tools',
      'categories',
      'tags',
      'image',
    ]);
  });
});

describe('response projection', () => {
  it('projects stored fields, audit, and compact shapes', async () => {
    const r = makeRecipe(1, {
      image: '',
      recipeIngredient: [section('r-sec'), unparsed('r-u'), partial('r-p'), structured('r-s')],
      recipeInstructions: [
        { id: 'unstable', title: 'Step', text: 'Mix', ingredientReferences: [{ referenceId: 'r-u' }, { referenceId: 'r-p' }] },
      ],
    });
    setup([r]);
    const { items } = await getRecipesForDataEnrichment({});
    const item = items[0];

    expect(item.createdAt).toBe(r.detail.createdAt);
    expect(item.updatedAt).toBe('2024-02-01T00:00:00.000000');
    expect(item.sourceUrl).toBe('https://example.com/r');
    expect(item.servings).toBe(4);
    expect(item.ingredients.map((i) => [i.referenceId, i.parsingState])).toEqual([
      ['r-sec', 'section'],
      ['r-u', 'unparsed'],
      ['r-p', 'partial'],
      ['r-s', 'structured'],
    ]);
    expect(item.ingredients[3].unit).toEqual(UNIT);
    expect(item.ingredients[3].food).toEqual(FOOD);
    expect(item.instructions).toEqual([{ title: 'Step', text: 'Mix', ingredientReferenceIds: ['r-u', 'r-p'] }]);
    expect(item.instructions[0]).not.toHaveProperty('id');
    expect(item.tools).toEqual([{ id: 'tool-1', name: 'Whisk' }]);
    expect(item.categories).toEqual(TAX);
    expect(item.tags).toEqual(TAX);
    expect(item.audit).toEqual(auditRecipe(r.detail));
    expect(item).not.toHaveProperty('needsEnrichment');
    expect(item).not.toHaveProperty('flaggedDimensions');
  });

  it('null updatedAt/createdAt when absent', async () => {
    const r = makeRecipe(1, { image: '', updatedAt: undefined, createdAt: undefined });
    setup([r]);
    const { items } = await getRecipesForDataEnrichment({});
    expect(items[0].createdAt).toBeNull();
    expect(items[0].updatedAt).toBeNull();
  });
});

describe('pagination and resilience', () => {
  const bare = (i: number, overrides: Record<string, unknown> = {}) => makeRecipe(i, { image: '', ...overrides });

  it('orders oldest-first by createdAt then id, regardless of server order', async () => {
    const a = bare(1);
    const b = bare(2);
    const tieA = { ...bare(3), summary: { ...bare(3).summary, createdAt: b.summary.createdAt, id: 'id-zzz', slug: 'recipe-3' } };
    setup([b, tieA, a]);
    const result = await getRecipesForDataEnrichment({});
    expect(result.items.map((i) => i.slug)).toEqual(['recipe-1', 'recipe-2', 'recipe-3']);
  });

  it('continues from nextCursor without overlap', async () => {
    setup(Array.from({ length: 7 }, (_, i) => bare(i + 1)));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await getRecipesForDataEnrichment({ limit: 3, cursor });
      seen.push(...page.items.map((i) => i.slug));
      pages++;
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    }
    expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `recipe-${i + 1}`));
    expect(pages).toBe(3);
  });

  it('sparse scan returns matches across many non-matching recipes', async () => {
    const recipes = Array.from({ length: 30 }, (_, i) => (i === 24 ? bare(i + 1) : makeRecipe(i + 1)));
    setup(recipes);
    const result = await getRecipesForDataEnrichment({ limit: 5 });
    expect(result.items.map((i) => i.slug)).toEqual(['recipe-25']);
    expect(result.scannedCount).toBe(30);
    expect(result.hasMore).toBe(false);
  });

  it('soft deadline returns a partial page with a resumable cursor', async () => {
    setup(Array.from({ length: 45 }, (_, i) => bare(i + 1)));
    const page1 = await getRecipesForDataEnrichment({ limit: 40 }, { now: () => 0, deadlineMs: -1 });
    expect(page1.hasMore).toBe(true);
    expect(page1.returnedCount).toBeLessThan(40);
    const page2 = await getRecipesForDataEnrichment({ limit: 50, cursor: page1.nextCursor! });
    const all = [...page1.items, ...page2.items].map((i) => i.slug);
    expect(new Set(all).size).toBe(45);
    expect(all).toHaveLength(45);
  });

  it('isolates per-recipe detail failures, including malformed responses', async () => {
    const recipes = [bare(1), bare(2), bare(3), bare(4), bare(5)];
    setup(recipes);
    const bad = new Map<string, unknown>([
      ['recipe-2', null],
      ['recipe-3', 'oops'],
      ['recipe-4', [1, 2]],
    ]);
    mockGetRecipe.mockImplementation((slug: string) => {
      if (bad.has(slug)) return Promise.resolve(bad.get(slug) as never);
      if (slug === 'recipe-5') return Promise.reject(new Error('boom'));
      return Promise.resolve(recipes.find((r) => r.detail.slug === slug)!.detail as never);
    });
    const result = await getRecipesForDataEnrichment({});
    expect(result.items.map((i) => i.slug)).toEqual(['recipe-1']);
    expect(result.failures.map((f) => f.slug)).toEqual(['recipe-2', 'recipe-3', 'recipe-4', 'recipe-5']);
    expect(result.failures[3].error).toBe('boom');
  });

  it('is read-only', async () => {
    setup([bare(1)]);
    await getRecipesForDataEnrichment({});
    for (const fn of ['patchRecipe', 'updateRecipe', 'createRecipe', 'deleteRecipe', 'duplicateRecipe', 'updateRecipeLastMade', 'setRecipeImageFromUrl'] as const) {
      expect(vi.mocked(recipesApi[fn])).not.toHaveBeenCalled();
    }
  });
});

describe('tool registration', () => {
  it('registers read-only with a description and the filters schema', () => {
    const tool = vi.fn<(name: string, ...rest: unknown[]) => undefined>();
    registerRecipeTools({ tool } as never);
    const call = tool.mock.calls.find(([name]) => name === 'get_recipes_for_data_enrichment');
    expect(call).toBeDefined();
    expect(typeof call![1]).toBe('string');
    expect(call).toContainEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const shape = call![2] as Record<string, unknown>;
    expect(Object.keys(shape)).toEqual(['cursor', 'limit', 'match', 'filters']);
  });
});

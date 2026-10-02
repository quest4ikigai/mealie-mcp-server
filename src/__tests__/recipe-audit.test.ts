import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/recipes.js', () => ({
  getRecipes: vi.fn(),
  getRecipe: vi.fn(),
}));

import * as recipesApi from '../api/recipes.js';
import { auditRecipe, auditTaxonomy, classifyIngredient, scanAuditedRecipes } from '../lib/recipe-audit.js';
import { decodeCursor } from '../lib/recipe-scan.js';

const mockedGetRecipes = vi.mocked(recipesApi.getRecipes);
const mockedGetRecipe = vi.mocked(recipesApi.getRecipe);

describe('classifyIngredient', () => {
  it('classifies by field presence only', () => {
    expect(classifyIngredient({ title: 'Sauce' })).toBe('section');
    expect(classifyIngredient({ title: 'Crust', food: { id: 'f' }, unit: null, quantity: 1 })).toBe('partial');
    expect(classifyIngredient({ title: 'Wraps', food: { id: 'f' }, unit: { id: 'u' }, quantity: 2 })).toBe('structured');
    expect(classifyIngredient({ title: 'Extra', food: null, quantity: 2 })).toBe('unparsed');
    expect(classifyIngredient({ title: 'Extra', food: null, note: 'x' })).toBe('unparsed');
    expect(classifyIngredient({ title: '', food: null, note: 'x' })).toBe('unparsed');
    expect(classifyIngredient({ food: { id: 'f' }, unit: null, quantity: 2 })).toBe('partial');
    expect(classifyIngredient({ food: { id: 'f' }, unit: null, quantity: 0 })).toBe('structured');
    expect(classifyIngredient({ food: { id: 'f' }, unit: { id: 'u' }, quantity: 2 })).toBe('structured');
  });
});

describe('auditRecipe', () => {
  it('computes counts and presence signals for every dimension', () => {
    const audit = auditRecipe({
      recipeIngredient: [
        { title: 'Sauce', referenceId: 'r0' },
        { referenceId: 'r1', food: null },
        { referenceId: 'r2', food: { id: 'f' }, unit: null, quantity: 1 },
        { referenceId: 'r3', food: { id: 'f' }, unit: { id: 'u' }, quantity: 1 },
      ],
      recipeInstructions: [
        { title: 'Make', text: 'a', ingredientReferences: [{ referenceId: 'r1' }, { referenceId: 'gone' }] },
        { title: '', text: 'b', ingredientReferences: [] },
      ],
      tools: [{ id: 't' }],
      recipeCategory: [{ id: 'c1' }, { id: 'c2' }],
      tags: [],
      image: 'abc',
    });
    expect(audit.ingredients).toEqual({ totalCount: 4, structuredCount: 1, partialCount: 1, unparsedCount: 1, sectionCount: 1 });
    expect(audit.instructions).toEqual({
      instructionCount: 2,
      referencedInstructionCount: 1,
      referenceCount: 2,
      danglingReferenceCount: 1,
      sectionCount: 1,
    });
    expect(audit.toolCount).toBe(1);
    expect(audit.categoryCount).toBe(2);
    expect(audit.tagCount).toBe(0);
    expect(audit.hasImage).toBe(true);
  });

  it('handles an empty or malformed recipe', () => {
    const audit = auditRecipe({ recipeIngredient: null, tools: 'x', image: null });
    expect(audit.ingredients.totalCount).toBe(0);
    expect(audit.instructions.instructionCount).toBe(0);
    expect(audit.toolCount).toBe(0);
    expect(audit.hasImage).toBe(false);
  });

  it('auditTaxonomy counts from a list summary', () => {
    expect(auditTaxonomy({ recipeCategory: [{}], tags: [{}, {}] })).toEqual({ categoryCount: 1, tagCount: 2 });
  });
});

describe('scanAuditedRecipes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetRecipes.mockResolvedValue({
      items: [1, 2, 3].map((n) => ({ id: `id${n}`, slug: `s${n}`, createdAt: `2024-01-0${n}` })),
      total: 3,
    } as never);
  });

  it('isolates per-recipe failures and stops at the limit with a cursor', async () => {
    mockedGetRecipe.mockImplementation((slug: string) =>
      slug === 's1' ? Promise.reject(new Error('boom')) : Promise.resolve({ id: slug, slug, tools: [] } as never),
    );
    const result = await scanAuditedRecipes({
      startCursor: null,
      limit: 1,
      matches: (a) => a.toolCount === 0,
      toItem: (d) => String(d.slug),
    });
    expect(result.items).toEqual(['s2']);
    expect(result.failures).toEqual([{ slug: 's1', id: 'id1', error: 'boom' }]);
    expect(result.stopReason).toBe('limit');
    expect(result.hasMore).toBe(true);
    expect(decodeCursor(result.nextCursor ?? '').lastId).toBe('id2');
  });

  it.each([null, []])('treats an invalid detail response (%j) as a per-recipe failure', async (bad) => {
    mockedGetRecipe.mockImplementation((slug: string) =>
      Promise.resolve((slug === 's1' ? bad : { id: slug, slug, tools: [] }) as never),
    );
    const result = await scanAuditedRecipes({
      startCursor: null,
      limit: 5,
      matches: () => true,
      toItem: (d) => String(d.slug),
    });
    expect(result.items).toEqual(['s2', 's3']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ slug: 's1', id: 'id1' });
  });

  it('reports exhaustion with no cursor', async () => {
    mockedGetRecipe.mockResolvedValue({ tools: [{}] });
    const result = await scanAuditedRecipes({ startCursor: null, limit: 5, matches: () => false, toItem: () => 1 });
    expect(result.scannedCount).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

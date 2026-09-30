import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/recipes.js', () => ({
  getRecipe: vi.fn(),
  patchRecipe: vi.fn(),
}));

import * as recipesApi from '../api/recipes.js';
import { MealieApiError } from '../api/client.js';
import {
  updateRecipeInstructions,
  updateRecipeInstructionsBatch,
  InstructionVerificationError,
  StaleInstructionSnapshotError,
  RecipeInstructionsBatchValidationError,
  RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE,
} from '../lib/recipe-instructions.js';

async function caught(promise: Promise<unknown>): Promise<InstructionVerificationError> {
  try {
    await promise;
  } catch (error) {
    return error as InstructionVerificationError;
  }
  throw new Error('expected rejection');
}

const mockGet = vi.mocked(recipesApi.getRecipe);
const mockPatch = vi.mocked(recipesApi.patchRecipe);

const ING_A = '11111111-1111-4111-8111-111111111111';
const ING_B = '22222222-2222-4222-8222-222222222222';
const DANGLING = '99999999-9999-4999-8999-999999999999';
const NOTE = '33333333-3333-4333-8333-333333333333';
const TS = '2026-01-01T00:00:00Z';

function step(text: string, extra: Record<string, unknown> = {}, id = `id-${text}`) {
  return { id, text, title: '', summary: '', ingredientReferences: [], noteReferences: [], ...extra };
}

function makeRecipe(instructions: Record<string, unknown>[], updatedAt = TS) {
  return {
    slug: 'r',
    name: 'R',
    updatedAt,
    recipeIngredient: [{ referenceId: ING_A }, { referenceId: ING_B }],
    recipeInstructions: instructions,
  };
}

const BASE = () => [
  step('s0', { ingredientReferences: [{ referenceId: ING_A }], noteReferences: [{ referenceId: NOTE }] }),
  step('s1', { title: 'T1', summary: 'S1', ingredientReferences: [{ referenceId: DANGLING }] }),
  step('s2'),
];

// Simulates Mealie: echoes the patch and regenerates every instruction id.
function echoPatch() {
  mockPatch.mockImplementation((_slug, data) => {
    const steps = ((data as { recipeInstructions?: Record<string, unknown>[] }).recipeInstructions ?? []).map((s, i) => ({
      ...s,
      id: `new-${i}`,
    }));
    return Promise.resolve({ ...makeRecipe(steps, 'later') });
  });
}

function sentTexts(): string[] {
  const payload = (mockPatch.mock.calls[0][1] as { recipeInstructions: { text: string }[] }).recipeInstructions;
  return payload.map((s) => s.text);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGet.mockImplementation(() => Promise.resolve(makeRecipe(BASE())));
  echoPatch();
});

describe('guard and identity', () => {
  it('rejects a stale expectedUpdatedAt before any PATCH', async () => {
    await expect(updateRecipeInstructions('r', { expectedUpdatedAt: 'old', addInstructions: [{ text: 'x' }] })).rejects.toThrow(
      StaleInstructionSnapshotError,
    );
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('requires expectedUpdatedAt', async () => {
    await expect(updateRecipeInstructions('r', { expectedUpdatedAt: '', addInstructions: [{ text: 'x' }] })).rejects.toThrow(/expectedUpdatedAt/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('allows the exact current token with one GET and one PATCH, never sending instruction ids', async () => {
    await updateRecipeInstructions('r', { expectedUpdatedAt: TS, addInstructions: [{ text: 'x' }] });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    const sent = mockPatch.mock.calls[0][1] as { recipeInstructions: Record<string, unknown>[] };
    expect(Object.keys(mockPatch.mock.calls[0][1] as object)).toEqual(['recipeInstructions']);
    for (const s of sent.recipeInstructions) expect(s).not.toHaveProperty('id');
  });

  it('addresses duplicate-text instructions by index', async () => {
    mockGet.mockResolvedValue(makeRecipe([step('same', {}, 'a'), step('same', {}, 'b'), step('same', {}, 'c')]));
    await updateRecipeInstructions('r', { expectedUpdatedAt: TS, updateInstructions: [{ index: 1, title: 'mid' }] });
    const sent = (mockPatch.mock.calls[0][1] as { recipeInstructions: { title: string }[] }).recipeInstructions;
    expect(sent.map((s) => s.title)).toEqual(['', 'mid', '']);
  });
});

describe('delta updates', () => {
  it('updates text/title/summary and preserves omitted fields and note references', async () => {
    await updateRecipeInstructions('r', {
      expectedUpdatedAt: TS,
      updateInstructions: [{ index: 0, text: 'new', title: 'NT', summary: 'NS' }],
    });
    const sent = (mockPatch.mock.calls[0][1] as { recipeInstructions: Record<string, unknown>[] }).recipeInstructions;
    expect(sent[0]).toMatchObject({
      text: 'new',
      title: 'NT',
      summary: 'NS',
      ingredientReferences: [{ referenceId: ING_A }],
      noteReferences: [{ referenceId: NOTE }],
    });
    expect(sent[1].text).toBe('s1');
  });

  it('replaces and clears ingredient references', async () => {
    await updateRecipeInstructions('r', {
      expectedUpdatedAt: TS,
      updateInstructions: [
        { index: 0, ingredientReferenceIds: [ING_B] },
        { index: 1, ingredientReferenceIds: [] },
      ],
    });
    const sent = (mockPatch.mock.calls[0][1] as { recipeInstructions: Record<string, unknown>[] }).recipeInstructions;
    expect(sent[0].ingredientReferences).toEqual([{ referenceId: ING_B }]);
    expect(sent[1].ingredientReferences).toEqual([]);
  });

  it('keeps untouched and omitted-ref dangling references', async () => {
    await updateRecipeInstructions('r', { expectedUpdatedAt: TS, updateInstructions: [{ index: 1, text: 'edited' }] });
    const sent = (mockPatch.mock.calls[0][1] as { recipeInstructions: Record<string, unknown>[] }).recipeInstructions;
    expect(sent[1].ingredientReferences).toEqual([{ referenceId: DANGLING }]);
  });

  it('removes by original index', async () => {
    await updateRecipeInstructions('r', { expectedUpdatedAt: TS, removeInstructionIndexes: [0, 2] });
    expect(sentTexts()).toEqual(['s1']);
  });

  it('adds before, after, and appended; shared anchors keep input order', async () => {
    await updateRecipeInstructions('r', {
      expectedUpdatedAt: TS,
      addInstructions: [
        { text: 'b1', insertBeforeIndex: 1 },
        { text: 'b2', insertBeforeIndex: 1 },
        { text: 'a0', insertAfterIndex: 0 + 2 },
        { text: 'end1' },
        { text: 'end2' },
      ],
    });
    expect(sentTexts()).toEqual(['s0', 'b1', 'b2', 's1', 's2', 'a0', 'end1', 'end2']);
  });

  it('produces deterministic order for mixed add/update/remove against the original snapshot', async () => {
    await updateRecipeInstructions('r', {
      expectedUpdatedAt: TS,
      removeInstructionIndexes: [1],
      updateInstructions: [{ index: 2, text: 'S2' }],
      addInstructions: [{ text: 'x', insertAfterIndex: 0 }, { text: 'y', insertBeforeIndex: 2 }],
    });
    // after 0 and before 2 are opposite anchors on different gaps (1 and 2): fine.
    expect(sentTexts()).toEqual(['s0', 'x', 'y', 'S2']);
  });

  it.each([
    ['update/remove overlap', { updateInstructions: [{ index: 1, text: 'x' }], removeInstructionIndexes: [1] }, /both updated and removed/],
    ['duplicate removal', { removeInstructionIndexes: [1, 1] }, /duplicate/],
    ['duplicate update', { updateInstructions: [{ index: 1, text: 'a' }, { index: 1, text: 'b' }] }, /more than once/],
    ['out of range', { removeInstructionIndexes: [7] }, /does not exist/],
    ['anchor to removed', { removeInstructionIndexes: [1], addInstructions: [{ text: 'x', insertAfterIndex: 1 }] }, /being removed/],
    ['both anchors', { addInstructions: [{ text: 'x', insertAfterIndex: 0, insertBeforeIndex: 1 }] }, /not both/],
    ['opposite anchors same gap', { addInstructions: [{ text: 'x', insertAfterIndex: 0 }, { text: 'y', insertBeforeIndex: 1 }] }, /ambiguous/],
    ['new instruction without text', { addInstructions: [{ text: ' ' }] }, /text is required/],
  ])('rejects %s before any write', async (_name, delta, message) => {
    await expect(updateRecipeInstructions('r', { expectedUpdatedAt: TS, ...delta })).rejects.toThrow(message);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe('ingredient references', () => {
  it('accepts a known referenceId on an addition', async () => {
    await updateRecipeInstructions('r', { expectedUpdatedAt: TS, addInstructions: [{ text: 'x', ingredientReferenceIds: [ING_A] }] });
    const sent = (mockPatch.mock.calls[0][1] as { recipeInstructions: Record<string, unknown>[] }).recipeInstructions;
    expect(sent[3].ingredientReferences).toEqual([{ referenceId: ING_A }]);
    expect(sent[3].noteReferences).toEqual([]);
  });

  it('rejects unknown, duplicate and malformed ids before write', async () => {
    for (const ids of [[DANGLING], [ING_A, ING_A.toUpperCase()], ['nope']]) {
      await expect(
        updateRecipeInstructions('r', { expectedUpdatedAt: TS, updateInstructions: [{ index: 0, ingredientReferenceIds: ids }] }),
      ).rejects.toThrow(/ingredientReferenceId|duplicate/);
    }
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe('replacement form', () => {
  it('replaces with the complete ordered list and round-trips title/summary/refs/notes', async () => {
    const result = await updateRecipeInstructions('r', {
      expectedUpdatedAt: TS,
      instructions: [
        { text: 'b', title: 'T', summary: 'S', ingredientReferenceIds: [ING_B], noteReferenceIds: [NOTE] },
        { text: 'a' },
      ],
    });
    const sent = (mockPatch.mock.calls[0][1] as { recipeInstructions: Record<string, unknown>[] }).recipeInstructions;
    expect(sent[0]).toMatchObject({
      text: 'b',
      title: 'T',
      summary: 'S',
      ingredientReferences: [{ referenceId: ING_B }],
      noteReferences: [{ referenceId: NOTE }],
    });
    expect((result.recipeInstructions as unknown[]).length).toBe(2);
  });

  it('empty replacement clears instructions', async () => {
    await updateRecipeInstructions('r', { expectedUpdatedAt: TS, instructions: [] });
    expect(mockPatch.mock.calls[0][1]).toEqual({ recipeInstructions: [] });
  });

  it('cannot be mixed with delta fields or be empty of operations', async () => {
    await expect(
      updateRecipeInstructions('r', { expectedUpdatedAt: TS, instructions: [], removeInstructionIndexes: [0] }),
    ).rejects.toThrow(/not both/);
    await expect(updateRecipeInstructions('r', { expectedUpdatedAt: TS })).rejects.toThrow(/Provide instructions/);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe('no-op suppression', () => {
  it('skips PATCH for a delta that computes to identical state and returns the current recipe', async () => {
    const result = await updateRecipeInstructions('r', {
      expectedUpdatedAt: TS,
      updateInstructions: [{ index: 1, title: 'T1' }],
    });
    expect(mockPatch).not.toHaveBeenCalled();
    expect(result.updatedAt).toBe(TS);
    expect((result.recipeInstructions as { id: string }[])[0].id).toBe('id-s0');
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('skips PATCH for an identical complete replacement (including note refs)', async () => {
    mockGet.mockResolvedValue(makeRecipe([step('a', { ingredientReferences: [{ referenceId: ING_A }], noteReferences: [{ referenceId: NOTE }] }), step('b')]));
    const result = await updateRecipeInstructions('r', {
      expectedUpdatedAt: TS,
      instructions: [{ text: 'a', ingredientReferenceIds: [ING_A], noteReferenceIds: [NOTE] }, { text: 'b' }],
    });
    expect(mockPatch).not.toHaveBeenCalled();
    expect(result.updatedAt).toBe(TS);

    // Dropping a stored (dangling) reference is a real change in replacement mode.
    await updateRecipeInstructions('r', {
      expectedUpdatedAt: TS,
      instructions: [{ text: 'a', ingredientReferenceIds: [ING_A] }, { text: 'b' }],
    });
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });
});

describe('verification and rollback', () => {
  it('ignores regenerated ids on success', async () => {
    const result = await updateRecipeInstructions('r', { expectedUpdatedAt: TS, removeInstructionIndexes: [2] });
    expect((result.recipeInstructions as { id: string }[])[0].id).toBe('new-0');
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it('fails verification on mismatch and rolls back to the original, verified canonically', async () => {
    mockPatch
      .mockResolvedValueOnce(makeRecipe([step('wrong')], 'later'))
      .mockResolvedValueOnce(makeRecipe(BASE().map((s, i) => ({ ...s, id: `r-${i}` })), 'later2'));
    const error = await caught(updateRecipeInstructions('r', { expectedUpdatedAt: TS, removeInstructionIndexes: [2] }));
    expect(error).toBeInstanceOf(InstructionVerificationError);
    expect(error.rollbackSucceeded).toBe(true);
    expect(mockPatch).toHaveBeenCalledTimes(2);
    const rollback = (mockPatch.mock.calls[1][1] as { recipeInstructions: Record<string, unknown>[] }).recipeInstructions;
    expect(rollback.map((s) => s.text)).toEqual(['s0', 's1', 's2']);
    expect(rollback[0].noteReferences).toEqual([{ referenceId: NOTE }]);
    expect(rollback[1].ingredientReferences).toEqual([{ referenceId: DANGLING }]);
  });

  it('detects mismatched title/summary/reference state', async () => {
    mockPatch.mockResolvedValueOnce(makeRecipe(BASE().slice(0, 2).map((s) => ({ ...s, title: 'bad' })))).mockRejectedValueOnce(new Error('rb down'));
    const error = await caught(updateRecipeInstructions('r', { expectedUpdatedAt: TS, removeInstructionIndexes: [2] }));
    expect(error).toBeInstanceOf(InstructionVerificationError);
  });

  it('surfaces a failed rollback distinctly', async () => {
    mockPatch.mockResolvedValueOnce(makeRecipe([])).mockRejectedValueOnce(new Error('rollback boom'));
    const error = await caught(updateRecipeInstructions('r', { expectedUpdatedAt: TS, removeInstructionIndexes: [2] }));
    expect(error.rollbackSucceeded).toBe(false);
    expect(error.rollbackError).toBe('rollback boom');
    expect(error.message).toMatch(/ALSO failed/);
  });

  it('treats a rollback whose response does not match the original as failed', async () => {
    mockPatch.mockResolvedValueOnce(makeRecipe([])).mockResolvedValueOnce(makeRecipe([step('zzz')]));
    const error = await caught(updateRecipeInstructions('r', { expectedUpdatedAt: TS, removeInstructionIndexes: [2] }));
    expect(error.rollbackSucceeded).toBe(false);
  });
});

describe('updateRecipeInstructionsBatch', () => {
  it('isolates stale, invalid, API-failure and success entries and keeps input order', async () => {
    mockGet.mockImplementation((slug: string) => {
      if (slug === 'missing') return Promise.reject(new MealieApiError(404, 'Not Found'));
      return Promise.resolve({ ...makeRecipe(BASE()), slug });
    });
    const result = await updateRecipeInstructionsBatch([
      { slug: 'ok', expectedUpdatedAt: TS, removeInstructionIndexes: [2] },
      { slug: 'stale', expectedUpdatedAt: 'old', removeInstructionIndexes: [2] },
      { slug: 'bad', expectedUpdatedAt: TS, removeInstructionIndexes: [9] },
      { slug: 'missing', expectedUpdatedAt: TS, removeInstructionIndexes: [0] },
      { slug: 'noop', expectedUpdatedAt: TS, updateInstructions: [{ index: 2, text: 's2' }] },
    ]);
    expect(result.requestedCount).toBe(5);
    expect(result.results.map((r) => r.slug)).toEqual(['ok', 'stale', 'bad', 'missing', 'noop']);
    expect(result.results.map((r) => r.success)).toEqual([true, false, false, false, true]);
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(3);
    const stale = result.results[1];
    expect(stale.success === false && stale.error.stale).toBe(true);
    const missing = result.results[3];
    expect(missing.success === false && missing.error.status).toBe(404);
    // ok: GET+PATCH; stale/bad/noop: one GET each; the rejected GET for 'missing' is still counted as an attempted request
    expect(result.apiRequestCount).toBe(6);
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it('rolls back only the failing recipe', async () => {
    mockGet.mockImplementation((slug: string) => Promise.resolve({ ...makeRecipe(BASE()), slug }));
    mockPatch.mockImplementation((slug: string, data: unknown) => {
      if (slug === 'bad') return Promise.resolve(makeRecipe([step('wrong')]));
      const steps = (data as { recipeInstructions: Record<string, unknown>[] }).recipeInstructions;
      return Promise.resolve({ ...makeRecipe(steps.map((s, i) => ({ ...s, id: `n${i}` }))), slug });
    });
    const result = await updateRecipeInstructionsBatch([
      { slug: 'bad', expectedUpdatedAt: TS, removeInstructionIndexes: [2] },
      { slug: 'good', expectedUpdatedAt: TS, removeInstructionIndexes: [2] },
    ]);
    expect(result.results[0].success).toBe(false);
    expect(result.results[1].success).toBe(true);
    const rollbackCalls = mockPatch.mock.calls.filter((c) => c[0] === 'bad');
    expect(rollbackCalls).toHaveLength(2);
    expect(mockPatch.mock.calls.filter((c) => c[0] === 'good')).toHaveLength(1);
  });

  it('rejects batch-shape errors before any write', async () => {
    const entry = (slug: string) => ({ slug, expectedUpdatedAt: TS, removeInstructionIndexes: [0] });
    await expect(updateRecipeInstructionsBatch([])).rejects.toThrow(RecipeInstructionsBatchValidationError);
    await expect(
      updateRecipeInstructionsBatch(Array.from({ length: RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE + 1 }, (_, i) => entry(`s${i}`))),
    ).rejects.toThrow(/At most/);
    await expect(updateRecipeInstructionsBatch([entry(' ')])).rejects.toThrow(/slug/);
    await expect(updateRecipeInstructionsBatch([entry('a'), entry('a')])).rejects.toThrow(/Duplicate/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

import * as recipesApi from '../api/recipes.js';
import { MealieApiError } from '../api/client.js';
import { mapWithConcurrency } from './concurrency.js';

// ── Instruction identity ────────────────────────────────────────────────────
//
// Mealie regenerates recipeInstructions[].id on every recipe PATCH/PUT (see ARCHITECTURE.md), so
// instruction database IDs are never a valid mutation identity and are neither accepted nor
// returned as one here. Instead every mutation is guarded by the recipe's own `updatedAt` token
// (`expectedUpdatedAt`, exactly as the caller read it) and addresses instructions by their
// zero-based index in that exact snapshot. The writer GETs the recipe, rejects a stale token before
// any write, builds the complete desired collection in memory, skips the write when it is
// canonically identical to the current one, and otherwise persists it in a single PATCH of
// recipeInstructions only. Post-write verification and rollback compare canonical content (text,
// title, summary, ingredient references, note references) and ignore instruction IDs entirely.

export interface RecipeInstructionInput {
  text: string;
  title?: string | null;
  summary?: string | null;
  /** Stable recipe-ingredient referenceIds this instruction uses. */
  ingredientReferenceIds?: string[];
  /**
   * Low-level preservation field for the complete-replacement form only: noteReferences to carry
   * over unchanged (from a prior read). Omitted means the instruction has no note references.
   */
  noteReferenceIds?: string[];
}

export interface RecipeInstructionAddInput extends RecipeInstructionInput {
  insertBeforeIndex?: number;
  insertAfterIndex?: number;
}

export interface RecipeInstructionUpdateInput {
  index: number;
  text?: string;
  title?: string | null;
  summary?: string | null;
  ingredientReferenceIds?: string[];
}

export interface RecipeInstructionDelta {
  addInstructions?: RecipeInstructionAddInput[];
  updateInstructions?: RecipeInstructionUpdateInput[];
  removeInstructionIndexes?: number[];
}

export interface RecipeInstructionsMutationInput extends RecipeInstructionDelta {
  expectedUpdatedAt: string;
  /** Replacement form: the complete desired ordered list. Cannot be combined with delta fields. */
  instructions?: RecipeInstructionInput[];
}

interface CanonicalInstruction {
  text: string;
  title: string;
  summary: string;
  ingredientReferenceIds: string[];
  noteReferenceIds: string[];
}

interface DraftInstruction {
  canonical: CanonicalInstruction;
  /** Payload sent to Mealie (never carries an instruction id). */
  payload: Record<string, unknown>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecordList(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : []).filter((v) => v && typeof v === 'object') as Record<string, unknown>[];
}

function refIds(value: unknown): string[] {
  return asRecordList(value)
    .map((ref) => (typeof ref.referenceId === 'string' ? ref.referenceId.toLowerCase() : ''))
    .filter((id) => id.length > 0);
}

function toCanonical(raw: Record<string, unknown>): CanonicalInstruction {
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    ingredientReferenceIds: refIds(raw.ingredientReferences).sort(),
    noteReferenceIds: refIds(raw.noteReferences).sort(),
  };
}

function canonicalList(value: unknown): CanonicalInstruction[] {
  return (Array.isArray(value) ? value : []).map((v) => toCanonical((v ?? {}) as Record<string, unknown>));
}

function firstDifference(expected: CanonicalInstruction[], actual: CanonicalInstruction[]): string | null {
  if (expected.length !== actual.length) {
    return `Expected ${expected.length} instruction(s) but Mealie persisted ${actual.length}.`;
  }
  for (let i = 0; i < expected.length; i++) {
    for (const field of ['text', 'title', 'summary'] as const) {
      if (expected[i][field] !== actual[i][field]) return `Instruction ${i} ${field} does not match the requested value.`;
    }
    if (expected[i].ingredientReferenceIds.join(',') !== actual[i].ingredientReferenceIds.join(',')) {
      return `Instruction ${i} ingredient references do not match the requested value.`;
    }
    if (expected[i].noteReferenceIds.join(',') !== actual[i].noteReferenceIds.join(',')) {
      return `Instruction ${i} note references do not match the expected value.`;
    }
  }
  return null;
}

function withoutId(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'id'));
}

function buildPayload(base: Record<string, unknown>, c: CanonicalInstruction, refs: { ingredient?: string[]; note?: string[] }) {
  return {
    ...base,
    text: c.text,
    title: c.title,
    summary: c.summary,
    ...(refs.ingredient ? { ingredientReferences: refs.ingredient.map((referenceId) => ({ referenceId })) } : {}),
    ...(refs.note ? { noteReferences: refs.note.map((referenceId) => ({ referenceId })) } : {}),
  };
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when the caller's expectedUpdatedAt no longer matches the recipe. Nothing was written. */
export class StaleInstructionSnapshotError extends Error {
  constructor(slug: string, expected: string, actual: unknown) {
    super(
      `Stale snapshot for recipe '${slug}': expectedUpdatedAt '${expected}' does not match the recipe's current ` +
        `updatedAt '${String(actual)}'. Nothing was written. Re-read the recipe with get_recipe_detailed and retry ` +
        'from the new snapshot (instruction indexes and ingredient referenceIds may have changed).',
    );
    this.name = 'StaleInstructionSnapshotError';
  }
}

/**
 * Thrown when the recipe Mealie returned from the write does not match the desired canonical
 * instruction collection. `rollbackSucceeded` reports whether the original instructions were
 * restored (verified canonically, ignoring instruction ids).
 */
export class InstructionVerificationError extends Error {
  constructor(
    message: string,
    public readonly rollbackSucceeded: boolean,
    public readonly rollbackError?: string,
  ) {
    super(message);
    this.name = 'InstructionVerificationError';
  }
}

// ── Planning / validation ───────────────────────────────────────────────────

type InstructionPlan =
  | { kind: 'replace'; instructions: RecipeInstructionInput[] }
  | { kind: 'delta'; delta: RecipeInstructionDelta };

function planFromInput(input: RecipeInstructionsMutationInput): InstructionPlan {
  const { instructions, addInstructions, updateInstructions, removeInstructionIndexes } = input;
  const hasDelta = addInstructions !== undefined || updateInstructions !== undefined || removeInstructionIndexes !== undefined;

  if (instructions !== undefined && hasDelta) {
    throw new Error(
      'Use either instructions (complete replacement) or the delta fields ' +
        '(addInstructions/updateInstructions/removeInstructionIndexes), not both.',
    );
  }
  if (instructions !== undefined) return { kind: 'replace', instructions };
  if (!hasDelta) {
    throw new Error(
      'Provide instructions (complete replacement) or at least one of addInstructions, updateInstructions, ' +
        'removeInstructionIndexes.',
    );
  }
  const total = (addInstructions?.length ?? 0) + (updateInstructions?.length ?? 0) + (removeInstructionIndexes?.length ?? 0);
  if (total === 0) {
    throw new Error('The delta contains no operations — supply at least one add, update, or removal.');
  }
  return { kind: 'delta', delta: { addInstructions, updateInstructions, removeInstructionIndexes } };
}

function checkExpectedUpdatedAt(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('expectedUpdatedAt is required — pass the exact updatedAt from a prior get_recipe_detailed.');
  }
  return value;
}

// Validates an explicitly supplied ingredientReferenceIds collection; returns normalized ids.
function validateIngredientRefs(ids: string[], known: Set<string>, what: string, problems: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      problems.push(`${what}: ingredientReferenceId '${String(id)}' is not a valid UUID.`);
      continue;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      problems.push(`${what}: duplicate ingredientReferenceId '${id}'.`);
      continue;
    }
    seen.add(key);
    if (!known.has(key)) {
      problems.push(
        `${what}: ingredientReferenceId '${id}' does not exist on the recipe's current ingredients. Re-read the ` +
          'recipe with get_recipe_detailed and use its current referenceIds.',
      );
      continue;
    }
    out.push(key);
  }
  return out;
}

function newDraft(input: RecipeInstructionInput, known: Set<string>, what: string, problems: string[], allowNotes: boolean): DraftInstruction | null {
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    problems.push(`${what}: text is required and must not be blank.`);
    return null;
  }
  const ingredient = validateIngredientRefs(input.ingredientReferenceIds ?? [], known, what, problems);
  const note: string[] = [];
  if (allowNotes) {
    for (const id of input.noteReferenceIds ?? []) {
      if (typeof id !== 'string' || !UUID_PATTERN.test(id)) problems.push(`${what}: noteReferenceId '${String(id)}' is not a valid UUID.`);
      else note.push(id.toLowerCase());
    }
  }
  const canonical: CanonicalInstruction = {
    text: input.text,
    title: input.title ?? '',
    summary: input.summary ?? '',
    ingredientReferenceIds: [...ingredient].sort(),
    noteReferenceIds: [...note].sort(),
  };
  return { canonical, payload: buildPayload({}, canonical, { ingredient, note }) };
}

function checkIndex(value: unknown, length: number, what: string, problems: string[]): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= length) {
    problems.push(`${what}: index ${String(value)} does not exist (recipe has ${length} instruction(s), valid indexes 0-${length - 1}).`);
    return false;
  }
  return true;
}

function buildReplacement(instructions: RecipeInstructionInput[], known: Set<string>): DraftInstruction[] {
  const problems: string[] = [];
  const drafts: DraftInstruction[] = [];
  instructions.forEach((instruction, i) => {
    const draft = newDraft(instruction, known, `instructions[${i}]`, problems, true);
    if (draft) drafts.push(draft);
  });
  if (problems.length > 0) throw new Error(`Invalid instruction request, nothing was written: ${problems.join(' ')}`);
  return drafts;
}

function buildDelta(current: Record<string, unknown>[], delta: RecipeInstructionDelta, known: Set<string>): DraftInstruction[] {
  const n = current.length;
  const problems: string[] = [];

  const removed = new Set<number>();
  for (const index of delta.removeInstructionIndexes ?? []) {
    if (!checkIndex(index, n, 'Removal', problems)) continue;
    if (removed.has(index)) problems.push(`Removal: duplicate index ${index}.`);
    removed.add(index);
  }

  const updates = new Map<number, RecipeInstructionUpdateInput>();
  for (const update of delta.updateInstructions ?? []) {
    const what = `Update of index ${String(update.index)}`;
    if (!checkIndex(update.index, n, what, problems)) continue;
    if (updates.has(update.index)) problems.push(`${what}: index appears more than once in updateInstructions.`);
    if (removed.has(update.index)) problems.push(`${what}: instruction is both updated and removed.`);
    if (update.text !== undefined && update.text.trim().length === 0) problems.push(`${what}: text must not be blank.`);
    if (
      update.text === undefined &&
      update.title === undefined &&
      update.summary === undefined &&
      update.ingredientReferenceIds === undefined
    ) {
      problems.push(`${what}: changes no fields.`);
    }
    if (update.ingredientReferenceIds !== undefined) validateIngredientRefs(update.ingredientReferenceIds, known, what, problems);
    updates.set(update.index, update);
  }

  // Gap g sits directly before original index g (gap n is the end). insertBefore(i) → gap i,
  // insertAfter(i) → gap i+1. Two directions landing in one gap are ambiguous.
  const gaps = new Map<number, { directions: Set<string>; drafts: DraftInstruction[] }>();
  const appended: DraftInstruction[] = [];
  (delta.addInstructions ?? []).forEach((add, i) => {
    const what = `Addition ${i}`;
    const { insertBeforeIndex, insertAfterIndex, ...content } = add;
    const draft = newDraft(content, known, what, problems, false);
    if (insertBeforeIndex !== undefined && insertAfterIndex !== undefined) {
      problems.push(`${what}: set insertBeforeIndex or insertAfterIndex, not both.`);
      return;
    }
    const anchor = insertBeforeIndex ?? insertAfterIndex;
    if (anchor === undefined) {
      if (draft) appended.push(draft);
      return;
    }
    if (!checkIndex(anchor, n, `${what} anchor`, problems)) return;
    if (removed.has(anchor)) {
      problems.push(`${what}: anchored to index ${anchor}, which is being removed.`);
      return;
    }
    if (!draft) return;
    const gap = insertBeforeIndex !== undefined ? anchor : anchor + 1;
    const entry = gaps.get(gap) ?? { directions: new Set<string>(), drafts: [] };
    entry.directions.add(insertBeforeIndex !== undefined ? 'before' : 'after');
    entry.drafts.push(draft);
    gaps.set(gap, entry);
  });
  for (const [gap, entry] of gaps) {
    if (entry.directions.size > 1) {
      problems.push(
        `Additions target the same gap (between instruction ${gap - 1} and ${gap}) through opposite anchors ` +
          '(insertAfterIndex and insertBeforeIndex) — ambiguous; use one direction.',
      );
    }
  }

  if (problems.length > 0) throw new Error(`Invalid instruction request, nothing was written: ${problems.join(' ')}`);

  const result: DraftInstruction[] = [];
  for (let g = 0; g <= n; g++) {
    result.push(...(gaps.get(g)?.drafts ?? []));
    if (g === n || removed.has(g)) continue;
    const raw = current[g];
    const update = updates.get(g);
    if (!update) {
      result.push({ canonical: toCanonical(raw), payload: withoutId(raw) });
      continue;
    }
    const base = toCanonical(raw);
    const canonical: CanonicalInstruction = {
      ...base,
      text: update.text ?? base.text,
      title: update.title === undefined ? base.title : (update.title ?? ''),
      summary: update.summary === undefined ? base.summary : (update.summary ?? ''),
      ingredientReferenceIds:
        update.ingredientReferenceIds === undefined
          ? base.ingredientReferenceIds
          : update.ingredientReferenceIds.map((id) => id.toLowerCase()).sort(),
    };
    // Omitted ingredientReferences stay exactly as stored (dangling ones included); noteReferences
    // always stay exactly as stored.
    result.push({
      canonical,
      payload: buildPayload(withoutId(raw), canonical, {
        ingredient: update.ingredientReferenceIds === undefined ? undefined : update.ingredientReferenceIds.map((id) => id.toLowerCase()),
      }),
    });
  }
  result.push(...appended);
  return result;
}

// ── Writer ──────────────────────────────────────────────────────────────────

function attachRequestCount(error: unknown, requestCount: number): void {
  if (error && typeof error === 'object') (error as { requestCount?: number }).requestCount = requestCount;
}

interface InstructionWriteResult {
  recipe: Record<string, unknown>;
  requestCount: number;
  instructionCount: number;
  /** False when the desired collection equalled the current one and no write was made. */
  changed: boolean;
}

async function writeVerifiedInstructions(slug: string, input: RecipeInstructionsMutationInput): Promise<InstructionWriteResult> {
  let requestCount = 0;
  let original: Record<string, unknown>;
  let updated: Record<string, unknown>;
  let desired: DraftInstruction[];
  try {
    const expectedUpdatedAt = checkExpectedUpdatedAt(input.expectedUpdatedAt);
    const plan = planFromInput(input);
    requestCount += 1;
    original = await recipesApi.getRecipe(slug);
    if (original.updatedAt !== expectedUpdatedAt) throw new StaleInstructionSnapshotError(slug, expectedUpdatedAt, original.updatedAt);

    const known = new Set(refIds(original.recipeIngredient));
    const current = asRecordList(original.recipeInstructions);
    desired = plan.kind === 'replace' ? buildReplacement(plan.instructions, known) : buildDelta(current, plan.delta, known);

    const desiredCanonical = desired.map((d) => d.canonical);
    if (firstDifference(desiredCanonical, canonicalList(current)) === null) {
      return { recipe: original, requestCount, instructionCount: desired.length, changed: false };
    }

    requestCount += 1;
    updated = await recipesApi.patchRecipe(slug, { recipeInstructions: desired.map((d) => d.payload) });
  } catch (error) {
    attachRequestCount(error, requestCount);
    throw error;
  }

  const failureReason = firstDifference(
    desired.map((d) => d.canonical),
    canonicalList(updated.recipeInstructions),
  );
  if (!failureReason) return { recipe: updated, requestCount, instructionCount: desired.length, changed: true };

  const originalInstructions = asRecordList(original.recipeInstructions);
  let rollbackFailure: string | null = null;
  requestCount += 1;
  try {
    const restored = await recipesApi.patchRecipe(slug, { recipeInstructions: originalInstructions.map(withoutId) });
    const mismatch = firstDifference(canonicalList(originalInstructions), canonicalList(restored.recipeInstructions));
    if (mismatch) rollbackFailure = `Mealie's response after rollback did not match the original instructions: ${mismatch}`;
  } catch (rollbackError) {
    rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
  }

  const error = rollbackFailure
    ? new InstructionVerificationError(
        `Instruction verification failed after Mealie update: ${failureReason} Rollback to the original ` +
          `instructions ALSO failed (${rollbackFailure}) — recipe state may require manual inspection.`,
        false,
        rollbackFailure,
      )
    : new InstructionVerificationError(
        `Instruction verification failed after Mealie update: ${failureReason} Original instructions were ` +
          'restored successfully (instruction ids were regenerated, which is expected).',
        true,
      );
  attachRequestCount(error, requestCount);
  throw error;
}

/**
 * Updates a recipe's instructions by complete replacement (`instructions`) or by index-keyed delta
 * (addInstructions/updateInstructions/removeInstructionIndexes), guarded by `expectedUpdatedAt`.
 * Returns the resulting recipe (the already-fetched recipe for a no-op).
 */
export async function updateRecipeInstructions(
  slug: string,
  input: RecipeInstructionsMutationInput,
): Promise<Record<string, unknown>> {
  const { recipe } = await writeVerifiedInstructions(slug, input);
  return recipe;
}

// ── Batch layer ─────────────────────────────────────────────────────────────

export const RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE = 25;
const BATCH_CONCURRENCY = 5;

export interface RecipeInstructionsBatchUpdate extends RecipeInstructionsMutationInput {
  slug: string;
}

export interface RecipeInstructionsBatchError {
  message: string;
  status?: number;
  /** True when the failure was a stale expectedUpdatedAt (nothing was written). */
  stale?: boolean;
  rollbackSucceeded?: boolean;
  rollbackError?: string;
}

export type RecipeInstructionsBatchResultItem =
  | { slug: string; success: true; instructionCount: number; changed: boolean }
  | { slug: string; success: false; error: RecipeInstructionsBatchError };

export interface RecipeInstructionsBatchResult {
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  results: RecipeInstructionsBatchResultItem[];
  apiRequestCount: number;
}

export class RecipeInstructionsBatchValidationError extends Error {}

function validateBatch(updates: RecipeInstructionsBatchUpdate[]): void {
  if (updates.length === 0) throw new RecipeInstructionsBatchValidationError('At least one recipe update is required.');
  if (updates.length > RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE) {
    throw new RecipeInstructionsBatchValidationError(
      `At most ${RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE} recipes are allowed per batch call (got ${updates.length}).`,
    );
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const update of updates) {
    const slug = update.slug?.trim();
    if (!slug) throw new RecipeInstructionsBatchValidationError('Each update must include a non-empty recipe slug.');
    if (seen.has(slug)) duplicates.add(slug);
    seen.add(slug);
  }
  if (duplicates.size > 0) {
    throw new RecipeInstructionsBatchValidationError(
      `Duplicate recipe slug(s) in the same batch call: ${[...duplicates].join(', ')}. ` +
        'Each recipe may appear at most once per batch — submit a second call for a repeat update.',
    );
  }
}

function toBatchError(error: unknown): RecipeInstructionsBatchError {
  if (error instanceof InstructionVerificationError) {
    return {
      message: error.message,
      rollbackSucceeded: error.rollbackSucceeded,
      ...(error.rollbackError !== undefined ? { rollbackError: error.rollbackError } : {}),
    };
  }
  if (error instanceof StaleInstructionSnapshotError) return { message: error.message, stale: true };
  if (error instanceof MealieApiError) return { message: error.message, status: error.status };
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * Applies updateRecipeInstructions to several recipes with bounded concurrency, in input order.
 * Each entry has its own expectedUpdatedAt and is validated, written, verified and rolled back
 * independently — there is no cross-recipe transaction.
 */
export async function updateRecipeInstructionsBatch(
  updates: RecipeInstructionsBatchUpdate[],
): Promise<RecipeInstructionsBatchResult> {
  validateBatch(updates);

  const requestCounts = new Array<number>(updates.length).fill(0);
  const results = await mapWithConcurrency<RecipeInstructionsBatchUpdate, RecipeInstructionsBatchResultItem>(
    updates,
    BATCH_CONCURRENCY,
    async (update, index) => {
      try {
        const { slug, ...input } = update;
        const { requestCount, instructionCount, changed } = await writeVerifiedInstructions(slug, input);
        requestCounts[index] = requestCount;
        return { slug, success: true, instructionCount, changed };
      } catch (error) {
        requestCounts[index] = (error as { requestCount?: number } | null)?.requestCount ?? 0;
        return { slug: update.slug, success: false, error: toBatchError(error) };
      }
    },
  );

  const succeededCount = results.filter((r) => r.success).length;
  return {
    requestedCount: updates.length,
    succeededCount,
    failedCount: updates.length - succeededCount,
    results,
    apiRequestCount: requestCounts.reduce((sum, c) => sum + c, 0),
  };
}

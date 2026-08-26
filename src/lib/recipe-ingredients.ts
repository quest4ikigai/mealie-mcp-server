import * as recipesApi from '../api/recipes.js';
import { MealieApiError } from '../api/client.js';
import { mapWithConcurrency } from './concurrency.js';

export interface RecipeIngredientInput {
  quantity?: number | null;
  unitId?: string;
  unitName?: string;
  foodId?: string;
  foodName?: string;
  note?: string | null;
  display?: string;
  originalText?: string | null;
  title?: string | null;
  referenceId?: string;
}

function requirePairedField(idValue: string | undefined, nameValue: string | undefined, idLabel: string, nameLabel: string): void {
  const id = idValue?.trim();
  const name = nameValue?.trim();
  if (id && !name) {
    throw new Error(`${idLabel} was given without ${nameLabel} — both are required to reference an existing ${idLabel === 'foodId' ? 'food' : 'unit'}.`);
  }
  if (!id && name) {
    throw new Error(`${nameLabel} was given without ${idLabel} — both are required to reference an existing ${idLabel === 'foodId' ? 'food' : 'unit'}.`);
  }
}

// Mealie's RecipeIngredient.food/unit are embedded objects, not flat foreign keys, but the
// recipe_ingredients table only stores food_id/unit_id — providing {id, name} is enough to
// resolve the relationship without touching the shared food/unit row's other stored fields
// (the same minimal-object convention already used for recipeCategory/tags elsewhere in this
// codebase). Only id+name together are sent, never a bare name, so Mealie never has enough to
// silently inline-create a new food/unit for an unresolved reference.
function toMealieIngredient(input: RecipeIngredientInput): Record<string, unknown> {
  requirePairedField(input.foodId, input.foodName, 'foodId', 'foodName');
  requirePairedField(input.unitId, input.unitName, 'unitId', 'unitName');

  const foodId = input.foodId?.trim();
  const foodName = input.foodName?.trim();
  const unitId = input.unitId?.trim();
  const unitName = input.unitName?.trim();

  const payload: Record<string, unknown> = {
    food: foodId && foodName ? { id: foodId, name: foodName } : null,
    unit: unitId && unitName ? { id: unitId, name: unitName } : null,
  };

  if (input.quantity !== undefined) payload.quantity = input.quantity;
  if (input.note !== undefined) payload.note = input.note;
  if (input.display !== undefined) payload.display = input.display;
  if (input.originalText !== undefined) payload.originalText = input.originalText;
  if (input.title !== undefined) payload.title = input.title;
  if (input.referenceId !== undefined) payload.referenceId = input.referenceId;

  return payload;
}

// ── Post-write integrity verification ───────────────────────────────────────
//
// Live testing against a real Mealie instance found that Mealie can *accept* a syntactically
// valid but nonexistent food/unit UUID and silently persist the ingredient with food/unit set to
// null, or — worse — accept a valid UUID paired with the wrong human-readable name and persist the
// UUID's actual entity while discarding the supplied name entirely. Both cases previously came
// back from this writer as a plain success, so a hallucinated/stale/mismatched id could silently
// turn a structured ingredient into an unparsed one, or point it at the wrong food, with no
// indication anything went wrong.
//
// Pre-validating every foodId/unitId against Mealie before writing would add a GET per referenced
// food/unit to every write, which defeats the point of doing structured writes in bulk. Instead,
// this verifies the recipe object Mealie already hands back from the write itself — no extra
// request on the successful path. Verification is deterministic and intentionally narrow: it
// checks that the ingredient count is preserved and that any requested food/unit *association*
// (id + name) survived, but it never diffs the full recipe payload and never touches
// Mealie-normalized presentation fields (display, formatting, etc.).

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

// Canonical name + pluralName (+ abbreviation/pluralAbbreviation for units) covers the
// deterministic identifiers Mealie's own food/unit search already treats as equivalent (see
// get_food_matches/get_unit_matches). Stored `aliases` are included too, since the returned
// food/unit entity already carries them at no extra request cost — but nothing beyond those
// stored fields is considered; this is plain case-insensitive string equality, never fuzzy or
// semantic matching.
function collectEntityNames(entity: Record<string, unknown>, scalarFields: string[]): string[] {
  const names: string[] = [];
  for (const field of scalarFields) {
    const value = entity[field];
    if (typeof value === 'string' && value.trim().length > 0) names.push(value);
  }
  const aliases = Array.isArray(entity.aliases) ? (entity.aliases as { name?: unknown }[]) : [];
  for (const alias of aliases) {
    if (typeof alias?.name === 'string' && alias.name.trim().length > 0) names.push(alias.name);
  }
  return names;
}

function nameCompatible(entity: Record<string, unknown>, requestedName: string, scalarFields: string[]): boolean {
  const normalizedRequested = normalizeName(requestedName);
  return collectEntityNames(entity, scalarFields).some((name) => normalizeName(name) === normalizedRequested);
}

const FOOD_NAME_FIELDS = ['name', 'pluralName'];
const UNIT_NAME_FIELDS = ['name', 'pluralName', 'abbreviation', 'pluralAbbreviation'];

/**
 * Checks that `persisted` (the recipeIngredient collection Mealie returned from the write) still
 * carries every structured food/unit association that `requested` asked for. Requested and
 * persisted ingredients are paired positionally (index-for-index) — this writer always sends the
 * ingredient array as a complete ordered replacement, and nothing in current or past behavior
 * suggests Mealie reorders recipeIngredient rows on write, so positional pairing is the simplest
 * correct mapping without inventing a semantic matching strategy.
 *
 * Returns null when verification passes, or a human-readable reason for the first mismatch found.
 */
function verifyPersistedIngredients(requested: RecipeIngredientInput[], persisted: unknown): string | null {
  const persistedList = Array.isArray(persisted) ? (persisted as Record<string, unknown>[]) : [];

  if (persistedList.length !== requested.length) {
    return `Requested ${requested.length} ingredient(s) but Mealie persisted ${persistedList.length}.`;
  }

  for (let i = 0; i < requested.length; i++) {
    const req = requested[i];
    const persistedIngredient = persistedList[i] ?? {};

    // requirePairedField (via toMealieIngredient, already run before this check) guarantees
    // foodId/foodName and unitId/unitName are each either both present or both absent.
    const foodId = req.foodId?.trim();
    const foodName = req.foodName?.trim();
    if (foodId && foodName) {
      const food = persistedIngredient.food as Record<string, unknown> | null | undefined;
      if (!food) {
        return `Ingredient ${i} requested foodId '${foodId}' ('${foodName}'), but Mealie persisted no food association.`;
      }
      if (food.id !== foodId) {
        return `Ingredient ${i} requested foodId '${foodId}' with foodName '${foodName}', but Mealie persisted food '${String(food.id)}'.`;
      }
      if (!nameCompatible(food, foodName, FOOD_NAME_FIELDS)) {
        return `Ingredient ${i} requested foodId '${foodId}' with foodName '${foodName}', but Mealie persisted food '${food.id}' named '${String(food.name)}'.`;
      }
    }

    const unitId = req.unitId?.trim();
    const unitName = req.unitName?.trim();
    if (unitId && unitName) {
      const unit = persistedIngredient.unit as Record<string, unknown> | null | undefined;
      if (!unit) {
        return `Ingredient ${i} requested unitId '${unitId}' ('${unitName}'), but Mealie persisted no unit association.`;
      }
      if (unit.id !== unitId) {
        return `Ingredient ${i} requested unitId '${unitId}' with unitName '${unitName}', but Mealie persisted unit '${String(unit.id)}'.`;
      }
      if (!nameCompatible(unit, unitName, UNIT_NAME_FIELDS)) {
        return `Ingredient ${i} requested unitId '${unitId}' with unitName '${unitName}', but Mealie persisted unit '${unit.id}' named '${String(unit.name)}'.`;
      }
    }
  }

  return null;
}

/**
 * Thrown when the recipe Mealie returned from the write does not preserve a requested food/unit
 * association. `rollbackSucceeded` reports whether the pre-write recipe snapshot was successfully
 * restored; when it's false, `rollbackError` carries the restore attempt's own failure message and
 * the recipe may be left in a partially-written state requiring manual inspection.
 */
export class IngredientVerificationError extends Error {
  constructor(
    message: string,
    public readonly rollbackSucceeded: boolean,
    public readonly rollbackError?: string,
  ) {
    super(message);
    this.name = 'IngredientVerificationError';
  }
}

function attachRequestCount(error: unknown, requestCount: number): void {
  if (error && typeof error === 'object') {
    (error as { requestCount?: number }).requestCount = requestCount;
  }
}

interface IngredientWriteResult {
  recipe: Record<string, unknown>;
  /** Low-level Mealie API calls actually made — used by the batch layer to report accurate cost. */
  requestCount: number;
}

/**
 * Replaces a recipe's complete recipeIngredient collection via PATCH, not PUT. PATCH is still the
 * right choice — Mealie's generic repository patch() merges a partial payload onto a fresh full
 * snapshot of the entity and only then persists it, so unrelated *scalar* fields (name,
 * description, settings, nutrition, categories/tags, ...) are correctly left alone whether or not
 * they're in our request body.
 *
 * The recipe is fetched first so its pre-write recipeIngredient collection is available as a
 * rollback snapshot. Successful path cost is therefore 1 GET + 1 PATCH — no per-ingredient
 * food/unit lookups are ever made. The PATCH response is then checked against
 * verifyPersistedIngredients: if a requested food/unit association did not survive persistence,
 * this makes a best-effort attempt to PATCH the recipe back to its original recipeIngredient
 * collection and throws IngredientVerificationError either way, so a silently-corrupted write is
 * never reported as a success. A failed rollback is surfaced distinctly
 * (rollbackSucceeded: false) rather than hidden.
 *
 * IMPORTANT, confirmed by live testing against a real Mealie instance (both omitting
 * recipeInstructions from the request and explicitly echoing it back with matching ids):
 * recipeInstructions[].id (and likely other one-to-many child collections on Recipe) get
 * regenerated on EVERY recipe PUT or PATCH, regardless of payload shape. Root cause traced into
 * Mealie's own source: both routes funnel into RepositoryRecipes.update(), which calls
 * `entry.update(session=..., **new_data)`; BaseMixins.update() is defined as
 * `self.__init__(*args, **kwargs)` — it re-runs the SQLAlchemy model's constructor on the
 * already-persisted row, and recipe_instructions is declared with
 * cascade="all, delete-orphan", so every instruction row is deleted and recreated with a fresh id
 * as a side effect, even when the constructor is handed the exact same ids back. This is a
 * pre-existing Mealie limitation, not something this tool introduces or can avoid — it would
 * happen from any client, including Mealie's own UI. Instruction content (text/title/summary/
 * ingredientReferences) is preserved correctly; only the ids churn. A failed write followed by a
 * rollback PATCH means this churn can happen twice in a row for the same recipe.
 *
 * Known limitation: between the initial GET and the write, another actor could edit the same
 * recipe; a rollback in that window would restore the older snapshot this call read, not
 * necessarily the latest state. This is a pre-existing read-modify-write limitation of this
 * writer, not something this change introduces or attempts to solve (no optimistic
 * concurrency/versioning is implemented here).
 */

// Mealie's `recipe_ingredient.reference_id` column is nullable with no stored default (see
// mealie-recipes/mealie#7072 and its fix, PR #7139). For an ingredient row whose reference_id has
// never been explicitly, durably set, Mealie's own RecipeIngredient schema synthesizes a *fresh
// random UUID on every single read* (`value or uuid4()`) purely for that response — it is never
// written back to the database just by reading it. Two independent GETs of such a row can
// therefore legitimately return two different referenceId values.
//
// This matters here because our rollback snapshot (`original`, fetched by this writer's own GET)
// is necessarily a *different* read than whatever the caller's own earlier get_recipe_detailed
// call saw when it built its request — so for a never-pinned ingredient, `original`'s referenceId
// can differ from the caller's `requested` referenceId for that same row, even though neither read
// is "wrong". The write we just attempted (the one that failed overall verification) already
// carried the caller's own referenceId values through to Mealie and durably persisted them for
// every row Mealie accepted structurally — which is every row, since only the food/unit
// association can be silently dropped/misresolved, never the ingredient row itself. Blindly
// resending our own pre-write GET snapshot for rollback would overwrite that just-persisted,
// caller-intended value with an unrelated, arbitrary one for any row that was never pinned before.
//
// So: when building the rollback payload, prefer the *requested* ingredient's own referenceId at
// each position (it's what the caller actually asked for and what Mealie just durably persisted)
// and fall back to the pre-write snapshot's value only when the caller didn't supply one for that
// position. For every ingredient with an already-durable referenceId, both sources agree and this
// is a no-op. This is not "regenerating" anything — it's picking the more authoritative of two
// already-observed values, never inventing a new one.
function buildRollbackIngredients(
  requested: RecipeIngredientInput[],
  originalIngredients: unknown[],
): unknown[] {
  return originalIngredients.map((entry, i) => {
    if (!entry || typeof entry !== 'object') return entry;

    const requestedReferenceId = requested[i]?.referenceId?.trim();
    if (!requestedReferenceId) return entry;

    return { ...(entry as Record<string, unknown>), referenceId: requestedReferenceId };
  });
}

async function writeVerifiedIngredients(
  slug: string,
  ingredients: RecipeIngredientInput[],
): Promise<IngredientWriteResult> {
  const recipeIngredient = ingredients.map(toMealieIngredient);

  let requestCount = 0;
  let original: Record<string, unknown>;
  let updated: Record<string, unknown>;
  try {
    original = await recipesApi.getRecipe(slug);
    requestCount += 1;
    updated = await recipesApi.patchRecipe(slug, { recipeIngredient });
    requestCount += 1;
  } catch (error) {
    attachRequestCount(error, requestCount);
    throw error;
  }

  const failureReason = verifyPersistedIngredients(ingredients, updated.recipeIngredient);
  if (!failureReason) {
    return { recipe: updated, requestCount };
  }

  const originalIngredient = Array.isArray(original.recipeIngredient) ? original.recipeIngredient : [];
  const rollbackIngredient = buildRollbackIngredients(ingredients, originalIngredient);
  try {
    await recipesApi.patchRecipe(slug, { recipeIngredient: rollbackIngredient });
    requestCount += 1;
  } catch (rollbackError) {
    requestCount += 1;
    const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    const error = new IngredientVerificationError(
      `Structured ingredient verification failed after Mealie update: ${failureReason} Rollback to the ` +
        `original recipe ALSO failed (${rollbackMessage}) — recipe state may require manual inspection.`,
      false,
      rollbackMessage,
    );
    attachRequestCount(error, requestCount);
    throw error;
  }

  const error = new IngredientVerificationError(
    `Structured ingredient verification failed after Mealie update: ${failureReason} Original recipe was ` +
      'restored successfully.',
    true,
  );
  attachRequestCount(error, requestCount);
  throw error;
}

export async function updateRecipeIngredients(
  slug: string,
  ingredients: RecipeIngredientInput[],
): Promise<Record<string, unknown>> {
  const { recipe } = await writeVerifiedIngredients(slug, ingredients);
  return recipe;
}

// ── Batch layer ──────────────────────────────────────────────────────────────
//
// A narrow batching wrapper over updateRecipeIngredients above, added once a real pilot showed
// that once food/unit resolution is done in bulk (get_food_matches/get_unit_matches), one
// individual update_recipe_ingredients call per recipe becomes the dominant remaining
// model-to-MCP round trip. This layer performs no interpretation of its own — it never parses,
// matches, or creates anything — it only fans the same per-recipe write out with bounded
// concurrency and isolates each recipe's outcome so one failure never rolls back or blocks
// the rest of the batch (transient upstream 502s have been observed in real multi-recipe usage).
// Verification and rollback are inherited entirely from writeVerifiedIngredients — a verification
// failure only rolls back the one recipe it happened on; it never affects sibling recipes.

export const RECIPE_INGREDIENTS_BATCH_MAX_SIZE = 25;
const BATCH_CONCURRENCY = 5;

export interface RecipeIngredientsBatchUpdate {
  slug: string;
  ingredients: RecipeIngredientInput[];
}

export interface RecipeIngredientsBatchError {
  message: string;
  status?: number;
  /** Present only for a verification failure — whether the pre-write recipe was restored. */
  rollbackSucceeded?: boolean;
  /** Present only when rollbackSucceeded is false — the restore attempt's own failure message. */
  rollbackError?: string;
}

export type RecipeIngredientsBatchResultItem =
  | { slug: string; success: true; ingredientCount: number }
  | { slug: string; success: false; error: RecipeIngredientsBatchError };

export interface RecipeIngredientsBatchResult {
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  results: RecipeIngredientsBatchResultItem[];
  apiRequestCount: number;
}

/** Thrown for bad batch request shape (as opposed to a per-recipe runtime failure). */
export class RecipeIngredientsBatchValidationError extends Error {}

// Only structural issues that make the request as a whole impossible to interpret are validated
// here (empty/oversized batch, missing or duplicate slug). A malformed *ingredient* (e.g. a
// mismatched foodId/foodName pair, or one that fails post-write verification) is a problem with
// one recipe's payload, not the batch shape — it surfaces as that recipe's isolated failure via
// updateRecipeIngredients below, exactly as it would from a standalone update_recipe_ingredients
// call, and never blocks its siblings.
function validateBatch(updates: RecipeIngredientsBatchUpdate[]): void {
  if (updates.length === 0) {
    throw new RecipeIngredientsBatchValidationError('At least one recipe update is required.');
  }
  if (updates.length > RECIPE_INGREDIENTS_BATCH_MAX_SIZE) {
    throw new RecipeIngredientsBatchValidationError(
      `At most ${RECIPE_INGREDIENTS_BATCH_MAX_SIZE} recipes are allowed per batch call (got ${updates.length}).`,
    );
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const update of updates) {
    const slug = update.slug?.trim();
    if (!slug) {
      throw new RecipeIngredientsBatchValidationError('Each update must include a non-empty recipe slug.');
    }
    if (seen.has(slug)) duplicates.add(slug);
    seen.add(slug);
  }
  if (duplicates.size > 0) {
    throw new RecipeIngredientsBatchValidationError(
      `Duplicate recipe slug(s) in the same batch call: ${[...duplicates].join(', ')}. ` +
        'Each recipe may appear at most once per batch — submit a second call for a repeat update.',
    );
  }
}

function toBatchError(error: unknown): RecipeIngredientsBatchError {
  if (error instanceof IngredientVerificationError) {
    return {
      message: error.message,
      rollbackSucceeded: error.rollbackSucceeded,
      ...(error.rollbackError !== undefined ? { rollbackError: error.rollbackError } : {}),
    };
  }
  if (error instanceof MealieApiError) {
    return { message: error.message, status: error.status };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * Applies updateRecipeIngredients to multiple recipes with bounded concurrency, in input order.
 * Each recipe is a complete, independent replacement of its recipeIngredient collection — there is
 * no cross-recipe transaction. A failure on one recipe (a 404/422 from Mealie, a transient 502, a
 * local validation error like a mismatched foodId/foodName, or a post-write verification failure —
 * with its own best-effort rollback) is captured as that recipe's result; every other recipe in
 * the batch is still attempted and its own success/failure reported.
 */
export async function updateRecipeIngredientsBatch(
  updates: RecipeIngredientsBatchUpdate[],
): Promise<RecipeIngredientsBatchResult> {
  validateBatch(updates);

  const requestCounts = new Array<number>(updates.length).fill(0);

  const results = await mapWithConcurrency<RecipeIngredientsBatchUpdate, RecipeIngredientsBatchResultItem>(
    updates,
    BATCH_CONCURRENCY,
    async (update, index) => {
      try {
        const { requestCount } = await writeVerifiedIngredients(update.slug, update.ingredients);
        requestCounts[index] = requestCount;
        return { slug: update.slug, success: true, ingredientCount: update.ingredients.length };
      } catch (error) {
        requestCounts[index] = (error as { requestCount?: number } | null)?.requestCount ?? 0;
        return { slug: update.slug, success: false, error: toBatchError(error) };
      }
    },
  );

  const succeededCount = results.filter((result) => result.success).length;

  return {
    requestedCount: updates.length,
    succeededCount,
    failedCount: updates.length - succeededCount,
    results,
    apiRequestCount: requestCounts.reduce((sum, count) => sum + count, 0),
  };
}

// ── Batch layer ──────────────────────────────────────────────────────────────
//
// A narrow batching wrapper over updateRecipeIngredients above, added once a real pilot showed
// that once food/unit resolution is done in bulk (get_food_matches/get_unit_matches), one
// individual update_recipe_ingredients call per recipe becomes the dominant remaining
// model-to-MCP round trip. This layer performs no interpretation of its own — it never parses,
// matches, or creates anything — it only fans the same per-recipe write out with bounded
// concurrency and isolates each recipe's outcome so one failure never rolls back or blocks
// the rest of the batch (transient upstream 502s have been observed in real multi-recipe usage).

export const RECIPE_INGREDIENTS_BATCH_MAX_SIZE = 25;
const BATCH_CONCURRENCY = 5;

export interface RecipeIngredientsBatchUpdate {
  slug: string;
  ingredients: RecipeIngredientInput[];
}

export interface RecipeIngredientsBatchError {
  message: string;
  status?: number;
}

export type RecipeIngredientsBatchResultItem =
  | { slug: string; success: true; ingredientCount: number }
  | { slug: string; success: false; error: RecipeIngredientsBatchError };

export interface RecipeIngredientsBatchResult {
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  results: RecipeIngredientsBatchResultItem[];
  apiRequestCount: number;
}

/** Thrown for bad batch request shape (as opposed to a per-recipe runtime failure). */
export class RecipeIngredientsBatchValidationError extends Error {}

// Only structural issues that make the request as a whole impossible to interpret are validated
// here (empty/oversized batch, missing or duplicate slug). A malformed *ingredient* (e.g. a
// mismatched foodId/foodName pair) is a problem with one recipe's payload, not the batch shape —
// it surfaces as that recipe's isolated failure via updateRecipeIngredients below, exactly as it
// would from a standalone update_recipe_ingredients call, and never blocks its siblings.
function validateBatch(updates: RecipeIngredientsBatchUpdate[]): void {
  if (updates.length === 0) {
    throw new RecipeIngredientsBatchValidationError('At least one recipe update is required.');
  }
  if (updates.length > RECIPE_INGREDIENTS_BATCH_MAX_SIZE) {
    throw new RecipeIngredientsBatchValidationError(
      `At most ${RECIPE_INGREDIENTS_BATCH_MAX_SIZE} recipes are allowed per batch call (got ${updates.length}).`,
    );
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const update of updates) {
    const slug = update.slug?.trim();
    if (!slug) {
      throw new RecipeIngredientsBatchValidationError('Each update must include a non-empty recipe slug.');
    }
    if (seen.has(slug)) duplicates.add(slug);
    seen.add(slug);
  }
  if (duplicates.size > 0) {
    throw new RecipeIngredientsBatchValidationError(
      `Duplicate recipe slug(s) in the same batch call: ${[...duplicates].join(', ')}. ` +
        'Each recipe may appear at most once per batch — submit a second call for a repeat update.',
    );
  }
}

function toBatchError(error: unknown): RecipeIngredientsBatchError {
  if (error instanceof MealieApiError) {
    return { message: error.message, status: error.status };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * Applies updateRecipeIngredients to multiple recipes with bounded concurrency, in input order.
 * Each recipe is a complete, independent replacement of its recipeIngredient collection — there is
 * no cross-recipe transaction. A failure on one recipe (a 404/422 from Mealie, a transient 502,
 * or a local validation error like a mismatched foodId/foodName) is captured as that recipe's
 * result; every other recipe in the batch is still attempted and its own success/failure reported.
 */
export async function updateRecipeIngredientsBatch(
  updates: RecipeIngredientsBatchUpdate[],
): Promise<RecipeIngredientsBatchResult> {
  validateBatch(updates);

  const results = await mapWithConcurrency<RecipeIngredientsBatchUpdate, RecipeIngredientsBatchResultItem>(
    updates,
    BATCH_CONCURRENCY,
    async (update) => {
      try {
        await updateRecipeIngredients(update.slug, update.ingredients);
        return { slug: update.slug, success: true, ingredientCount: update.ingredients.length };
      } catch (error) {
        return { slug: update.slug, success: false, error: toBatchError(error) };
      }
    },
  );

  const succeededCount = results.filter((result) => result.success).length;

  return {
    requestedCount: updates.length,
    succeededCount,
    failedCount: updates.length - succeededCount,
    results,
    apiRequestCount: updates.length,
  };
}

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

/**
 * Replaces a recipe's complete recipeIngredient collection via PATCH, not PUT. PATCH is still the
 * right choice — Mealie's generic repository patch() merges a partial payload onto a fresh full
 * snapshot of the entity and only then persists it, so unrelated *scalar* fields (name,
 * description, settings, nutrition, categories/tags, ...) are correctly left alone whether or not
 * they're in our request body. Sending only { recipeIngredient } also means we never need to fetch
 * the recipe first.
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
 * ingredientReferences) is preserved correctly; only the ids churn.
 */
export async function updateRecipeIngredients(
  slug: string,
  ingredients: RecipeIngredientInput[],
): Promise<Record<string, unknown>> {
  const recipeIngredient = ingredients.map(toMealieIngredient);
  return recipesApi.patchRecipe(slug, { recipeIngredient });
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

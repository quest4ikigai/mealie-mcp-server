import * as recipesApi from '../api/recipes.js';
import * as toolsApi from '../api/tools.js';
import { mapWithConcurrency } from './concurrency.js';
import {
  computeDelta,
  computeFinal,
  resolveOrganizerValues,
  toApiPayloadItem,
  toOrganizerItem,
  toOrganizerItems,
  type OrganizerCollectionResult,
  type OrganizerMode,
} from './organizer-resolution.js';

/**
 * Either the legacy form (`tools` + optional `mode`) or the delta form (`add` and/or `remove`).
 * The two forms are mutually exclusive; `mode` only applies to `tools`.
 */
export interface RecipeToolsInput {
  tools?: string[];
  mode?: OrganizerMode;
  add?: string[];
  remove?: string[];
  createMissing?: boolean;
}

export interface RecipeToolsResult {
  id: string;
  slug: string;
  tools: OrganizerCollectionResult;
}

export class MissingToolsError extends Error {
  constructor(public readonly values: string[]) {
    super(
      `The following tools do not exist: ${values.join(', ')}. ` +
        `Pass createMissing: true to create ${values.length === 1 ? 'it' : 'them'} automatically, ` +
        'or correct the tool name(s)/slug(s)/ID(s). No changes were made to the recipe.',
    );
    this.name = 'MissingToolsError';
  }
}

export class UnknownRemovalToolsError extends Error {
  constructor(public readonly values: string[]) {
    super(
      `Cannot remove tools that do not exist: ${values.join(', ')}. Values passed to remove are never ` +
        'created; correct the tool name(s)/slug(s)/ID(s). No changes were made to the recipe.',
    );
    this.name = 'UnknownRemovalToolsError';
  }
}

/** Thrown for a bad request shape or an add/remove conflict (as opposed to an upstream failure). */
export class RecipeToolsValidationError extends Error {}

type ToolsMutation = { kind: 'legacy'; tools: string[]; mode: OrganizerMode } | { kind: 'delta'; add: string[]; remove: string[] };

function parseMutation(input: RecipeToolsInput): ToolsMutation {
  const legacy = input.tools !== undefined || input.mode !== undefined;
  const delta = input.add !== undefined || input.remove !== undefined;
  if (legacy && delta) {
    throw new RecipeToolsValidationError(
      'Provide either tools (with optional mode) or add/remove, not both.',
    );
  }
  if (delta) {
    return { kind: 'delta', add: input.add ?? [], remove: input.remove ?? [] };
  }
  if (input.tools === undefined) {
    throw new RecipeToolsValidationError(
      input.mode !== undefined
        ? 'mode only applies together with tools; provide tools, or use add/remove.'
        : 'Provide tools (with optional mode) or at least one of add/remove.',
    );
  }
  return { kind: 'legacy', tools: input.tools, mode: input.mode ?? 'merge' };
}

/**
 * Fetches the recipe, resolves the requested Tool organizers (ID, then slug, then name, all exact
 * and case-insensitive — no fuzzy matching), and PATCHes only the recipe's `tools` field. If
 * createMissing creates organizers and a later creation or the recipe PATCH then fails, the
 * already-created organizers remain (no rollback).
 *
 * `serializeCreation` optionally wraps the list-then-create section so callers running several
 * updates concurrently can avoid creating the same organizer twice.
 */
export async function updateRecipeTools(
  slug: string,
  input: RecipeToolsInput,
  options?: { serializeCreation?: <T>(fn: () => Promise<T>) => Promise<T> },
): Promise<RecipeToolsResult> {
  const mutation = parseMutation(input);
  const createMissing = input.createMissing ?? false;
  const recipe = await recipesApi.getRecipe(slug);
  const current = toOrganizerItems(recipe.tools);

  const resolveAll = async (): Promise<{ final: typeof current; added: typeof current; removed: typeof current; created: typeof current; skipPatch: boolean }> => {
    const all = (await toolsApi.getTools({ perPage: -1 })).items.map(toOrganizerItem);

    if (mutation.kind === 'legacy') {
      const { resolved, created, missing } = await resolveOrganizerValues(
        mutation.tools,
        all,
        createMissing,
        toolsApi.createTool,
      );
      if (missing.length > 0) throw new MissingToolsError(missing);
      const { final, added, removed } = computeFinal(mutation.mode, current, resolved);
      // Replace with the recipe's current set (in any order) is also a no-op, not just an empty merge.
      return { final, added, removed, created, skipPatch: added.length === 0 && removed.length === 0 };
    }

    // Removals never create, and all validation happens before any organizer is created.
    const removals = await resolveOrganizerValues(mutation.remove, all, false, toolsApi.createTool);
    if (removals.missing.length > 0) throw new UnknownRemovalToolsError(removals.missing);

    const preview = await resolveOrganizerValues(mutation.add, all, false, toolsApi.createTool);
    const removalIds = new Set(removals.resolved.map((item) => item.id));
    const conflicts = preview.resolved.filter((item) => removalIds.has(item.id));
    if (conflicts.length > 0) {
      throw new RecipeToolsValidationError(
        `The same tool appears in both add and remove: ${conflicts.map((item) => item.name).join(', ')}.`,
      );
    }
    if (preview.missing.length > 0 && !createMissing) throw new MissingToolsError(preview.missing);

    const additions =
      preview.missing.length > 0
        ? await resolveOrganizerValues(mutation.add, all, true, toolsApi.createTool)
        : preview;
    const { final, added, removed } = computeDelta(current, additions.resolved, removals.resolved);
    return { final, added, removed, created: additions.created, skipPatch: added.length === 0 && removed.length === 0 };
  };

  const needsSerialization = createMissing && options?.serializeCreation;
  const { final, added, removed, created, skipPatch } = needsSerialization
    ? await options.serializeCreation!(resolveAll)
    : await resolveAll();

  if (!skipPatch) {
    await recipesApi.patchRecipe(slug, { tools: final.map(toApiPayloadItem) });
  }

  return {
    id: String(recipe.id),
    slug: typeof recipe.slug === 'string' ? recipe.slug : slug,
    tools: { final, added, removed, created },
  };
}

export const RECIPE_TOOLS_BATCH_MAX_SIZE = 25;
const BATCH_CONCURRENCY = 5;

export interface RecipeToolsBatchUpdate extends RecipeToolsInput {
  slug: string;
}

export type RecipeToolsBatchResultItem =
  | ({ slug: string; success: true } & RecipeToolsResult)
  | { slug: string; success: false; error: string };

export interface RecipeToolsBatchResult {
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  results: RecipeToolsBatchResultItem[];
}

/** Thrown for bad batch request shape (as opposed to a per-recipe runtime failure). */
export class RecipeToolsBatchValidationError extends Error {}

function validateBatch(updates: RecipeToolsBatchUpdate[]): void {
  if (updates.length === 0) {
    throw new RecipeToolsBatchValidationError('At least one recipe update is required.');
  }
  if (updates.length > RECIPE_TOOLS_BATCH_MAX_SIZE) {
    throw new RecipeToolsBatchValidationError(
      `At most ${RECIPE_TOOLS_BATCH_MAX_SIZE} recipes are allowed per batch call (got ${updates.length}).`,
    );
  }
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const update of updates) {
    const slug = update.slug?.trim();
    if (!slug) {
      throw new RecipeToolsBatchValidationError('Each update must include a non-empty recipe slug.');
    }
    if (seen.has(slug)) duplicates.add(slug);
    seen.add(slug);
  }
  if (duplicates.size > 0) {
    throw new RecipeToolsBatchValidationError(
      `Duplicate recipe slug(s) in the same batch call: ${[...duplicates].join(', ')}. ` +
        'Each recipe may appear at most once per batch — submit a second call for a repeat update.',
    );
  }
}

/**
 * Applies updateRecipeTools to several recipes with bounded concurrency, in input order. Recipes
 * are independent: a failure on one is reported in its own entry and never stops or rolls back the
 * others. Organizer creation (createMissing) is serialized across the batch, with the organizer
 * list re-read inside the critical section, so two recipes asking for the same missing Tool
 * create it once and the second resolves to it instead of duplicating it.
 */
export async function updateRecipeToolsBatch(updates: RecipeToolsBatchUpdate[]): Promise<RecipeToolsBatchResult> {
  validateBatch(updates);

  let tail: Promise<unknown> = Promise.resolve();
  const serializeCreation = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  const results = await mapWithConcurrency<RecipeToolsBatchUpdate, RecipeToolsBatchResultItem>(
    updates,
    BATCH_CONCURRENCY,
    async (update) => {
      const { slug, ...input } = update;
      try {
        const result = await updateRecipeTools(slug, input, { serializeCreation });
        return { success: true, ...result };
      } catch (error) {
        return { slug: update.slug, success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  const succeededCount = results.filter((result) => result.success).length;
  return {
    requestedCount: updates.length,
    succeededCount,
    failedCount: updates.length - succeededCount,
    results,
  };
}

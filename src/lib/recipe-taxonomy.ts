import * as recipesApi from '../api/recipes.js';
import * as categoriesApi from '../api/categories.js';
import * as tagsApi from '../api/tags.js';
import { mapWithConcurrency } from './concurrency.js';
import {
  computeDelta,
  computeFinal,
  resolveOrganizerValues,
  toApiPayloadItem,
  toOrganizerItem,
  toOrganizerItems,
  type OrganizerCollectionResult,
  type OrganizerItem,
  type OrganizerMode,
  type ResolveResult,
} from './organizer-resolution.js';

// The organizer helpers now live in organizer-resolution.ts; these aliases keep this module's
// existing exports (and category/tag behavior) unchanged.
export { computeFinal, toApiPayloadItem, type ResolveResult };
export const resolveTaxonomyValues = resolveOrganizerValues;
export const toTaxonomyItem = toOrganizerItem;
export const toTaxonomyItems = toOrganizerItems;
export type TaxonomyMode = OrganizerMode;
export type TaxonomyItem = OrganizerItem;
export type TaxonomyCollectionResult = OrganizerCollectionResult;
export type TaxonomyKind = 'category' | 'tag';

export interface TaxonomyUpdateInput {
  categories?: string[];
  tags?: string[];
  addCategories?: string[];
  removeCategories?: string[];
  addTags?: string[];
  removeTags?: string[];
  mode?: TaxonomyMode;
  createMissing?: boolean;
}

export interface RecipeTaxonomyResult {
  id: string;
  slug: string;
  categories?: TaxonomyCollectionResult;
  tags?: TaxonomyCollectionResult;
}

export interface RecipeTaxonomyBatchUpdate extends TaxonomyUpdateInput {
  slug: string;
}

export type RecipeTaxonomyBatchResult =
  | ({ slug: string; success: true } & RecipeTaxonomyResult)
  | { slug: string; success: false; error: string };

export class MissingTaxonomyItemsError extends Error {
  constructor(
    public readonly kind: TaxonomyKind,
    public readonly values: string[],
  ) {
    const label = kind === 'category' ? 'categories' : 'tags';
    super(
      `The following ${label} do not exist: ${values.join(', ')}. ` +
        `Pass createMissing: true to create ${values.length === 1 ? 'it' : 'them'} automatically, ` +
        `or correct the ${label} name(s)/slug(s)/ID(s).`,
    );
    this.name = 'MissingTaxonomyItemsError';
  }
}

async function getAllCategories(): Promise<TaxonomyItem[]> {
  const result = await categoriesApi.getCategories({ perPage: -1 });
  return result.items.map(toTaxonomyItem);
}

async function getAllTags(): Promise<TaxonomyItem[]> {
  const result = await tagsApi.getTags({ perPage: -1 });
  return result.items.map(toTaxonomyItem);
}

/** Optionally wraps the list-then-create section so concurrent callers don't create duplicates. */
export interface TaxonomySerializeOptions {
  serializeCreation?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface TaxonomyPatchOutcome {
  patchFields: Record<string, unknown>;
  categories?: TaxonomyCollectionResult;
  tags?: TaxonomyCollectionResult;
}

/** Thrown for a bad request shape or an add/remove conflict (as opposed to an upstream failure). */
export class TaxonomyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxonomyValidationError';
  }
}

export class UnknownRemovalTaxonomyError extends Error {
  constructor(
    public readonly kind: TaxonomyKind,
    public readonly values: string[],
  ) {
    const label = kind === 'category' ? 'categories' : 'tags';
    super(
      `Cannot remove ${label} that do not exist: ${values.join(', ')}. Values passed to remove are never ` +
        `created; correct the ${label} name(s)/slug(s)/ID(s). No changes were made to the recipe.`,
    );
    this.name = 'UnknownRemovalTaxonomyError';
  }
}

interface KindConfig {
  kind: TaxonomyKind;
  replace?: string[];
  add?: string[];
  remove?: string[];
  currentRaw: unknown;
  getAll: () => Promise<TaxonomyItem[]>;
  createFn: (name: string) => Promise<Record<string, unknown>>;
}

function validateInput(input: TaxonomyUpdateInput): void {
  for (const [kind, label, full, add, remove] of [
    ['category', 'categories', input.categories, input.addCategories, input.removeCategories],
    ['tag', 'tags', input.tags, input.addTags, input.removeTags],
  ] as const) {
    if (full !== undefined && (add !== undefined || remove !== undefined)) {
      throw new TaxonomyValidationError(
        `Provide either ${label} (with optional mode) or ${kind === 'category' ? 'addCategories/removeCategories' : 'addTags/removeTags'}, not both.`,
      );
    }
  }
  const hasFull = input.categories !== undefined || input.tags !== undefined;
  const hasDelta = [input.addCategories, input.removeCategories, input.addTags, input.removeTags].some(
    (v) => v !== undefined,
  );
  if (hasDelta && !hasFull && input.mode !== undefined) {
    throw new TaxonomyValidationError(
      'mode only applies together with categories/tags; it has no effect on add/remove delta fields.',
    );
  }
}

async function buildCollectionOutcome(
  config: KindConfig,
  mode: TaxonomyMode,
  createMissing: boolean,
): Promise<TaxonomyCollectionResult> {
  const current = toTaxonomyItems(config.currentRaw);
  const all = await config.getAll();

  if (config.replace !== undefined) {
    const { resolved, created, missing } = await resolveTaxonomyValues(
      config.replace,
      all,
      createMissing,
      config.createFn,
    );
    if (missing.length > 0) throw new MissingTaxonomyItemsError(config.kind, missing);
    const { final, added, removed } = computeFinal(mode, current, resolved);
    return { final, added, removed, created };
  }

  // Delta form: removals never create, and all validation happens before anything is created.
  const removals = await resolveTaxonomyValues(config.remove ?? [], all, false, config.createFn);
  if (removals.missing.length > 0) throw new UnknownRemovalTaxonomyError(config.kind, removals.missing);

  const add = config.add ?? [];
  const preview = await resolveTaxonomyValues(add, all, false, config.createFn);
  const removalIds = new Set(removals.resolved.map((item) => item.id));
  const conflicts = preview.resolved.filter((item) => removalIds.has(item.id));
  if (conflicts.length > 0) {
    throw new TaxonomyValidationError(
      `The same ${config.kind} appears in both add and remove: ${conflicts.map((item) => item.name).join(', ')}.`,
    );
  }
  if (preview.missing.length > 0 && !createMissing) {
    throw new MissingTaxonomyItemsError(config.kind, preview.missing);
  }
  const additions =
    preview.missing.length > 0 ? await resolveTaxonomyValues(add, all, true, config.createFn) : preview;
  const { final, added, removed } = computeDelta(current, additions.resolved, removals.resolved);
  return { final, added, removed, created: additions.created };
}

/**
 * Resolves requested categories/tags against a recipe already fetched from the API and
 * builds the partial PATCH payload fragment for the changed collection(s). Does not perform
 * any recipe update itself, so callers can merge the fragment into a larger PATCH body.
 *
 * Each collection accepts either the legacy form (categories/tags + mode) or the delta form
 * (addX/removeX, computed as current - remove + add). The forms are mutually exclusive per
 * collection. A collection whose computed result is unchanged is not included in the PATCH.
 */
export async function buildTaxonomyPatch(
  currentRecipe: Record<string, unknown>,
  input: TaxonomyUpdateInput,
  options?: TaxonomySerializeOptions,
): Promise<TaxonomyPatchOutcome> {
  validateInput(input);
  const mode = input.mode ?? 'merge';
  const createMissing = input.createMissing ?? false;
  const patchFields: Record<string, unknown> = {};
  const outcome: TaxonomyPatchOutcome = { patchFields };

  const configs: Array<[KindConfig, 'categories' | 'tags', string]> = [];
  const hasKind = (full?: string[], add?: string[], remove?: string[]) =>
    full !== undefined || add !== undefined || remove !== undefined;
  if (hasKind(input.categories, input.addCategories, input.removeCategories)) {
    configs.push([
      {
        kind: 'category',
        replace: input.categories,
        add: input.addCategories,
        remove: input.removeCategories,
        currentRaw: currentRecipe.recipeCategory,
        getAll: getAllCategories,
        createFn: categoriesApi.createCategory,
      },
      'categories',
      'recipeCategory',
    ]);
  }
  if (hasKind(input.tags, input.addTags, input.removeTags)) {
    configs.push([
      {
        kind: 'tag',
        replace: input.tags,
        add: input.addTags,
        remove: input.removeTags,
        currentRaw: currentRecipe.tags,
        getAll: getAllTags,
        createFn: tagsApi.createTag,
      },
      'tags',
      'tags',
    ]);
  }

  const resolveAll = async () => {
    // Validate every collection without creating anything, so a failure in a later collection
    // cannot leave organizers created for an earlier one.
    if (createMissing && configs.length > 1) {
      for (const [config] of configs) {
        const dryConfig: KindConfig = {
          ...config,
          createFn: (name) => Promise.resolve({ id: `pending-${name}`, name, slug: name }),
        };
        await buildCollectionOutcome(dryConfig, mode, createMissing);
      }
    }
    for (const [config, outcomeKey, patchKey] of configs) {
      const result = await buildCollectionOutcome(config, mode, createMissing);
      outcome[outcomeKey] = result;
      // Unchanged collections (legacy or delta) are never written.
      if (result.added.length > 0 || result.removed.length > 0) {
        patchFields[patchKey] = result.final.map(toApiPayloadItem);
      }
    }
  };

  if (createMissing && options?.serializeCreation) {
    await options.serializeCreation(resolveAll);
  } else {
    await resolveAll();
  }

  return outcome;
}

/**
 * Fetches the current recipe, resolves the requested categories/tags, and applies the
 * change via a single PATCH request that only touches the recipeCategory/tags fields.
 * All other recipe fields (ingredients, instructions, nutrition, settings, etc.) are
 * left untouched because Mealie's PATCH endpoint merges only the fields present in the
 * request body into the existing recipe.
 */
export async function updateRecipeTaxonomy(
  slug: string,
  input: TaxonomyUpdateInput,
  options?: TaxonomySerializeOptions,
): Promise<RecipeTaxonomyResult> {
  const recipe = await recipesApi.getRecipe(slug);
  const outcome = await buildTaxonomyPatch(recipe, input, options);

  if (Object.keys(outcome.patchFields).length > 0) {
    await recipesApi.patchRecipe(slug, outcome.patchFields);
  }

  return {
    id: String(recipe.id),
    slug: typeof recipe.slug === 'string' ? recipe.slug : slug,
    categories: outcome.categories,
    tags: outcome.tags,
  };
}

const BATCH_CONCURRENCY = 5;

export async function updateRecipeTaxonomyBatch(
  updates: RecipeTaxonomyBatchUpdate[],
): Promise<RecipeTaxonomyBatchResult[]> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const update of updates) {
    const slug = update.slug.trim();
    if (seen.has(slug)) duplicates.add(slug);
    seen.add(slug);
  }
  if (duplicates.size > 0) {
    throw new TaxonomyValidationError(
      `Duplicate recipe slug(s) in the same batch call: ${[...duplicates].join(', ')}. ` +
        'Each recipe may appear at most once per batch — submit a second call for a repeat update.',
    );
  }

  let tail: Promise<unknown> = Promise.resolve();
  const serializeCreation = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  return mapWithConcurrency(updates, BATCH_CONCURRENCY, async (update) => {
    try {
      const result = await updateRecipeTaxonomy(update.slug, update, { serializeCreation });
      return { success: true as const, ...result };
    } catch (error) {
      return {
        slug: update.slug,
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

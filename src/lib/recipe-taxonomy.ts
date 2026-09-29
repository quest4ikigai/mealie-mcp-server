import * as recipesApi from '../api/recipes.js';
import * as categoriesApi from '../api/categories.js';
import * as tagsApi from '../api/tags.js';
import { mapWithConcurrency } from './concurrency.js';
import {
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

export interface TaxonomyPatchOutcome {
  patchFields: Record<string, unknown>;
  categories?: TaxonomyCollectionResult;
  tags?: TaxonomyCollectionResult;
}

/**
 * Resolves requested categories/tags against a recipe already fetched from the API and
 * builds the partial PATCH payload fragment for the changed collection(s). Does not perform
 * any recipe update itself, so callers can merge the fragment into a larger PATCH body.
 */
export async function buildTaxonomyPatch(
  currentRecipe: Record<string, unknown>,
  input: TaxonomyUpdateInput,
): Promise<TaxonomyPatchOutcome> {
  const mode = input.mode ?? 'merge';
  const createMissing = input.createMissing ?? false;
  const patchFields: Record<string, unknown> = {};
  const outcome: TaxonomyPatchOutcome = { patchFields };

  if (input.categories !== undefined) {
    const current = toTaxonomyItems(currentRecipe.recipeCategory);
    const all = await getAllCategories();
    const { resolved, created, missing } = await resolveTaxonomyValues(
      input.categories,
      all,
      createMissing,
      categoriesApi.createCategory,
    );
    if (missing.length > 0) {
      throw new MissingTaxonomyItemsError('category', missing);
    }
    const { final, added, removed } = computeFinal(mode, current, resolved);
    outcome.categories = { final, added, removed, created };
    patchFields.recipeCategory = final.map(toApiPayloadItem);
  }

  if (input.tags !== undefined) {
    const current = toTaxonomyItems(currentRecipe.tags);
    const all = await getAllTags();
    const { resolved, created, missing } = await resolveTaxonomyValues(
      input.tags,
      all,
      createMissing,
      tagsApi.createTag,
    );
    if (missing.length > 0) {
      throw new MissingTaxonomyItemsError('tag', missing);
    }
    const { final, added, removed } = computeFinal(mode, current, resolved);
    outcome.tags = { final, added, removed, created };
    patchFields.tags = final.map(toApiPayloadItem);
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
): Promise<RecipeTaxonomyResult> {
  const recipe = await recipesApi.getRecipe(slug);
  const outcome = await buildTaxonomyPatch(recipe, input);

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
  return mapWithConcurrency(updates, BATCH_CONCURRENCY, async (update) => {
    try {
      const result = await updateRecipeTaxonomy(update.slug, update);
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

import * as recipesApi from '../api/recipes.js';
import * as categoriesApi from '../api/categories.js';
import * as tagsApi from '../api/tags.js';

export type TaxonomyMode = 'merge' | 'replace';
export type TaxonomyKind = 'category' | 'tag';

export interface TaxonomyItem {
  id: string;
  name: string;
  slug: string;
}

export interface TaxonomyCollectionResult {
  final: TaxonomyItem[];
  added: TaxonomyItem[];
  removed: TaxonomyItem[];
  created: TaxonomyItem[];
}

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

function toTaxonomyItem(raw: Record<string, unknown>): TaxonomyItem {
  return {
    id: String(raw.id),
    name: String(raw.name),
    slug: String(raw.slug),
  };
}

function toTaxonomyItems(raw: unknown): TaxonomyItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => toTaxonomyItem(item as Record<string, unknown>));
}

function toApiPayloadItem(item: TaxonomyItem): Record<string, unknown> {
  return { id: item.id, name: item.name, slug: item.slug };
}

async function getAllCategories(): Promise<TaxonomyItem[]> {
  const result = await categoriesApi.getCategories({ perPage: -1 });
  return result.items.map(toTaxonomyItem);
}

async function getAllTags(): Promise<TaxonomyItem[]> {
  const result = await tagsApi.getTags({ perPage: -1 });
  return result.items.map(toTaxonomyItem);
}

interface ResolveResult {
  resolved: TaxonomyItem[];
  created: TaxonomyItem[];
  missing: string[];
}

async function resolveTaxonomyValues(
  values: string[],
  existing: TaxonomyItem[],
  createMissing: boolean,
  createFn: (name: string) => Promise<Record<string, unknown>>,
): Promise<ResolveResult> {
  const byId = new Map<string, TaxonomyItem>();
  const bySlug = new Map<string, TaxonomyItem>();
  const byName = new Map<string, TaxonomyItem>();
  for (const item of existing) {
    byId.set(item.id.toLowerCase(), item);
    bySlug.set(item.slug.toLowerCase(), item);
    byName.set(item.name.toLowerCase(), item);
  }

  const resolvedMap = new Map<string, TaxonomyItem>();
  const created: TaxonomyItem[] = [];
  const missing: string[] = [];
  const createdThisCall = new Map<string, TaxonomyItem>();

  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const match = byId.get(key) ?? bySlug.get(key) ?? byName.get(key) ?? createdThisCall.get(key);
    if (match) {
      resolvedMap.set(match.id, match);
      continue;
    }

    if (!createMissing) {
      missing.push(raw);
      continue;
    }

    const createdRaw = await createFn(value);
    const item = toTaxonomyItem(createdRaw);
    createdThisCall.set(key, item);
    resolvedMap.set(item.id, item);
    created.push(item);
  }

  return { resolved: [...resolvedMap.values()], created, missing };
}

function computeFinal(
  mode: TaxonomyMode,
  current: TaxonomyItem[],
  requested: TaxonomyItem[],
): { final: TaxonomyItem[]; added: TaxonomyItem[]; removed: TaxonomyItem[] } {
  if (mode === 'replace') {
    const finalMap = new Map(requested.map((item) => [item.id, item]));
    const currentIds = new Set(current.map((item) => item.id));
    const final = [...finalMap.values()];
    const added = final.filter((item) => !currentIds.has(item.id));
    const removed = current.filter((item) => !finalMap.has(item.id));
    return { final, added, removed };
  }

  const finalMap = new Map(current.map((item) => [item.id, item]));
  const added: TaxonomyItem[] = [];
  for (const item of requested) {
    if (!finalMap.has(item.id)) {
      finalMap.set(item.id, item);
      added.push(item);
    }
  }
  return { final: [...finalMap.values()], added, removed: [] };
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

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

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

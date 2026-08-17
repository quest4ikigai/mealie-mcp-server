import * as recipesApi from '../api/recipes.js';
import { resolveIngredients, ResolvedIngredient, UnresolvedIngredient } from './ingredient-resolution.js';

export interface FindRecipesForIngredientsInput {
  ingredients: string[];
  categories?: string[];
  tags?: string[];
  requireAllIngredients?: boolean;
  requireAllCategories?: boolean;
  requireAllTags?: boolean;
  limit?: number;
}

export type RecipeMatchSource = 'suggestions' | 'food-filter' | 'text-search';
export type OverallMatchSource = RecipeMatchSource | 'none';

export interface RecipeCandidate {
  name: string;
  slug: string;
  description?: string;
  categories: string[];
  tags: string[];
  totalTime: string | null;
  matchedIngredients: string[];
  missingIngredients: string[];
  matchSource: RecipeMatchSource;
}

export interface FindRecipesForIngredientsResult {
  resolvedIngredients: ResolvedIngredient[];
  unresolvedIngredients: UnresolvedIngredient[];
  matchSource: OverallMatchSource;
  recipes: RecipeCandidate[];
  notes: string[];
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const OVERFETCH_MULTIPLIER = 4;
const MAX_OVERFETCH = 100;

// Mealie's suggestions endpoint defaults maxMissingFoods to 5 and *excludes* any recipe whose
// count of other (non-requested) structured-Food ingredients exceeds it — it's tuned for "what
// can I nearly make from my pantry", not "find recipes containing X". A 7-ingredient recipe like
// "Lemon Herb Grilled Salmon" (6 other foods) would be silently dropped even though it contains
// the exact requested salmon Food ID. We want ranking, not exclusion, so this is set far above any
// realistic ingredient count.
const UNBOUNDED_MISSING_FOODS = 1000;

function clampLimit(limit: number | undefined): number {
  const n = Math.trunc(limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function namesFromTaxonomyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as Record<string, unknown>[])
    .map((item) => (typeof item.name === 'string' ? item.name : undefined))
    .filter((name): name is string => Boolean(name));
}

function taxonomyKeySet(recipe: Record<string, unknown>, field: 'recipeCategory' | 'tags'): Set<string> {
  const raw = recipe[field];
  const keys = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw as Record<string, unknown>[]) {
      if (typeof item.name === 'string') keys.add(item.name.toLowerCase());
      if (typeof item.slug === 'string') keys.add(item.slug.toLowerCase());
    }
  }
  return keys;
}

function matchesTaxonomyFilter(
  recipe: Record<string, unknown>,
  field: 'recipeCategory' | 'tags',
  filter: string[] | undefined,
  requireAll: boolean | undefined,
): boolean {
  if (!filter || filter.length === 0) return true;
  const keys = taxonomyKeySet(recipe, field);
  const hits = filter.map((f) => keys.has(f.trim().toLowerCase()));
  return requireAll ? hits.every(Boolean) : hits.some(Boolean);
}

/**
 * Applies the requested categories/tags filter client-side to a candidate set, regardless of
 * whether it was already (supposedly) applied server-side. This is a deliberate safety net, not
 * a redundancy: Mealie's own category/tag query params only match by slug or ID for non-UUID
 * values — a name like "Dinner" that doesn't happen to equal the real slug exactly (e.g. the
 * actual slug is "dinner") resolves to zero IDs server-side, and Mealie's filter-building code
 * then silently *skips* the filter entirely on an empty ID list rather than filtering to zero
 * results. Without this, categories/tags can appear to be ignored. Notes any recipes this drops.
 */
function applyTaxonomyFilter<T extends { recipe: Record<string, unknown> }>(
  candidates: T[],
  input: FindRecipesForIngredientsInput,
  notes: string[],
): T[] {
  if ((input.categories?.length ?? 0) === 0 && (input.tags?.length ?? 0) === 0) return candidates;

  const filtered = candidates.filter(
    (c) =>
      matchesTaxonomyFilter(c.recipe, 'recipeCategory', input.categories, input.requireAllCategories) &&
      matchesTaxonomyFilter(c.recipe, 'tags', input.tags, input.requireAllTags),
  );

  const excluded = candidates.length - filtered.length;
  if (excluded > 0) {
    notes.push(
      `${excluded} recipe(s) matched the ingredient search but were excluded by the requested categories/tags filter.`,
    );
  }

  return filtered;
}

function toRecipeCandidate(
  recipe: Record<string, unknown>,
  matchedIngredients: string[],
  missingIngredients: string[],
  matchSource: RecipeMatchSource,
): RecipeCandidate {
  return {
    name: typeof recipe.name === 'string' ? recipe.name : '',
    slug: typeof recipe.slug === 'string' ? recipe.slug : '',
    description: typeof recipe.description === 'string' && recipe.description ? recipe.description : undefined,
    categories: namesFromTaxonomyList(recipe.recipeCategory),
    tags: namesFromTaxonomyList(recipe.tags),
    totalTime: typeof recipe.totalTime === 'string' ? recipe.totalTime : null,
    matchedIngredients,
    missingIngredients,
    matchSource,
  };
}

/**
 * Ranks recipes by fewest missing ingredients via Mealie's Recipe Finder (GET /api/recipes/suggestions),
 * one call per resolved food so matchedIngredients can be tracked precisely per recipe (recipe libraries
 * are large, but ingredient lists per call are always small — this is bounded by ingredient count, not
 * recipe count). Used whenever the caller isn't requiring every ingredient to be present at once.
 */
async function suggestionsSearch(
  resolved: ResolvedIngredient[],
  input: FindRecipesForIngredientsInput,
  limit: number,
  notes: string[],
): Promise<RecipeCandidate[]> {
  const hasTaxonomyFilter = (input.categories?.length ?? 0) > 0 || (input.tags?.length ?? 0) > 0;
  const perCallLimit = hasTaxonomyFilter ? Math.min(limit * OVERFETCH_MULTIPLIER, MAX_OVERFETCH) : limit;

  const settled = await Promise.allSettled(
    resolved.map((r) =>
      recipesApi.getRecipeSuggestions({
        foods: [r.foodId],
        limit: perCallLimit,
        maxMissingFoods: UNBOUNDED_MISSING_FOODS,
        includeFoodsOnHand: false,
        includeToolsOnHand: false,
      }),
    ),
  );

  const failedQueries: string[] = [];
  const bySlug = new Map<string, { recipe: Record<string, unknown>; matched: Set<string>; missingFoods: string[] }>();

  settled.forEach((result, i) => {
    if (result.status !== 'fulfilled') {
      failedQueries.push(resolved[i].query);
      return;
    }
    for (const item of result.value.items) {
      const slug = typeof item.recipe.slug === 'string' ? item.recipe.slug : '';
      if (!slug) continue;
      const missingFoodNames = item.missingFoods
        .map((f) => (typeof f.name === 'string' ? f.name : undefined))
        .filter((n): n is string => Boolean(n));

      const existing = bySlug.get(slug);
      if (existing) {
        existing.matched.add(resolved[i].query);
        if (missingFoodNames.length < existing.missingFoods.length) {
          existing.missingFoods = missingFoodNames;
        }
      } else {
        bySlug.set(slug, { recipe: item.recipe, matched: new Set([resolved[i].query]), missingFoods: missingFoodNames });
      }
    }
  });

  if (failedQueries.length > 0 && failedQueries.length < resolved.length) {
    notes.push(`Recipe suggestions lookup failed for: ${failedQueries.join(', ')} (other ingredients still searched).`);
  } else if (failedQueries.length > 0 && failedQueries.length === resolved.length) {
    throw new Error(`Mealie recipe suggestions lookup failed for all resolved ingredients: ${failedQueries.join(', ')}.`);
  }

  const candidates = applyTaxonomyFilter([...bySlug.values()], input, notes).sort(
    (a, b) => b.matched.size - a.matched.size,
  );

  return candidates.slice(0, limit).map((c) => toRecipeCandidate(c.recipe, [...c.matched], c.missingFoods, 'suggestions'));
}

/**
 * Strict AND match across every resolved ingredient via Mealie's normal recipe search
 * (GET /api/recipes?foods=...&requireAllFoods=true). Categories/tags are passed straight
 * through to Mealie, which usually applies them server-side, but applyTaxonomyFilter is still
 * run as a safety net (see its docstring) — so we overfetch when a taxonomy filter is present,
 * the same way the other search strategies do.
 */
async function foodFilterSearch(
  resolved: ResolvedIngredient[],
  input: FindRecipesForIngredientsInput,
  limit: number,
  notes: string[],
): Promise<RecipeCandidate[]> {
  const hasTaxonomyFilter = (input.categories?.length ?? 0) > 0 || (input.tags?.length ?? 0) > 0;
  const perPage = hasTaxonomyFilter ? Math.min(limit * OVERFETCH_MULTIPLIER, MAX_OVERFETCH) : limit;

  const page = await recipesApi.searchRecipesByFilter({
    foods: resolved.map((r) => r.foodId),
    requireAllFoods: true,
    categories: input.categories,
    tags: input.tags,
    requireAllCategories: input.requireAllCategories,
    requireAllTags: input.requireAllTags,
    perPage,
  });

  const matchedNames = resolved.map((r) => r.query);
  const candidates = applyTaxonomyFilter(
    page.items.map((recipe) => ({ recipe })),
    input,
    notes,
  );

  return candidates.slice(0, limit).map((c) => toRecipeCandidate(c.recipe, matchedNames, [], 'food-filter'));
}

/**
 * Free-text fallback via Mealie's normal recipe search (matches recipe name, description, and
 * ingredient text server-side) for ingredient terms that had no Food match at all. One search
 * call per term, merged and (optionally) intersected client-side — never a full-library scan.
 */
async function textSearchFallback(
  terms: string[],
  input: FindRecipesForIngredientsInput,
  limit: number,
  notes: string[],
): Promise<RecipeCandidate[]> {
  if (terms.length === 0) return [];

  const hasTaxonomyFilter = (input.categories?.length ?? 0) > 0 || (input.tags?.length ?? 0) > 0;
  const perCallLimit =
    terms.length > 1 || hasTaxonomyFilter ? Math.min(limit * OVERFETCH_MULTIPLIER, MAX_OVERFETCH) : limit;

  const settled = await Promise.allSettled(
    terms.map((term) =>
      recipesApi.searchRecipesByFilter({
        search: term,
        categories: input.categories,
        tags: input.tags,
        requireAllCategories: input.requireAllCategories,
        requireAllTags: input.requireAllTags,
        perPage: perCallLimit,
      }),
    ),
  );

  const failedTerms: string[] = [];
  const successfulTerms: string[] = [];
  const bySlug = new Map<string, { recipe: Record<string, unknown>; matched: Set<string> }>();

  settled.forEach((result, i) => {
    const term = terms[i];
    if (result.status !== 'fulfilled') {
      failedTerms.push(term);
      return;
    }
    successfulTerms.push(term);
    for (const recipe of result.value.items) {
      const slug = typeof recipe.slug === 'string' ? recipe.slug : '';
      if (!slug) continue;
      const existing = bySlug.get(slug);
      if (existing) {
        existing.matched.add(term);
      } else {
        bySlug.set(slug, { recipe, matched: new Set([term]) });
      }
    }
  });

  if (failedTerms.length > 0) {
    notes.push(`Text search failed for: ${failedTerms.join(', ')}.`);
  }
  if (failedTerms.length === terms.length) {
    throw new Error(`Mealie recipe search failed for all ingredient terms: ${failedTerms.join(', ')}.`);
  }

  let entries = [...bySlug.values()];
  if (input.requireAllIngredients && successfulTerms.length > 1) {
    entries = entries.filter((e) => successfulTerms.every((t) => e.matched.has(t)));
  }

  entries = applyTaxonomyFilter(entries, input, notes);
  entries.sort((a, b) => b.matched.size - a.matched.size);

  return entries.slice(0, limit).map((e) => toRecipeCandidate(e.recipe, [...e.matched], [], 'text-search'));
}

/**
 * Finds recipes for one or more human-readable ingredient names. Resolves ingredients against
 * Mealie's food taxonomy internally (never requires the caller to know food UUIDs), prefers
 * Mealie's own suggestions/search APIs over any local recipe scan, and never guesses between
 * ambiguous ingredient matches — those are surfaced as unresolved for the caller to disambiguate
 * or broaden.
 */
export async function findRecipesForIngredients(
  input: FindRecipesForIngredientsInput,
): Promise<FindRecipesForIngredientsResult> {
  const ingredientQueries = (input.ingredients ?? []).map((i) => i.trim()).filter(Boolean);
  if (ingredientQueries.length === 0) {
    throw new Error('ingredients must contain at least one non-empty ingredient name.');
  }

  const limit = clampLimit(input.limit);
  const notes: string[] = [];
  const { resolved, unresolved } = await resolveIngredients(ingredientQueries);

  if (resolved.length === 0) {
    const textSearchTerms = unresolved
      .filter((u) => u.reason === 'not-found' || u.reason === 'ambiguous')
      .map((u) => u.query);
    const recipes = await textSearchFallback(textSearchTerms, input, limit, notes);
    return {
      resolvedIngredients: resolved,
      unresolvedIngredients: unresolved,
      matchSource: recipes.length > 0 ? 'text-search' : 'none',
      recipes,
      notes,
    };
  }

  if (unresolved.length > 0) {
    notes.push(
      `${unresolved.length} ingredient(s) could not be resolved to a Mealie food and were excluded from matching: ` +
        `${unresolved.map((u) => u.query).join(', ')}.`,
    );
  }

  const useFoodFilter = resolved.length > 1 && input.requireAllIngredients === true;
  if (useFoodFilter && unresolved.length > 0) {
    notes.push('requireAllIngredients only applies to the ingredients that were successfully resolved to a Mealie food.');
  }

  // Notes from this attempt (e.g. taxonomy exclusions) only matter if we actually return its
  // results below — kept in a separate array so a discarded attempt can't leave behind a
  // duplicate/confusing note alongside the fallback's own note about the same exclusion.
  const primaryNotes: string[] = [];
  const recipes = useFoodFilter
    ? await foodFilterSearch(resolved, input, limit, primaryNotes)
    : await suggestionsSearch(resolved, input, limit, primaryNotes);

  if (recipes.length > 0) {
    notes.push(...primaryNotes);
    return {
      resolvedIngredients: resolved,
      unresolvedIngredients: unresolved,
      matchSource: useFoodFilter ? 'food-filter' : 'suggestions',
      recipes,
      notes,
    };
  }

  // Food-based matching resolved but found nothing useful — fall back to Mealie's normal
  // text search on the original ingredient terms before giving up, same as the fully-unresolved
  // case above. Food-based matching can legitimately come up empty (e.g. a resolved food that no
  // recipe's structured ingredients reference yet), and text search may still surface candidates.
  const fallbackRecipes = await textSearchFallback(ingredientQueries, input, limit, notes);
  if (fallbackRecipes.length > 0) {
    notes.push("No results from Mealie's Recipe Finder for the resolved ingredient(s); fell back to normal recipe text search.");
  }

  return {
    resolvedIngredients: resolved,
    unresolvedIngredients: unresolved,
    matchSource: fallbackRecipes.length > 0 ? 'text-search' : 'none',
    recipes: fallbackRecipes,
    notes,
  };
}

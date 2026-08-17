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

  const candidates = [...bySlug.values()]
    .filter(
      (c) =>
        matchesTaxonomyFilter(c.recipe, 'recipeCategory', input.categories, input.requireAllCategories) &&
        matchesTaxonomyFilter(c.recipe, 'tags', input.tags, input.requireAllTags),
    )
    .sort((a, b) => b.matched.size - a.matched.size);

  return candidates.slice(0, limit).map((c) => toRecipeCandidate(c.recipe, [...c.matched], c.missingFoods, 'suggestions'));
}

/**
 * Strict AND match across every resolved ingredient via Mealie's normal recipe search
 * (GET /api/recipes?foods=...&requireAllFoods=true). Categories/tags are passed straight
 * through to Mealie rather than filtered client-side, since this endpoint supports them natively.
 */
async function foodFilterSearch(
  resolved: ResolvedIngredient[],
  input: FindRecipesForIngredientsInput,
  limit: number,
): Promise<RecipeCandidate[]> {
  const page = await recipesApi.searchRecipesByFilter({
    foods: resolved.map((r) => r.foodId),
    requireAllFoods: true,
    categories: input.categories,
    tags: input.tags,
    requireAllCategories: input.requireAllCategories,
    requireAllTags: input.requireAllTags,
    perPage: limit,
  });

  const matchedNames = resolved.map((r) => r.query);
  return page.items.map((recipe) => toRecipeCandidate(recipe, matchedNames, [], 'food-filter'));
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

  const perCallLimit = terms.length > 1 ? Math.min(limit * OVERFETCH_MULTIPLIER, MAX_OVERFETCH) : limit;

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

  const recipes = useFoodFilter
    ? await foodFilterSearch(resolved, input, limit)
    : await suggestionsSearch(resolved, input, limit, notes);

  return {
    resolvedIngredients: resolved,
    unresolvedIngredients: unresolved,
    matchSource: recipes.length > 0 ? (useFoodFilter ? 'food-filter' : 'suggestions') : 'none',
    recipes,
    notes,
  };
}

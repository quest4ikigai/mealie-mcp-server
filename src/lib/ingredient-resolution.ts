import * as foodsApi from '../api/foods.js';

export type IngredientMatchType = 'exact-name' | 'exact-alternate-name' | 'unique-search-match';

export interface ResolvedIngredient {
  query: string;
  foodId: string;
  foodName: string;
  matchType: IngredientMatchType;
}

export type UnresolvedReason = 'not-found' | 'ambiguous' | 'lookup-failed';

export interface UnresolvedIngredient {
  query: string;
  reason: UnresolvedReason;
  candidates?: string[];
  error?: string;
}

export interface IngredientResolutionResult {
  resolved: ResolvedIngredient[];
  unresolved: UnresolvedIngredient[];
}

const FOOD_SEARCH_PAGE_SIZE = 25;
const MAX_REPORTED_CANDIDATES = 8;

interface FoodRecord {
  id: string;
  name: string;
  pluralName?: string;
  aliases: string[];
}

function toFoodRecord(raw: Record<string, unknown>): FoodRecord {
  const aliases = Array.isArray(raw.aliases)
    ? (raw.aliases as Record<string, unknown>[])
        .map((a) => (typeof a.name === 'string' ? a.name : undefined))
        .filter((name): name is string => Boolean(name))
    : [];
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    pluralName: typeof raw.pluralName === 'string' ? raw.pluralName : undefined,
    aliases,
  };
}

async function resolveOne(query: string): Promise<ResolvedIngredient | UnresolvedIngredient> {
  const key = query.toLowerCase();

  const page = await foodsApi.getFoods({ search: query, perPage: FOOD_SEARCH_PAGE_SIZE });
  const candidates = page.items.map(toFoodRecord);

  if (candidates.length === 0) {
    return { query, reason: 'not-found' };
  }

  const exactName = candidates.filter((f) => f.name.toLowerCase() === key);
  if (exactName.length === 1) {
    return { query, foodId: exactName[0].id, foodName: exactName[0].name, matchType: 'exact-name' };
  }
  if (exactName.length > 1) {
    return {
      query,
      reason: 'ambiguous',
      candidates: exactName.slice(0, MAX_REPORTED_CANDIDATES).map((f) => f.name),
    };
  }

  // Mealie's Food object has no `slug` field (unlike Category/Tag), so the second resolution
  // tier is an exact match on the food's plural name or one of its aliases instead.
  const exactAlternate = candidates.filter(
    (f) => f.pluralName?.toLowerCase() === key || f.aliases.some((a) => a.toLowerCase() === key),
  );
  if (exactAlternate.length === 1) {
    return {
      query,
      foodId: exactAlternate[0].id,
      foodName: exactAlternate[0].name,
      matchType: 'exact-alternate-name',
    };
  }
  if (exactAlternate.length > 1) {
    return {
      query,
      reason: 'ambiguous',
      candidates: exactAlternate.slice(0, MAX_REPORTED_CANDIDATES).map((f) => f.name),
    };
  }

  if (candidates.length === 1) {
    return { query, foodId: candidates[0].id, foodName: candidates[0].name, matchType: 'unique-search-match' };
  }

  return {
    query,
    reason: 'ambiguous',
    candidates: candidates.slice(0, MAX_REPORTED_CANDIDATES).map((f) => f.name),
  };
}

/**
 * Resolves human-readable ingredient names to Mealie Food objects, one Mealie food-search
 * call per (deduplicated) query term — never the full food library. Never picks arbitrarily
 * between multiple plausible matches; those are reported as unresolved/ambiguous instead so
 * the caller can decide.
 */
export async function resolveIngredients(queries: string[]): Promise<IngredientResolutionResult> {
  const uniqueQueries = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  const settled = await Promise.allSettled(uniqueQueries.map(resolveOne));

  const resolved: ResolvedIngredient[] = [];
  const unresolved: UnresolvedIngredient[] = [];

  settled.forEach((result, i) => {
    if (result.status === 'rejected') {
      const reason = result.reason as Error | undefined;
      unresolved.push({ query: uniqueQueries[i], reason: 'lookup-failed', error: reason?.message ?? 'Unknown error' });
      return;
    }
    if ('foodId' in result.value) {
      resolved.push(result.value);
    } else {
      unresolved.push(result.value);
    }
  });

  return { resolved, unresolved };
}

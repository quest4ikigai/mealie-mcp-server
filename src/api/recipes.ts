import { apiGet, apiPost, apiPatch, apiPut, apiPutForm, apiDelete, buildQueryString, PaginatedResult, encodePathSegment } from './client.js';
import { mapWithConcurrency, DEFAULT_DETAIL_FETCH_CONCURRENCY } from '../lib/concurrency.js';


export async function getRecipes(
  params?: {
    search?: string;
    page?: number;
    perPage?: number;
    orderBy?: string;
    orderDirection?: string;
    categories?: string[];
    tags?: string[];
    requireAllTags?: boolean;
    requireAllCategories?: boolean;
  },
): Promise<PaginatedResult<Record<string, unknown>>> {
  const qs = params ? buildQueryString(params) : '';
  return apiGet(`/api/recipes${qs ? `?${qs}` : ''}`);
}

export async function getRecipe(slug: string): Promise<Record<string, unknown>> {
  return apiGet(`/api/recipes/${encodePathSegment(slug, 'slug')}`);
}

interface SettledResult {
  status: 'fulfilled' | 'rejected';
  value?: Record<string, unknown>;
  reason?: unknown;
}

// Bounded concurrency instead of Promise.allSettled: firing every slug's request at once
// overloads Mealie and reliably produces gateway timeouts once the batch gets non-trivially
// large (observed even at 8-9 concurrent full-detail requests), regardless of how many slugs
// were asked for.
export async function getRecipesBatch(
  slugs: string[],
): Promise<Record<string, Record<string, unknown> | { error: string }>> {
  const results = await mapWithConcurrency<string, SettledResult>(
    slugs,
    DEFAULT_DETAIL_FETCH_CONCURRENCY,
    async (slug) => {
      try {
        return { status: 'fulfilled', value: await getRecipe(slug) };
      } catch (error) {
        return { status: 'rejected', reason: error };
      }
    },
  );

  const map: Record<string, Record<string, unknown> | { error: string }> = {};
  for (let i = 0; i < slugs.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      map[slugs[i]] = result.value!;
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : undefined;
      map[slugs[i]] = { error: reason ?? 'Unknown error' };
    }
  }
  return map;
}

// Mealie's POST /api/recipes responds with the created recipe's slug as a bare JSON string
export async function createRecipe(name: string): Promise<string> {
  return apiPost('/api/recipes', { name });
}

export async function patchRecipe(
  slug: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return apiPatch(`/api/recipes/${encodePathSegment(slug, 'slug')}`, data);
}

export async function duplicateRecipe(
  slug: string,
  name?: string,
): Promise<Record<string, unknown>> {
  return apiPost(`/api/recipes/${encodePathSegment(slug, 'slug')}/duplicate`, name ? { name } : undefined);
}

export async function updateRecipeLastMade(slug: string): Promise<Record<string, unknown>> {
  return apiPatch(`/api/recipes/${encodePathSegment(slug, 'slug')}/last-made`, {
    timestamp: new Date().toISOString(),
  });
}

export async function setRecipeImageFromUrl(
  slug: string,
  url: string,
): Promise<Record<string, unknown>> {
  return apiPost(`/api/recipes/${encodePathSegment(slug, 'slug')}/image`, { url });
}

// PUT /api/recipes/{slug}/image takes multipart form data: `image` (file bytes) and `extension`.
export async function uploadRecipeImage(
  slug: string,
  image: Uint8Array<ArrayBuffer>,
  extension: string,
): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append('image', new Blob([image]), `image.${extension}`);
  form.append('extension', extension);
  return apiPutForm(`/api/recipes/${encodePathSegment(slug, 'slug')}/image`, form);
}

export async function deleteRecipeImage(slug: string): Promise<Record<string, unknown>> {
  return apiDelete(`/api/recipes/${encodePathSegment(slug, 'slug')}/image`);
}

export async function deleteRecipe(slug: string): Promise<Record<string, unknown>> {
  return apiDelete(`/api/recipes/${encodePathSegment(slug, 'slug')}`);
}

export async function updateRecipe(
  slug: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return apiPut(`/api/recipes/${encodePathSegment(slug, 'slug')}`, data);
}

export interface RecipeSuggestionItem {
  recipe: Record<string, unknown>;
  missingFoods: Record<string, unknown>[];
  missingTools: Record<string, unknown>[];
}

// GET /api/recipes/suggestions — Mealie's Recipe Finder. Ranks recipes by fewest missing
// foods/tools relative to the given `foods`/`tools` IDs. `includeFoodsOnHand`/`includeToolsOnHand`
// default true on the Mealie side (pulling in the household's declared pantry); we default them
// to false at the call site below so results depend only on what was explicitly asked for.
export async function getRecipeSuggestions(
  params: {
    foods?: string[];
    tools?: string[];
    limit?: number;
    maxMissingFoods?: number;
    maxMissingTools?: number;
    includeFoodsOnHand?: boolean;
    includeToolsOnHand?: boolean;
  },
): Promise<{ items: RecipeSuggestionItem[] }> {
  const qs = buildQueryString(params);
  return apiGet(`/api/recipes/suggestions${qs ? `?${qs}` : ''}`);
}

// GET /api/recipes — same listing endpoint as getRecipes above, but serializes `foods`/`categories`/`tags`
// as repeated query keys (required by Mealie's FastAPI list params) instead of comma-joining, so multi-value
// `foods` filters resolve correctly. Used by find_recipes_for_ingredients for its AND-filter and text-search paths.
export async function searchRecipesByFilter(
  params: {
    search?: string;
    foods?: string[];
    requireAllFoods?: boolean;
    categories?: string[];
    tags?: string[];
    requireAllCategories?: boolean;
    requireAllTags?: boolean;
    perPage?: number;
  },
): Promise<PaginatedResult<Record<string, unknown>>> {
  const qs = buildQueryString(params);
  return apiGet(`/api/recipes${qs ? `?${qs}` : ''}`);
}

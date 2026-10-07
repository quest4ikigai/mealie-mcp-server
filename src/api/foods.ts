import { apiGet, apiPost, apiPut, apiDelete, formatParams, MealieApiError, PaginatedResult, encodePathSegment } from './client.js';
import {
  lookupCandidates,
  LookupValidationError,
  DEFAULT_MAX_MATCHES_PER_QUERY,
  MAX_MATCHES_PER_QUERY_CAP,
  type MatchFieldSpec,
  type MultiQueryLookupResult,
} from '../lib/multi-query-lookup.js';

export interface CreateFoodInput {
  name: string;
  pluralName?: string;
  description?: string;
  aliases?: string[];
  labelId?: string;
}

export interface UpdateFoodInput {
  name?: string;
  pluralName?: string;
  description?: string;
  aliases?: string[];
  labelId?: string | null;
  householdsWithIngredientFood?: string[];
}

// Fields Mealie's PUT /api/foods/{id} accepts (the CreateIngredientFood shape). The GET
// response additionally includes response-only fields (label, createdAt, updatedAt) that
// must not be echoed back in an update payload. `id` IS part of CreateIngredientFood
// (inherited from UnitFoodBase) despite being response-only on other resources — omitting
// it makes Mealie default it to null and write that into the id column on PUT, so it must
// always be carried forward from the existing record.
const UPDATABLE_FOOD_FIELDS = [
  'id',
  'name',
  'pluralName',
  'description',
  'extras',
  'labelId',
  'aliases',
  'householdsWithIngredientFood',
] as const;

function toAliasPayload(aliases: string[]): { name: string }[] {
  return aliases.map((name) => ({ name }));
}

function wrapError(context: string, error: unknown): never {
  if (error instanceof Error) {
    throw new Error(`${context}: ${error.message}`, { cause: error });
  }
  throw new Error(`${context}: ${String(error)}`);
}

export async function getFoods(
  params?: { search?: string; page?: number; perPage?: number },
): Promise<PaginatedResult<Record<string, unknown>>> {
  try {
    return await apiGet<PaginatedResult<Record<string, unknown>>>(
      '/api/foods',
      params ? formatParams(params) : undefined,
    );
  } catch (error) {
    wrapError('Unable to retrieve foods', error);
  }
}

export async function getFood(foodId: string): Promise<Record<string, unknown>> {
  const id = foodId?.trim();
  if (!id) {
    throw new Error('foodId is required.');
  }

  try {
    return await apiGet<Record<string, unknown>>(`/api/foods/${encodePathSegment(id, 'id')}`);
  } catch (error) {
    if (error instanceof MealieApiError && error.status === 404) {
      wrapError(`Food not found: ${id}`, error);
    }
    wrapError(`Unable to retrieve food ${id}`, error);
  }
}

export async function createFood(input: CreateFoodInput): Promise<Record<string, unknown>> {
  const name = input.name?.trim();
  if (!name) {
    throw new Error('Food name cannot be empty.');
  }

  const payload: Record<string, unknown> = { name };
  if (input.pluralName !== undefined) payload.pluralName = input.pluralName;
  if (input.description !== undefined) payload.description = input.description;
  if (input.aliases !== undefined) payload.aliases = toAliasPayload(input.aliases);
  if (input.labelId !== undefined) payload.labelId = input.labelId;

  try {
    return await apiPost<Record<string, unknown>>('/api/foods', payload);
  } catch (error) {
    wrapError('Unable to create food', error);
  }
}

// Mealie's PUT is a full replace of the CreateIngredientFood shape, so fields the
// caller didn't ask to change must be carried forward from the existing record.
function buildUpdatePayload(
  existing: Record<string, unknown>,
  input: UpdateFoodInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of UPDATABLE_FOOD_FIELDS) {
    if (field in existing) payload[field] = existing[field];
  }

  if (input.name !== undefined) payload.name = input.name;
  if (input.pluralName !== undefined) payload.pluralName = input.pluralName;
  if (input.description !== undefined) payload.description = input.description;
  if (input.aliases !== undefined) payload.aliases = toAliasPayload(input.aliases);
  if (input.labelId !== undefined) payload.labelId = input.labelId;
  if (input.householdsWithIngredientFood !== undefined) {
    payload.householdsWithIngredientFood = input.householdsWithIngredientFood;
  }
  return payload;
}

export async function updateFood(
  foodId: string,
  input: UpdateFoodInput,
): Promise<Record<string, unknown>> {
  const id = foodId?.trim();
  if (!id) {
    throw new Error('foodId is required.');
  }

  if (
    input.name === undefined &&
    input.pluralName === undefined &&
    input.description === undefined &&
    input.aliases === undefined &&
    input.labelId === undefined &&
    input.householdsWithIngredientFood === undefined
  ) {
    throw new Error('At least one field must be supplied for an update.');
  }

  try {
    const existing = await apiGet<Record<string, unknown>>(`/api/foods/${encodePathSegment(id, 'id')}`);
    return await apiPut<Record<string, unknown>>(`/api/foods/${encodePathSegment(id, 'id')}`, buildUpdatePayload(existing, input));
  } catch (error) {
    if (error instanceof MealieApiError && error.status === 404) {
      wrapError(`Food not found: ${id}`, error);
    }
    wrapError(`Unable to update food ${id}`, error);
  }
}

// Priority order for get_food_matches ranking: exact/substring name beats exact/substring pluralName
// beats exact/substring alias. Attribute paths are Mealie's queryFilter attribute-chain syntax; "name"
// and "pluralName" are plain columns on ingredient_foods, "aliases.name" traverses the food's alias
// relationship (a real SQLAlchemy relationship, not an association proxy, so this join is supported).
const FOOD_MATCH_FIELDS: MatchFieldSpec[] = [
  { key: 'name', queryFilterAttr: 'name' },
  { key: 'pluralName', queryFilterAttr: 'pluralName' },
  { key: 'alias', queryFilterAttr: 'aliases.name', isAlias: true },
];

export async function getFoodMatches(
  queries: string[],
  options?: { maxMatchesPerQuery?: number },
): Promise<MultiQueryLookupResult> {
  const maxMatchesPerQuery = Math.min(
    Math.max(1, options?.maxMatchesPerQuery ?? DEFAULT_MAX_MATCHES_PER_QUERY),
    MAX_MATCHES_PER_QUERY_CAP,
  );

  try {
    return await lookupCandidates(queries, FOOD_MATCH_FIELDS, maxMatchesPerQuery, async (queryFilter, perPage) => {
      const result = await apiGet<PaginatedResult<Record<string, unknown>>>(
        '/api/foods',
        formatParams({ queryFilter, perPage, page: 1 }),
      );
      return { items: result.items, total: result.total };
    });
  } catch (error) {
    if (error instanceof LookupValidationError) throw error;
    wrapError('Unable to look up food matches', error);
  }
}

export async function deleteFood(foodId: string): Promise<Record<string, unknown>> {
  const id = foodId?.trim();
  if (!id) {
    throw new Error('foodId is required.');
  }

  try {
    return await apiDelete<Record<string, unknown>>(`/api/foods/${encodePathSegment(id, 'id')}`);
  } catch (error) {
    if (error instanceof MealieApiError && error.status === 404) {
      wrapError(`Food not found: ${id}`, error);
    }
    wrapError(
      `Unable to delete food ${id}. If this food is still referenced by existing recipes or ` +
        'shopping list items, Mealie will refuse to delete it',
      error,
    );
  }
}

// Probed live against Mealie v3.20.1 with throwaway data:
// - Recipe ingredient rows referencing the from-food are re-pointed to the to-food.
// - The from-food is deleted; its name and its aliases are NOT kept on the to-food.
// - Shopping list items referencing the from-food make the merge fail with a 500
//   ("Failed to merge foods") and leave both foods untouched. Merging succeeds once
//   those items are removed.
export async function mergeFoods(fromFoodId: string, toFoodId: string): Promise<Record<string, unknown>> {
  const fromId = fromFoodId?.trim();
  const toId = toFoodId?.trim();
  if (!fromId) {
    throw new Error('fromFoodId is required.');
  }
  if (!toId) {
    throw new Error('toFoodId is required.');
  }
  if (fromId === toId) {
    throw new Error('fromFoodId and toFoodId must be different foods.');
  }

  await getFood(fromId);
  await getFood(toId);

  try {
    await apiPut('/api/foods/merge', { fromFood: fromId, toFood: toId });
  } catch (error) {
    wrapError(
      `Unable to merge food ${fromId} into ${toId}. If shopping list items still reference the from-food, ` +
        'Mealie fails the merge; remove those items and retry',
      error,
    );
  }

  try {
    await apiGet(`/api/foods/${encodePathSegment(fromId, 'id')}`);
  } catch (error) {
    if (error instanceof MealieApiError && error.status === 404) {
      return getFood(toId);
    }
    wrapError(`Merged, but unable to verify that food ${fromId} is gone`, error);
  }
  throw new Error(`Mealie reported a successful merge, but food ${fromId} still exists.`);
}

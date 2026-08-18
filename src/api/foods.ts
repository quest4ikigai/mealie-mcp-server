import { apiGet, apiPost, apiPut, apiDelete, formatParams, MealieApiError, PaginatedResult } from './client.js';

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
}

// Fields Mealie's PUT /api/foods/{id} accepts (the CreateIngredientFood shape). The GET
// response additionally includes response-only fields (id, label, createdAt, updatedAt)
// that must not be echoed back in an update payload.
const UPDATABLE_FOOD_FIELDS = [
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
    return await apiGet<Record<string, unknown>>(`/api/foods/${id}`);
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
    input.labelId === undefined
  ) {
    throw new Error('At least one field must be supplied for an update.');
  }

  try {
    const existing = await apiGet<Record<string, unknown>>(`/api/foods/${id}`);

    // Mealie's PUT is a full replace of the CreateIngredientFood shape, so fields the
    // caller didn't ask to change must be carried forward from the existing record.
    const payload: Record<string, unknown> = {};
    for (const field of UPDATABLE_FOOD_FIELDS) {
      if (field in existing) payload[field] = existing[field];
    }

    if (input.name !== undefined) payload.name = input.name;
    if (input.pluralName !== undefined) payload.pluralName = input.pluralName;
    if (input.description !== undefined) payload.description = input.description;
    if (input.aliases !== undefined) payload.aliases = toAliasPayload(input.aliases);
    if (input.labelId !== undefined) payload.labelId = input.labelId;

    return await apiPut<Record<string, unknown>>(`/api/foods/${id}`, payload);
  } catch (error) {
    if (error instanceof MealieApiError && error.status === 404) {
      wrapError(`Food not found: ${id}`, error);
    }
    wrapError(`Unable to update food ${id}`, error);
  }
}

export async function deleteFood(foodId: string): Promise<Record<string, unknown>> {
  const id = foodId?.trim();
  if (!id) {
    throw new Error('foodId is required.');
  }

  try {
    return await apiDelete<Record<string, unknown>>(`/api/foods/${id}`);
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

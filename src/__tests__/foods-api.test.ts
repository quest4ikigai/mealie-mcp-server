import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../api/client.js')>('../api/client.js');
  return {
    ...actual,
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPut: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import { apiGet, apiPost, apiPut, apiDelete, MealieApiError } from '../api/client.js';
import { getFoods, getFood, createFood, updateFood, deleteFood } from '../api/foods.js';

const mockGet = vi.mocked(apiGet);
const mockPost = vi.mocked(apiPost);
const mockPut = vi.mocked(apiPut);
const mockDelete = vi.mocked(apiDelete);

function existingFood(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'food-1',
    name: 'Onion',
    pluralName: 'Onions',
    description: 'A pungent bulb vegetable',
    extras: {},
    labelId: 'label-1',
    label: { id: 'label-1', name: 'Produce', color: '#00FF00' },
    aliases: [{ name: 'yellow onion' }],
    householdsWithIngredientFood: ['household-1'],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    ...overrides,
  };
}

function paginated<T>(items: T[]): { items: T[]; total: number; page: number; size: number } {
  return { items, total: items.length, page: 1, size: items.length };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getFoods', () => {
  it('calls the foods endpoint with no params when none are given', async () => {
    mockGet.mockResolvedValue(paginated([]));
    await getFoods();
    expect(mockGet).toHaveBeenCalledWith('/api/foods', undefined);
  });

  it('passes the search parameter through', async () => {
    mockGet.mockResolvedValue(paginated([]));
    await getFoods({ search: 'onion' });
    expect(mockGet).toHaveBeenCalledWith('/api/foods', { search: 'onion' });
  });

  it('passes pagination parameters through', async () => {
    mockGet.mockResolvedValue(paginated([]));
    await getFoods({ page: 2, perPage: 25 });
    expect(mockGet).toHaveBeenCalledWith('/api/foods', { page: '2', perPage: '25' });
  });

  it('returns the items and pagination metadata supplied by Mealie', async () => {
    const result = { items: [{ id: 'food-1', name: 'Onion' }], total: 1, page: 1, size: 1 };
    mockGet.mockResolvedValue(result);
    await expect(getFoods()).resolves.toEqual(result);
  });

  it('propagates API errors with added context', async () => {
    mockGet.mockRejectedValue(new MealieApiError(500, 'Internal Server Error'));
    await expect(getFoods()).rejects.toThrow(/Unable to retrieve foods/);
    await expect(getFoods()).rejects.toThrow(/500/);
    await expect(getFoods()).rejects.toThrow(/Internal Server Error/);
  });
});

describe('getFood', () => {
  it('retrieves a food by id', async () => {
    const food = existingFood();
    mockGet.mockResolvedValue(food);
    await expect(getFood('food-1')).resolves.toEqual(food);
    expect(mockGet).toHaveBeenCalledWith('/api/foods/food-1');
  });

  it('rejects a missing id without calling the API', async () => {
    await expect(getFood(undefined as unknown as string)).rejects.toThrow(/foodId is required/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('rejects a blank id without calling the API', async () => {
    await expect(getFood('   ')).rejects.toThrow(/foodId is required/);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('propagates a not-found error clearly', async () => {
    mockGet.mockRejectedValue(new MealieApiError(404, 'Not Found'));
    await expect(getFood('missing-id')).rejects.toThrow(/Food not found/);
    await expect(getFood('missing-id')).rejects.toThrow(/404/);
  });

  it('propagates other API errors', async () => {
    mockGet.mockRejectedValue(new MealieApiError(500, 'Internal Server Error'));
    await expect(getFood('food-1')).rejects.toThrow(/Unable to retrieve food/);
    await expect(getFood('food-1')).rejects.toThrow(/500/);
  });
});

describe('createFood', () => {
  it('creates a food from just a name', async () => {
    mockPost.mockResolvedValue(existingFood({ name: 'Garlic' }));
    await createFood({ name: 'Garlic' });
    expect(mockPost).toHaveBeenCalledWith('/api/foods', { name: 'Garlic' });
  });

  it('creates a food with all supported fields', async () => {
    mockPost.mockResolvedValue(existingFood());
    await createFood({
      name: 'Onion',
      pluralName: 'Onions',
      description: 'A pungent bulb vegetable',
      aliases: ['yellow onion', 'scallion'],
      labelId: 'label-1',
    });
    expect(mockPost).toHaveBeenCalledWith('/api/foods', {
      name: 'Onion',
      pluralName: 'Onions',
      description: 'A pungent bulb vegetable',
      aliases: [{ name: 'yellow onion' }, { name: 'scallion' }],
      labelId: 'label-1',
    });
  });

  it('converts a string[] of aliases into Mealie\'s alias object shape', async () => {
    mockPost.mockResolvedValue(existingFood());
    await createFood({ name: 'Onion', aliases: ['scallion'] });
    const [, body] = mockPost.mock.calls[0];
    expect(body).toMatchObject({ aliases: [{ name: 'scallion' }] });
  });

  it('assigns an existing food label by id', async () => {
    mockPost.mockResolvedValue(existingFood());
    await createFood({ name: 'Onion', labelId: 'label-1' });
    const [, body] = mockPost.mock.calls[0];
    expect(body).toMatchObject({ labelId: 'label-1' });
  });

  it('rejects a blank name without calling the API', async () => {
    await expect(createFood({ name: '   ' })).rejects.toThrow(/cannot be empty/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects a missing name without calling the API', async () => {
    await expect(createFood({ name: undefined as unknown as string })).rejects.toThrow(/cannot be empty/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('propagates API errors', async () => {
    mockPost.mockRejectedValue(new MealieApiError(400, 'Bad Request'));
    await expect(createFood({ name: 'Onion' })).rejects.toThrow(/Unable to create food/);
    await expect(createFood({ name: 'Onion' })).rejects.toThrow(/400/);
  });
});

describe('updateFood', () => {
  it('rejects an update with no fields, without calling the API', async () => {
    await expect(updateFood('food-1', {})).rejects.toThrow(/At least one field must be supplied/);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects a missing id without calling the API', async () => {
    await expect(updateFood(undefined as unknown as string, { name: 'Onion' })).rejects.toThrow(
      /foodId is required/,
    );
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches the existing record and merges the requested name change, preserving everything else', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood({ name: 'Yellow Onion' }));

    await updateFood('food-1', { name: 'Yellow Onion' });

    expect(mockGet).toHaveBeenCalledWith('/api/foods/food-1');
    expect(mockPut).toHaveBeenCalledWith('/api/foods/food-1', {
      name: 'Yellow Onion',
      pluralName: 'Onions',
      description: 'A pungent bulb vegetable',
      extras: {},
      labelId: 'label-1',
      aliases: [{ name: 'yellow onion' }],
      householdsWithIngredientFood: ['household-1'],
    });
  });

  it('updates pluralName while preserving other fields', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood());
    await updateFood('food-1', { pluralName: 'Yellow Onions' });
    const [, body] = mockPut.mock.calls[0];
    expect(body).toMatchObject({ pluralName: 'Yellow Onions', name: 'Onion' });
  });

  it('updates description while preserving other fields', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood());
    await updateFood('food-1', { description: 'New description' });
    const [, body] = mockPut.mock.calls[0];
    expect(body).toMatchObject({ description: 'New description', name: 'Onion' });
  });

  it('updates several fields together in a single PUT', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood());

    await updateFood('food-1', { name: 'Yellow Onion', description: 'New description', labelId: 'label-2' });

    expect(mockPut).toHaveBeenCalledTimes(1);
    const [, body] = mockPut.mock.calls[0];
    expect(body).toMatchObject({
      name: 'Yellow Onion',
      description: 'New description',
      labelId: 'label-2',
      pluralName: 'Onions',
      aliases: [{ name: 'yellow onion' }],
    });
  });

  it('preserves existing aliases when aliases is omitted', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood());
    await updateFood('food-1', { description: 'New description' });
    const [, body] = mockPut.mock.calls[0];
    expect(body).toMatchObject({ aliases: [{ name: 'yellow onion' }] });
  });

  it('replaces the alias collection when aliases is provided', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood());
    await updateFood('food-1', { aliases: ['scallion', 'green onion'] });
    const [, body] = mockPut.mock.calls[0];
    expect(body).toMatchObject({ aliases: [{ name: 'scallion' }, { name: 'green onion' }] });
  });

  it('clears aliases when an empty array is provided', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood());
    await updateFood('food-1', { aliases: [] });
    const [, body] = mockPut.mock.calls[0];
    expect(body).toMatchObject({ aliases: [] });
  });

  it('preserves the existing label when labelId is omitted', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood());
    await updateFood('food-1', { description: 'New description' });
    const [, body] = mockPut.mock.calls[0];
    expect(body).toMatchObject({ labelId: 'label-1' });
  });

  it('clears the label when labelId is explicitly null', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood({ labelId: null, label: null }));
    await updateFood('food-1', { labelId: null });
    const [, body] = mockPut.mock.calls[0];
    expect(body).toMatchObject({ labelId: null });
  });

  it('strips response-only fields (id, label, createdAt, updatedAt) from the outgoing payload', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockResolvedValue(existingFood());
    await updateFood('food-1', { description: 'New description' });
    const [, body] = mockPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('label');
    expect(body).not.toHaveProperty('createdAt');
    expect(body).not.toHaveProperty('updatedAt');
  });

  it('propagates an error fetching the existing record', async () => {
    mockGet.mockRejectedValue(new MealieApiError(404, 'Not Found'));
    await expect(updateFood('missing-id', { name: 'Onion' })).rejects.toThrow(/Food not found/);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('propagates an error from the PUT call', async () => {
    mockGet.mockResolvedValue(existingFood());
    mockPut.mockRejectedValue(new MealieApiError(400, 'Bad Request'));
    await expect(updateFood('food-1', { name: 'Onion' })).rejects.toThrow(/Unable to update food/);
    await expect(updateFood('food-1', { name: 'Onion' })).rejects.toThrow(/400/);
  });
});

describe('deleteFood', () => {
  it('deletes a food by id', async () => {
    mockDelete.mockResolvedValue({ id: 'food-1' });
    await expect(deleteFood('food-1')).resolves.toEqual({ id: 'food-1' });
    expect(mockDelete).toHaveBeenCalledWith('/api/foods/food-1');
  });

  it('rejects a missing id without calling the API', async () => {
    await expect(deleteFood(undefined as unknown as string)).rejects.toThrow(/foodId is required/);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('rejects a blank id without calling the API', async () => {
    await expect(deleteFood('  ')).rejects.toThrow(/foodId is required/);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns a clear error when Mealie refuses to delete a referenced food', async () => {
    mockDelete.mockRejectedValue(
      new MealieApiError(400, 'update or delete on table "ingredient_foods" violates foreign key constraint'),
    );
    await expect(deleteFood('food-1')).rejects.toThrow(/still referenced/);
    await expect(deleteFood('food-1')).rejects.toThrow(/foreign key constraint/);
  });

  it('propagates other API errors', async () => {
    mockDelete.mockRejectedValue(new MealieApiError(500, 'Internal Server Error'));
    await expect(deleteFood('food-1')).rejects.toThrow(/Unable to delete food/);
    await expect(deleteFood('food-1')).rejects.toThrow(/500/);
  });
});

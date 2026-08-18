import { apiGet, formatParams, PaginatedResult } from './client.js';

export function getFoods(
  params?: { search?: string; page?: number; perPage?: number },
): Promise<PaginatedResult<Record<string, unknown>>> {
  return apiGet<PaginatedResult<Record<string, unknown>>>(
    '/api/foods',
    params ? formatParams(params) : undefined,
  );
}

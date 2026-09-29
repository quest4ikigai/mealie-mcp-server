import { apiGet, apiPost, formatParams, PaginatedResult } from '../api/client.js';

export function getTools(params?: { page?: number; perPage?: number; search?: string }): Promise<PaginatedResult<Record<string, unknown>>> {
  return apiGet<PaginatedResult<Record<string, unknown>>>('/api/organizers/tools', params ? formatParams(params) : undefined);
}

export function createTool(name: string): Promise<Record<string, unknown>> {
  return apiPost<Record<string, unknown>>('/api/organizers/tools', { name });
}

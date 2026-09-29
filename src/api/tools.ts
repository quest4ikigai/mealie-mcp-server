import { apiGet, apiPost, apiPut, apiDelete, formatParams, MealieApiError, PaginatedResult } from './client.js';
import {
  lookupCandidates,
  LookupValidationError,
  DEFAULT_MAX_MATCHES_PER_QUERY,
  MAX_MATCHES_PER_QUERY_CAP,
  type MatchFieldSpec,
  type MultiQueryLookupResult,
} from '../lib/multi-query-lookup.js';

export interface UpdateToolInput {
  name?: string;
}

// Fields Mealie's PUT /api/organizers/tools/{id} accepts. The PUT is a full replace and the schema
// includes `householdsWithTool` (household "on hand" ownership), which must be carried forward from
// the existing record so a rename never silently clears it. Response-only fields are not echoed back.
const UPDATABLE_TOOL_FIELDS = ['id', 'name', 'householdsWithTool'] as const;

function wrapError(context: string, error: unknown): never {
  if (error instanceof Error) {
    throw new Error(`${context}: ${error.message}`, { cause: error });
  }
  throw new Error(`${context}: ${String(error)}`);
}

export async function getTools(
  params?: { search?: string; page?: number; perPage?: number },
): Promise<PaginatedResult<Record<string, unknown>>> {
  try {
    return await apiGet<PaginatedResult<Record<string, unknown>>>(
      '/api/organizers/tools',
      params ? formatParams(params) : undefined,
    );
  } catch (error) {
    wrapError('Unable to retrieve tools', error);
  }
}

export async function getTool(toolId: string): Promise<Record<string, unknown>> {
  const id = toolId?.trim();
  if (!id) {
    throw new Error('toolId is required.');
  }

  try {
    return await apiGet<Record<string, unknown>>(`/api/organizers/tools/${id}`);
  } catch (error) {
    if (error instanceof MealieApiError && error.status === 404) {
      wrapError(`Tool not found: ${id}`, error);
    }
    wrapError(`Unable to retrieve tool ${id}`, error);
  }
}

export async function createTool(name: string): Promise<Record<string, unknown>> {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new Error('Tool name cannot be empty.');
  }

  try {
    return await apiPost<Record<string, unknown>>('/api/organizers/tools', { name: trimmed });
  } catch (error) {
    wrapError('Unable to create tool', error);
  }
}

export async function updateTool(toolId: string, input: UpdateToolInput): Promise<Record<string, unknown>> {
  const id = toolId?.trim();
  if (!id) {
    throw new Error('toolId is required.');
  }
  if (input.name === undefined) {
    throw new Error('At least one field must be supplied for an update.');
  }
  const name = input.name.trim();
  if (!name) {
    throw new Error('Tool name cannot be empty.');
  }

  try {
    const existing = await apiGet<Record<string, unknown>>(`/api/organizers/tools/${id}`);

    const payload: Record<string, unknown> = {};
    for (const field of UPDATABLE_TOOL_FIELDS) {
      if (field in existing) payload[field] = existing[field];
    }
    payload.name = name;

    return await apiPut<Record<string, unknown>>(`/api/organizers/tools/${id}`, payload);
  } catch (error) {
    if (error instanceof MealieApiError && error.status === 404) {
      wrapError(`Tool not found: ${id}`, error);
    }
    wrapError(`Unable to update tool ${id}`, error);
  }
}

export async function deleteTool(toolId: string): Promise<Record<string, unknown>> {
  const id = toolId?.trim();
  if (!id) {
    throw new Error('toolId is required.');
  }

  try {
    return await apiDelete<Record<string, unknown>>(`/api/organizers/tools/${id}`);
  } catch (error) {
    if (error instanceof MealieApiError && error.status === 404) {
      wrapError(`Tool not found: ${id}`, error);
    }
    wrapError(`Unable to delete tool ${id}. Mealie may refuse to delete a tool that cannot be removed`, error);
  }
}

// Priority order for get_tool_matches ranking: name, then slug. Plain string matching only.
const TOOL_MATCH_FIELDS: MatchFieldSpec[] = [
  { key: 'name', queryFilterAttr: 'name' },
  { key: 'slug', queryFilterAttr: 'slug' },
];

export async function getToolMatches(
  queries: string[],
  options?: { maxMatchesPerQuery?: number },
): Promise<MultiQueryLookupResult> {
  const maxMatchesPerQuery = Math.min(
    Math.max(1, options?.maxMatchesPerQuery ?? DEFAULT_MAX_MATCHES_PER_QUERY),
    MAX_MATCHES_PER_QUERY_CAP,
  );

  try {
    return await lookupCandidates(queries, TOOL_MATCH_FIELDS, maxMatchesPerQuery, async (queryFilter, perPage) => {
      const result = await apiGet<PaginatedResult<Record<string, unknown>>>(
        '/api/organizers/tools',
        formatParams({ queryFilter, perPage, page: 1 }),
      );
      return { items: result.items, total: result.total };
    });
  } catch (error) {
    if (error instanceof LookupValidationError) throw error;
    wrapError('Unable to look up tool matches', error);
  }
}

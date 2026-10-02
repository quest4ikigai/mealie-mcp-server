import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as toolsApi from '../api/tools.js';
import {
  MAX_QUERIES_PER_CALL,
  MAX_QUERY_LENGTH,
  DEFAULT_MAX_MATCHES_PER_QUERY,
  MAX_MATCHES_PER_QUERY_CAP,
} from '../lib/multi-query-lookup.js';

function successResponse(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

function errorResponse(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function registerToolTools(server: McpServer): void {
  // @endpoints GET /api/organizers/tools
  server.tool(
    'get_tools',
    'Search or list canonical Mealie Tool organizers (kitchen equipment, e.g. "Whisk", "Sheet Pan") with plain ' +
      'pagination. Search uses Mealie\'s native name-based search. Read-only. For resolving several ' +
      'already-decided equipment names at once, prefer get_tool_matches.',
    {
      search: z.string().optional().describe('Matched against the tool name, per Mealie\'s search behavior.'),
      page: z.number().optional(),
      perPage: z.number().optional(),
    },
    async (params) => {
      try {
        return successResponse(await toolsApi.getTools(params));
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/organizers/tools/{id}
  server.tool(
    'get_tool',
    'Retrieves a single Mealie Tool organizer by ID, including metadata such as householdsWithTool when present.',
    { toolId: z.string().uuid().describe('UUID of the tool to retrieve.') },
    async ({ toolId }) => {
      try {
        return successResponse(await toolsApi.getTool(toolId));
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/organizers/tools (with queryFilter)
  server.tool(
    'get_tool_matches',
    'Finds existing canonical Mealie Tool organizer candidates for multiple equipment names in one call, ' +
      'matching against tool name and slug. You decide which equipment a recipe needs (e.g. that it needs a ' +
      'whisk); this tool only finds the canonical organizer for a name you already chose. Returns ranked ' +
      'candidates per query (exact matches before substring matches, name before slug) and never picks a ' +
      'winner. Each query\'s result includes truncated: true when more candidates may exist than were returned. ' +
      'Deterministic string matching only — no fuzzy or semantic equipment inference — and it never creates, ' +
      'updates, or deletes anything. Use before create_tool.',
    {
      queries: z
        .array(z.string().trim().min(1, 'Queries cannot be blank.').max(MAX_QUERY_LENGTH))
        .min(1)
        .max(MAX_QUERIES_PER_CALL)
        .describe(
          `Tool names to resolve, e.g. ["whisk", "sheet pan"]. 1-${MAX_QUERIES_PER_CALL} plain lookup strings ` +
            '(not search syntax) — duplicates (case-insensitive) are resolved once but still returned once per ' +
            'input entry.',
        ),
      maxMatchesPerQuery: z
        .number()
        .int()
        .min(1)
        .max(MAX_MATCHES_PER_QUERY_CAP)
        .optional()
        .describe(
          `Maximum ranked candidates to return per query (default ${DEFAULT_MAX_MATCHES_PER_QUERY}, capped at ` +
            `${MAX_MATCHES_PER_QUERY_CAP}).`,
        ),
    },
    async ({ queries, maxMatchesPerQuery }) => {
      try {
        return successResponse(await toolsApi.getToolMatches(queries, { maxMatchesPerQuery }));
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints POST /api/organizers/tools
  server.tool(
    'create_tool',
    'Creates a canonical Mealie Tool organizer when no appropriate one exists. Call get_tool_matches first to ' +
      'check whether an existing Tool already covers this equipment — creating a duplicate fragments the shared ' +
      'vocabulary. This tool does not manage household "on hand" ownership.',
    { name: z.string().describe('Name of the new tool. Cannot be blank.') },
    async ({ name }) => {
      try {
        return successResponse(await toolsApi.createTool(name));
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/organizers/tools/{id}, PUT /api/organizers/tools/{id}
  server.tool(
    'update_tool',
    'Renames an existing Mealie Tool organizer. Reads the current Tool first and carries forward its existing ' +
      'householdsWithTool ownership metadata, since Mealie\'s PUT is a full replacement; household ownership ' +
      'itself cannot be changed here. Tools are shared by every recipe that uses them, so rename deliberately.',
    {
      toolId: z.string().uuid().describe('UUID of the tool to update.'),
      name: z.string().optional().describe('New name. At least one update field is required.'),
    },
    async ({ toolId, ...rest }) => {
      try {
        return successResponse(await toolsApi.updateTool(toolId, rest));
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints DELETE /api/organizers/tools/{id}
  server.tool(
    'delete_tool',
    'DESTRUCTIVE and irreversible: permanently deletes a Mealie Tool organizer. Use get_tool first to verify ' +
      'this is the exact Tool intended. If Mealie refuses the deletion, its error is surfaced unchanged.',
    { toolId: z.string().uuid().describe('UUID of the tool to delete.') },
    async ({ toolId }) => {
      try {
        return successResponse(await toolsApi.deleteTool(toolId));
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}

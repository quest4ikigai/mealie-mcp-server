import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as foodsApi from '../api/foods.js';

function successResponse(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

function errorResponse(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

const aliasesParamSchema = z
  .array(z.string())
  .describe(
    'Alternate names Mealie should also recognize for this food (e.g. "scallions" as an alias for ' +
      '"green onion"), given as plain strings — converted internally to the alias object shape Mealie expects.',
  );

export function registerFoodTools(server: McpServer): void {
  server.tool(
    'get_foods',
    'Lists and searches the household\'s foods (reusable structured ingredient entities such as "chicken breast" ' +
      'or "onion"). This is the primary tool for resolving a human-readable food name to an existing Mealie food ' +
      'ID — search here before calling create_food, since the name or one of its aliases may already exist. ' +
      'Performs no fuzzy matching itself; matching is delegated entirely to Mealie\'s search.',
    {
      search: z
        .string()
        .optional()
        .describe('Matches against food names and aliases, per Mealie\'s search behavior.'),
      page: z.number().optional(),
      perPage: z.number().optional(),
    },
    async (params) => {
      try {
        const result = await foodsApi.getFoods(params);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'get_food',
    'Retrieves a single food by ID, including its aliases and label information when present.',
    { foodId: z.string().describe('UUID of the food to retrieve.') },
    async ({ foodId }) => {
      try {
        const result = await foodsApi.getFood(foodId);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'create_food',
    'Creates a new food. Call get_foods first to check whether an existing food or alias already covers this ' +
      'name — creating a duplicate food fragments the taxonomy instead of reusing what is already there.',
    {
      name: z.string().describe('Name of the new food. Cannot be blank.'),
      pluralName: z.string().optional().describe('Plural form of the name, if different.'),
      description: z.string().optional(),
      aliases: aliasesParamSchema.optional(),
      labelId: z.string().optional().describe('ID of an existing food label to assign. Does not create a new label.'),
    },
    async (params) => {
      try {
        const result = await foodsApi.createFood(params);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'update_food',
    'Updates an existing food. Fields left unspecified keep their current value. Sufficient for adding an alias: ' +
      'get_food the current record, append to its existing aliases, and pass the complete list back here.',
    {
      foodId: z.string().describe('UUID of the food to update.'),
      name: z.string().optional(),
      pluralName: z.string().optional(),
      description: z.string().optional(),
      aliases: aliasesParamSchema
        .optional()
        .describe(
          aliasesParamSchema.description +
            ' Replaces the food\'s entire alias collection when provided — pass an empty array to clear all ' +
            'aliases, or omit this field entirely to leave existing aliases untouched.',
        ),
      labelId: z
        .string()
        .nullable()
        .optional()
        .describe(
          'ID of an existing food label to assign. Pass null to clear the food\'s label, or omit to leave the ' +
            'current label unchanged.',
        ),
    },
    async ({ foodId, ...rest }) => {
      try {
        const result = await foodsApi.updateFood(foodId, rest);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'delete_food',
    'DESTRUCTIVE and irreversible: permanently deletes a food. Use get_food first to verify this is the exact ' +
      'food intended. Deleting a food may affect recipes and shopping list items that reference it — Mealie may ' +
      'refuse the deletion in that case, leaving the food intact.',
    { foodId: z.string().describe('UUID of the food to delete.') },
    async ({ foodId }) => {
      try {
        const result = await foodsApi.deleteFood(foodId);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as categoriesApi from '../api/categories.js';

export function registerCategoryTools(server: McpServer): void {
  // @endpoints GET /api/organizers/categories
  server.tool(
    'get_categories',
    'Lists and searches the household\'s recipe categories with pagination.',
    { page: z.number().optional(), perPage: z.number().optional() },
    async (params) => {
      try {
        const result = await categoriesApi.getCategories(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints GET /api/organizers/categories/empty
  server.tool(
    'get_empty_categories',
    'Returns categories that have no recipes assigned.',
    {},
    async () => {
      try {
        const result = await categoriesApi.getEmptyCategories();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints POST /api/organizers/categories
  server.tool(
    'create_category',
    'Creates a new recipe category.',
    { name: z.string() },
    async (params) => {
      try {
        const result = await categoriesApi.createCategory(params.name);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints GET /api/organizers/categories/{id}
  server.tool(
    'get_category',
    'Retrieves a single category by its UUID.',
    { categoryId: z.string() },
    async (params) => {
      try {
        const result = await categoriesApi.getCategory(params.categoryId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints GET /api/organizers/categories/slug/{slug}
  server.tool(
    'get_category_by_slug',
    'Retrieves a single category by its URL slug.',
    { categorySlug: z.string() },
    async (params) => {
      try {
        const result = await categoriesApi.getCategoryBySlug(params.categorySlug);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints PUT /api/organizers/categories/{id}
  server.tool(
    'update_category',
    'Updates a category\'s name.',
    { categoryId: z.string(), name: z.string().optional() },
    async (params) => {
      try {
        const data: Record<string, unknown> = {};
        if (params.name !== undefined) data.name = params.name;
        const result = await categoriesApi.updateCategory(params.categoryId, data);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints DELETE /api/organizers/categories/{id}
  server.tool(
    'delete_category',
    'Deletes a category. Mealie may refuse if recipes still reference it.',
    { categoryId: z.string() },
    async (params) => {
      try {
        const result = await categoriesApi.deleteCategory(params.categoryId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );
}

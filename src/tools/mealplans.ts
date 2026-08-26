import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as mealplansApi from '../api/mealplans.js';
import { getRecipesBatch } from '../api/recipes.js';

export function registerMealplanTools(server: McpServer) {
  // @endpoints GET /api/households/mealplans
  server.tool(
    'get_all_mealplans',
    'Lists meal plans with optional date range filtering and pagination.',
    {
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      page: z.number().optional(),
      perPage: z.number().optional(),
    },
    async (params) => {
      try {
        const result = await mealplansApi.getMealplans(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints GET /api/households/mealplans, GET /api/recipes/{slug}
  server.tool(
    'get_mealplan_with_recipes',
    'Returns meal plans with embedded recipe details (full recipe data fetched via batch requests with bounded concurrency).',
    {
      startDate: z.string(),
      endDate: z.string(),
    },
    async (params) => {
      try {
        const mealplansResult = await mealplansApi.getMealplans({ startDate: params.startDate, endDate: params.endDate });
        const filtered = mealplansResult.items.filter(
          (item) => {
            const date = item.date as string | undefined;
            return date !== undefined && date >= params.startDate && date <= params.endDate;
          },
        );

        const recipeIds = new Set<string>();
        for (const item of filtered) {
          const recipeId = item.recipeId as string | undefined;
          const recipeSlug = item.recipeSlug as string | undefined;
          if (recipeId) recipeIds.add(recipeId);
          if (recipeSlug) recipeIds.add(recipeSlug);
        }

        const recipeMap = recipeIds.size > 0 ? await getRecipesBatch(Array.from(recipeIds)) : {};

        const enriched = filtered.map((item) => {
          const recipeId = (item.recipeId as string) || (item.recipeSlug as string);
          if (recipeId && recipeMap[recipeId]) {
            return { ...item, recipe: recipeMap[recipeId] };
          }
          return item;
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(enriched) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints POST /api/households/mealplans
  server.tool(
    'create_mealplan',
    'Creates a single meal plan entry for a given date.',
    {
      date: z.string(),
      recipeId: z.string().optional(),
      title: z.string().optional(),
      entryType: z.string().default('breakfast'),
    },
    async (params) => {
      try {
        const result = await mealplansApi.createMealplan(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints POST /api/households/mealplans
  server.tool(
    'create_mealplan_bulk',
    'Creates multiple meal plan entries at once via concurrent requests.',
    {
      entries: z.array(
        z.object({
          date: z.string(),
          recipeId: z.string().optional(),
          title: z.string().optional(),
          entryType: z.string().default('breakfast'),
        }),
      ),
    },
    async (params) => {
      try {
        const results = await Promise.all(
          params.entries.map((entry) => mealplansApi.createMealplan(entry)),
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ message: `Successfully created ${results.length} entries` }) }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints GET /api/households/mealplans/today
  server.tool(
    'get_todays_mealplan',
    'Returns today\'s meal plan.',
    {},
    async () => {
      try {
        const result = await mealplansApi.getTodaysMealplan();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );
}

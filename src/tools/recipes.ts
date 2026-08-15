import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as recipesApi from '../api/recipes.js';
import { buildTaxonomyPatch, updateRecipeTaxonomy, updateRecipeTaxonomyBatch } from '../lib/recipe-taxonomy.js';

const taxonomyModeSchema = z
  .enum(['merge', 'replace'])
  .describe(
    'merge (default) adds the given categories/tags to whatever the recipe already has. ' +
      'replace overwrites the corresponding collection with exactly the given list — ' +
      'an empty array in replace mode clears that collection entirely.',
  );

const createMissingSchema = z
  .boolean()
  .describe(
    'When true, any named category/tag that does not already exist in Mealie is created automatically. ' +
      'When false (default), unknown names cause the call to fail with an error listing the unresolved values.',
  );

const categoriesParamSchema = z
  .array(z.string())
  .describe(
    'Categories to assign, each given as a name, slug, or ID (matched case-insensitively by name/slug). ' +
      'Categories are broad groupings (e.g. "Dinner", "Dessert") as opposed to Tags, which are more specific ' +
      'attributes (e.g. "Quick", "Dairy-Free"). Omit this field to leave the recipe\'s categories unchanged. ' +
      'Passing an empty array with mode "replace" clears all categories from the recipe — use with care.',
  );

const tagsParamSchema = z
  .array(z.string())
  .describe(
    'Tags to assign, each given as a name, slug, or ID (matched case-insensitively by name/slug). ' +
      'Tags are specific, free-form attributes (e.g. "Quick", "Dairy-Free") as opposed to Categories, which are ' +
      'broad groupings (e.g. "Dinner", "Dessert"). Omit this field to leave the recipe\'s tags unchanged. ' +
      'Passing an empty array with mode "replace" clears all tags from the recipe — use with care.',
  );

const conciseFields = [
  'name',
  'slug',
  'recipeServings',
  'recipeYieldQuantity',
  'recipeYield',
  'totalTime',
  'rating',
  'recipeIngredient',
  'lastMade',
] as const;

function successResponse(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
  };
}

function errorResponse(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function registerRecipeTools(server: McpServer) {
  server.tool(
    'get_recipes',
    {
      search: z.string().optional(),
      page: z.number().optional(),
      perPage: z.number().optional(),
      categories: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      requireAllTags: z.boolean().optional(),
      requireAllCategories: z.boolean().optional(),
    },
    async (params) => {
      try {
        const result = await recipesApi.getRecipes(params);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'get_recipe_detailed',
    { slug: z.string() },
    async ({ slug }) => {
      try {
        const result = await recipesApi.getRecipe(slug);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'get_recipe_concise',
    { slug: z.string() },
    async ({ slug }) => {
      try {
        const raw = await recipesApi.getRecipe(slug);
        const result: Record<string, unknown> = {};
        for (const field of conciseFields) {
          if (field in raw) {
            result[field] = raw[field];
          }
        }
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'get_recipes_batch',
    { slugs: z.array(z.string()) },
    async ({ slugs }) => {
      try {
        const result = await recipesApi.getRecipesBatch(slugs);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'get_recipes_detailed_batch',
    { slugs: z.array(z.string()).describe('Recipe slugs to fetch in parallel') },
    async ({ slugs }) => {
      try {
        const result = await recipesApi.getRecipesBatch(slugs);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'create_recipe',
    {
      name: z.string(),
      ingredients: z.array(z.string()).optional(),
      instructions: z.array(z.string()).optional(),
    },
    async ({ name, ingredients, instructions }) => {
      try {
        const slug = await recipesApi.createRecipe(name);
        let result: unknown = slug;

        if (ingredients || instructions) {
          const current = await recipesApi.getRecipe(slug);
          const updatedData = { ...current };
          if (ingredients) {
            // Mealie expects structured objects, not bare strings
            updatedData.recipeIngredient = ingredients.map((note) => ({ note }));
          }
          if (instructions) {
            updatedData.recipeInstructions = instructions.map((text) => ({ text }));
          }
          result = await recipesApi.updateRecipe(slug, updatedData);
        }

        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'patch_recipe',
    {
      slug: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      recipeYield: z.string().optional(),
      totalTime: z.string().optional(),
      categories: categoriesParamSchema.optional(),
      tags: tagsParamSchema.optional(),
      taxonomyMode: taxonomyModeSchema.optional(),
      createMissing: createMissingSchema.optional(),
    },
    async ({ slug, categories, tags, taxonomyMode, createMissing, ...rest }) => {
      try {
        const data: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) {
            data[key] = value;
          }
        }

        let taxonomyChanges: { categories?: unknown; tags?: unknown } | undefined;
        if (categories !== undefined || tags !== undefined) {
          const recipe = await recipesApi.getRecipe(slug);
          const outcome = await buildTaxonomyPatch(recipe, {
            categories,
            tags,
            mode: taxonomyMode,
            createMissing,
          });
          Object.assign(data, outcome.patchFields);
          taxonomyChanges = { categories: outcome.categories, tags: outcome.tags };
        }

        const result = await recipesApi.patchRecipe(slug, data);
        return successResponse(taxonomyChanges ? { ...result, taxonomyChanges } : result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'update_recipe_taxonomy',
    {
      slug: z.string().describe('Slug of the recipe to update.'),
      categories: categoriesParamSchema.optional(),
      tags: tagsParamSchema.optional(),
      mode: taxonomyModeSchema.optional(),
      createMissing: createMissingSchema.optional(),
    },
    async ({ slug, categories, tags, mode, createMissing }) => {
      try {
        const result = await updateRecipeTaxonomy(slug, { categories, tags, mode, createMissing });
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'update_recipe_taxonomy_batch',
    {
      updates: z
        .array(
          z.object({
            slug: z.string().describe('Slug of the recipe to update.'),
            categories: categoriesParamSchema.optional(),
            tags: tagsParamSchema.optional(),
            mode: taxonomyModeSchema.optional(),
            createMissing: createMissingSchema.optional(),
          }),
        )
        .describe(
          'One entry per recipe to update. Each recipe is processed independently with bounded concurrency — ' +
            'a failure on one recipe does not abort the others, and the response includes a success/error result ' +
            'for every entry.',
        ),
    },
    async ({ updates }) => {
      try {
        const result = await updateRecipeTaxonomyBatch(updates);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'duplicate_recipe',
    { slug: z.string(), name: z.string().optional() },
    async ({ slug, name }) => {
      try {
        const result = await recipesApi.duplicateRecipe(slug, name);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'mark_recipe_last_made',
    { slug: z.string() },
    async ({ slug }) => {
      try {
        const result = await recipesApi.updateRecipeLastMade(slug);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'set_recipe_image_from_url',
    { slug: z.string(), imageUrl: z.string() },
    async ({ slug, imageUrl }) => {
      try {
        const result = await recipesApi.setRecipeImageFromUrl(slug, imageUrl);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'delete_recipe',
    { slug: z.string() },
    async ({ slug }) => {
      try {
        const result = await recipesApi.deleteRecipe(slug);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}

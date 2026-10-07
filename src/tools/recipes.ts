import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as recipesApi from '../api/recipes.js';
import { buildTaxonomyPatch, updateRecipeTaxonomy, updateRecipeTaxonomyBatch } from '../lib/recipe-taxonomy.js';
import { updateRecipeTools, updateRecipeToolsBatch, RECIPE_TOOLS_BATCH_MAX_SIZE } from '../lib/recipe-tools.js';
import { resolveLastMadeTimestamp } from '../lib/last-made.js';
import { resolveTaxonomyFilter } from '../lib/taxonomy-resolution.js';
import { setRecipeImage, setRecipeImageFromFile } from '../lib/recipe-image.js';
import { setRecipeRating, RECIPE_RATING_MIN, RECIPE_RATING_MAX, RECIPE_RATING_STEP } from '../lib/recipe-rating.js';
import { findRecipesForIngredients } from '../lib/find-recipes-for-ingredients.js';
import {
  getRecipesForClassification,
  CLASSIFICATION_DEFAULT_LIMIT,
  CLASSIFICATION_MAX_LIMIT,
  CLASSIFICATION_DEFAULT_TAXONOMY_STATE,
} from '../lib/recipe-classification.js';
import {
  updateRecipeIngredients,
  updateRecipeIngredientsBatch,
  RECIPE_INGREDIENTS_BATCH_MAX_SIZE,
} from '../lib/recipe-ingredients.js';
import {
  updateRecipeInstructions,
  updateRecipeInstructionsBatch,
  RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE,
} from '../lib/recipe-instructions.js';
import {
  getRecipesForIngredientParsing,
  INGREDIENT_PARSING_DEFAULT_LIMIT,
  INGREDIENT_PARSING_MAX_LIMIT,
  INGREDIENT_PARSING_DEFAULT_STATE,
} from '../lib/recipe-ingredient-parsing.js';
import {
  getRecipesForDataEnrichment,
  ENRICHMENT_DEFAULT_LIMIT,
  ENRICHMENT_MAX_LIMIT,
} from '../lib/recipe-enrichment.js';

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

const taxonomyDeltaValueSchema = z.array(z.string().trim().min(1, 'Values must not be blank.'));

function taxonomyDeltaFields() {
  return {
    addCategories: taxonomyDeltaValueSchema
      .optional()
      .describe(
        'Delta form: categories to add (name, slug, or ID). Cannot be combined with categories. Unchanged ' +
          'categories are preserved.',
      ),
    removeCategories: taxonomyDeltaValueSchema
      .optional()
      .describe(
        'Delta form: categories to remove (name, slug, or ID). Must already exist — never created. Cannot be ' +
          'combined with categories, and cannot overlap addCategories.',
      ),
    addTags: taxonomyDeltaValueSchema
      .optional()
      .describe('Delta form: tags to add (name, slug, or ID). Cannot be combined with tags.'),
    removeTags: taxonomyDeltaValueSchema
      .optional()
      .describe(
        'Delta form: tags to remove (name, slug, or ID). Must already exist — never created. Cannot be combined ' +
          'with tags, and cannot overlap addTags.',
      ),
  };
}

const recipeIngredientInputSchema = z.object({
  quantity: z
    .number()
    .nullable()
    .optional()
    .describe('Numeric amount, e.g. 2. 0 is a valid explicit value; omit to use Mealie\'s default (0).'),
  unitId: z
    .string()
    .uuid()
    .optional()
    .describe('UUID of an existing unit. Must be given together with unitName — never alone.'),
  unitName: z.string().optional().describe('Human-readable name of the unit identified by unitId. Required whenever unitId is given.'),
  foodId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'UUID of an existing food (see get_food_matches for resolving multiple already-interpreted concepts at ' +
        'once, or get_foods/get_food for a single manual lookup). Must be given together with foodName — never ' +
        'alone. This tool never looks up or creates foods; resolve the food first.',
    ),
  foodName: z.string().optional().describe('Human-readable name of the food identified by foodId. Required whenever foodId is given.'),
  note: z.string().nullable().optional().describe('Free-text note for this ingredient line.'),
  display: z
    .string()
    .optional()
    .describe(
      'Fully composed display string, e.g. "2 tablespoons olive oil". Mealie does not persist this field — it ' +
        'always recomputes its own display string from quantity/unit/food/note when the ingredient is read, so ' +
        'do not rely on this value round-tripping literally.',
    ),
  originalText: z.string().nullable().optional().describe('The original, unparsed ingredient text, if any.'),
  title: z
    .string()
    .nullable()
    .optional()
    .describe('Section heading for this ingredient line (e.g. "For the sauce"); omit or use null for a normal ingredient.'),
  referenceId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Stable UUID for this ingredient line. Recipe instructions can reference ingredients by this ID — pass ' +
        'back the value from a prior get_recipe_detailed to preserve those links; omit to let Mealie assign a new one.',
    ),
  referencedRecipeId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'UUID (the recipe\'s "id", stable across renames — not its slug) of an existing recipe to use as a ' +
        'sub-recipe on this line, e.g. a sauce or spice mix. Read it back as referencedRecipe in ' +
        'get_recipe_detailed. Cannot be combined with foodId/unitId on the same row. An id that matches no ' +
        'recipe fails the call before anything is written.',
    ),
})
  .refine((row) => !(row.referencedRecipeId && (row.foodId || row.unitId)), {
    message: 'referencedRecipeId cannot be combined with foodId/unitId on the same ingredient row.',
  });

function recipeIngredientDeltaFields() {
  return {
    addIngredients: z
      .array(
        recipeIngredientInputSchema.extend({
          insertAfterReferenceId: z
            .string()
            .uuid()
            .optional()
            .describe('Insert this row directly after the existing row with this referenceId. Not with insertBeforeReferenceId.'),
          insertBeforeReferenceId: z
            .string()
            .uuid()
            .optional()
            .describe('Insert this row directly before the existing row with this referenceId. Not with insertAfterReferenceId.'),
        }),
      )
      .optional()
      .describe(
        'Delta form: ingredient rows to add. Without an insert anchor a row is appended to the end, in the order ' +
          'given; anchors must name an existing row that is not being removed, and rows sharing an anchor keep ' +
          'their given order. A row with a "title" starts an ingredient section. An explicit referenceId must not ' +
          'already exist on the recipe. Cannot be combined with ingredients.',
      ),
    updateIngredients: z
      .array(
        recipeIngredientInputSchema.safeExtend({
          referenceId: z.string().uuid().describe('referenceId of the existing row to update (from get_recipe_detailed).'),
        }),
      )
      .optional()
      .describe(
        'Delta form: partial updates to existing rows, matched by referenceId. Only the fields supplied change; ' +
          'everything else on the row is kept. foodId/foodName and unitId/unitName must each be given as a pair ' +
          '(food/unit can be replaced but not cleared this way — use the complete-replacement form for that). ' +
          'Set "title" to add/change/clear (null) a section heading. Cannot be combined with ingredients.',
      ),
    removeIngredientReferenceIds: z
      .array(z.string().uuid())
      .optional()
      .describe(
        'Delta form: referenceIds of existing rows to remove. Cannot be combined with ingredients, and cannot ' +
          'overlap updateIngredients. Duplicate or unknown referenceIds reject the whole call before any write.',
      ),
  };
}

const instructionRefIdsSchema = z.array(z.string().uuid());

const recipeInstructionInputSchema = z.object({
  text: z.string().min(1).describe('Instruction text.'),
  title: z.string().nullable().optional().describe('Instruction section title; omit or null for none.'),
  summary: z.string().nullable().optional().describe('Instruction summary; omit or null for none.'),
  ingredientReferenceIds: instructionRefIdsSchema
    .optional()
    .describe('referenceIds of the recipe ingredients this instruction uses (from get_recipe_detailed recipeIngredient).'),
  noteReferenceIds: instructionRefIdsSchema
    .optional()
    .describe(
      'Low-level preservation field: noteReferences (referenceId) read from the recipe, passed back unchanged so a ' +
        'complete replacement does not drop them. Omit for none.',
    ),
});

function recipeInstructionDeltaFields() {
  return {
    addInstructions: z
      .array(
        z.object({
          text: z.string().min(1).describe('Instruction text (required).'),
          title: z.string().nullable().optional(),
          summary: z.string().nullable().optional(),
          ingredientReferenceIds: instructionRefIdsSchema.optional(),
          insertBeforeIndex: z.number().int().min(0).optional().describe('Insert before the instruction at this index of the guarded snapshot. Not with insertAfterIndex.'),
          insertAfterIndex: z.number().int().min(0).optional().describe('Insert after the instruction at this index of the guarded snapshot. Not with insertBeforeIndex.'),
        }),
      )
      .optional()
      .describe(
        'Delta form: instructions to add. No anchor appends to the end in the given order; anchors refer to the ' +
          'guarded original snapshot, must exist and must not be removed; additions sharing an anchor keep input ' +
          'order; opposite anchors targeting the same gap are rejected as ambiguous. Cannot be combined with instructions.',
      ),
    updateInstructions: z
      .array(
        z.object({
          index: z.number().int().min(0).describe('Zero-based index in the guarded snapshot.'),
          text: z.string().min(1).optional(),
          title: z.string().nullable().optional(),
          summary: z.string().nullable().optional(),
          ingredientReferenceIds: instructionRefIdsSchema
            .optional()
            .describe('Replaces this instruction\'s complete ingredient links; [] clears them; omit to keep them.'),
        }),
      )
      .optional()
      .describe(
        'Delta form: partial updates by snapshot index. Only supplied fields change; omitted fields and ' +
          'noteReferences are preserved. An index may appear once and cannot also be removed.',
      ),
    removeInstructionIndexes: z
      .array(z.number().int().min(0))
      .optional()
      .describe('Delta form: zero-based snapshot indexes to remove (no duplicates, no overlap with updates).'),
  };
}

const expectedUpdatedAtSchema = z
  .string()
  .min(1)
  .describe(
    'The exact opaque updatedAt from the get_recipe_detailed read whose instruction indexes you are using. Pass it ' +
      'back unchanged. A mismatch means the recipe changed since that read: the call fails before any write (a stale-snapshot guard, not an atomic conditional write).',
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

const toolValueSchema = z.array(z.string().trim().min(1, 'Tool values must not be blank.'));

function updateRecipeToolsMutationFields() {
  return {
    tools: toolValueSchema
      .optional()
      .describe(
        'Legacy form: tools to assign, each a name, slug, or ID of a Mealie Tool organizer. An empty array is a ' +
          'no-op in merge mode, but with mode "replace" it DESTRUCTIVELY clears all tools from the recipe. Cannot ' +
          'be combined with add/remove.',
      ),
    mode: z
      .enum(['merge', 'replace'])
      .optional()
      .describe(
        'Only for the tools form. merge (default) adds to existing tools; replace sets exactly the given list and ' +
          'removes all others.',
      ),
    add: toolValueSchema
      .optional()
      .describe('Delta form: tools to add (name, slug, or ID). Cannot be combined with tools/mode.'),
    remove: toolValueSchema
      .optional()
      .describe(
        'Delta form: tools to remove (name, slug, or ID). Must already exist as Tool organizers — never created. ' +
          'Cannot be combined with tools/mode, and cannot overlap add.',
      ),
    createMissing: z
      .boolean()
      .optional()
      .describe(
        'When true, tools from tools/add that do not exist are created using the requested value as the name. ' +
          'Default false: unknown values fail the call and are all listed.',
      ),
  };
}

function updateRecipeToolsFields() {
  return { slug: z.string().describe('Slug of the recipe to update.'), ...updateRecipeToolsMutationFields() };
}

export function registerRecipeTools(server: McpServer) {
  // @endpoints GET /api/recipes
  server.tool(
    'get_recipes',
    'Searches and lists recipes with pagination. Categories and tags are resolved by name/slug/ID against ' +
      'Mealie\'s organizer endpoints before the request, since Mealie\'s query params only match by exact slug/ID.',
    {
      search: z.string().optional(),
      page: z.number().optional(),
      perPage: z.number().optional(),
      categories: z
        .array(z.string())
        .optional()
        .describe('Each given as a name, slug, or ID (matched case-insensitively by name/slug).'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Each given as a name, slug, or ID (matched case-insensitively by name/slug).'),
      requireAllTags: z.boolean().optional(),
      requireAllCategories: z.boolean().optional(),
    },
    async (params) => {
      try {
        const categories = await resolveTaxonomyFilter('category', params.categories);
        const tags = await resolveTaxonomyFilter('tag', params.tags);
        const result = await recipesApi.getRecipes({ ...params, categories, tags });
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/foods, GET /api/recipes/suggestions, GET /api/recipes
  server.tool(
    'find_recipes_for_ingredients',
    'Finds recipes that contain one or more requested ingredients. Ingredient names are resolved against ' +
      "Mealie's food taxonomy internally — never pass Mealie food UUIDs, just human-readable names like " +
      '"branzino" or "chicken thighs". Use this for exact or approximate ingredient-based recipe discovery, ' +
      'e.g. deciding what to cook with an ingredient on hand. If an ingredient has no useful matches (see ' +
      'resolvedIngredients/unresolvedIngredients/matchSource in the response), the MCP will not guess a ' +
      'substitute on your behalf — retry this same tool with broader or substitutable ingredient terms you ' +
      'choose (e.g. "branzino" with no matches -> retry with "sea bass", "whole fish", or "snapper"), then use ' +
      'get_recipe_detailed or get_recipes_batch to inspect the most promising candidates.',
    {
      ingredients: z
        .array(z.string())
        .min(1)
        .describe(
          'One or more human-readable ingredient names (e.g. "branzino", "chicken thighs"). Never Mealie food ' +
            'UUIDs — this tool resolves names against Mealie\'s food taxonomy internally.',
        ),
      categories: z
        .array(z.string())
        .optional()
        .describe('Optional category filter, same name/slug/ID matching convention as get_recipes.'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Optional tag filter, same name/slug/ID matching convention as get_recipes.'),
      requireAllIngredients: z
        .boolean()
        .optional()
        .describe(
          'When true, only return recipes containing every resolved ingredient (AND). Default false returns ' +
            'recipes containing any one of them, ranked by how many they contain and how few other ingredients ' +
            'they are missing (Mealie\'s Recipe Finder behavior).',
        ),
      requireAllCategories: z.boolean().optional().describe('Require every given category, not just one.'),
      requireAllTags: z.boolean().optional().describe('Require every given tag, not just one.'),
      limit: z.number().optional().describe('Max recipes to return, default 10, capped at 50.'),
    },
    async (params) => {
      try {
        const result = await findRecipesForIngredients(params);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/recipes/{slug}
  server.tool(
    'get_recipe_detailed',
    'Retrieves a recipe by slug with full details including nutrition, settings, and assets.',
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

  // @endpoints GET /api/recipes/{slug}
  server.tool(
    'get_recipe_concise',
    'Retrieves a recipe by slug, filtered to summary fields (name, slug, servings, yield, total time, rating, ingredients, last made).',
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

  // @endpoints GET /api/recipes/{slug}
  server.tool(
    'get_recipes_batch',
    'Fetches multiple recipes by slug with bounded concurrency (4 in-flight requests at a time).',
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

  // @endpoints GET /api/recipes/{slug}
  server.tool(
    'get_recipes_detailed_batch',
    'Fetches multiple recipes by slug with full details (including nutrition) and bounded concurrency.',
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

  // @endpoints GET /api/recipes, GET /api/recipes/{slug}
  server.tool(
    'get_recipes_for_classification',
    'Compact, paginated, READ-ONLY feed of recipes for assigning Categories and Tags. Returns only the ' +
      'fields useful for classification (name, description, times, servings, source URL, ingredients, ' +
      'instructions) plus each recipe\'s EXISTING categories and tags — include and preserve those when ' +
      'classifying; do not drop or overwrite them. By default only recipes missing at least one taxonomy ' +
      'collection are returned (taxonomyState "missing_either"); use "missing_both", "missing_categories", ' +
      '"missing_tags", or "any" to change that. Pass the response\'s nextCursor back unchanged as the next ' +
      'call\'s cursor to continue; stop once hasMore is false. Pagination is stable against concurrent ' +
      'taxonomy edits — a recipe that gains categories/tags between calls will not cause other recipes to be ' +
      'skipped. A failure reading one recipe is reported in failures and does not fail the rest of the page. ' +
      'This tool never creates or modifies anything — it does not assign taxonomy, create categories/tags, or ' +
      'change any recipe. To apply classifications, call update_recipe_taxonomy_batch separately (preferably ' +
      'in batches of about five recipes), normally with mode "merge" and createMissing: false unless the user ' +
      'explicitly asks to replace collections or auto-create new categories/tags.',
    {
      cursor: z
        .string()
        .optional()
        .describe(
          'Opaque continuation token from a previous call\'s nextCursor. Pass it back unchanged to resume ' +
            'exactly where that call left off; omit it to start from the beginning of the collection. Do not ' +
            'construct or edit this value — malformed or foreign cursors are rejected with a clear error.',
        ),
      limit: z
        .number()
        .int(`limit must be between 1 and ${CLASSIFICATION_MAX_LIMIT}.`)
        .min(1, `limit must be between 1 and ${CLASSIFICATION_MAX_LIMIT}.`)
        .max(CLASSIFICATION_MAX_LIMIT, `limit must be between 1 and ${CLASSIFICATION_MAX_LIMIT}.`)
        .optional()
        .describe(`Maximum recipes to return (1-${CLASSIFICATION_MAX_LIMIT}, default ${CLASSIFICATION_DEFAULT_LIMIT}).`),
      taxonomyState: z
        .enum(['missing_either', 'missing_both', 'missing_categories', 'missing_tags', 'any'])
        .optional()
        .describe(
          `Which recipes to include, based on their existing Categories/Tags (default "${CLASSIFICATION_DEFAULT_TAXONOMY_STATE}"): ` +
            '"missing_either" — category list empty, tag list empty, or both; "missing_both" — both empty; ' +
            '"missing_categories" — category list empty regardless of tags; "missing_tags" — tag list empty ' +
            'regardless of categories; "any" — no taxonomy filtering.',
        ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ cursor, limit, taxonomyState }) => {
      try {
        const result = await getRecipesForClassification({ cursor, limit, taxonomyState });
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/recipes, GET /api/recipes/{slug}
  server.tool(
    'get_recipes_for_ingredient_parsing',
    'Compact, paginated, READ-ONLY work queue of recipes whose ingredients may need structured parsing. This ' +
      'tool identifies candidate recipes using only their EXISTING stored schema state — it never parses or ' +
      'interprets ingredient language itself: it does not call Mealie\'s NLP ingredient parser, does not guess a ' +
      'food/unit association, and never modifies any recipe, food, unit, alias, or ingredient. It returns each ' +
      'ingredient\'s current stored state (quantity, unit id/name, food id/name, note, display, originalText, ' +
      'title, referenceId) plus recipe instructions (title, text, ingredientReferences) as context — turning ' +
      'that into structured data (e.g. "2 tablespoons chopped fresh parsley leaves" -> quantity 2, unit ' +
      'tablespoon, food parsley, note "chopped fresh") is entirely the calling model\'s job. Instructions are ' +
      'included because they can disambiguate an otherwise-ambiguous ingredient line or reveal how a compound ' +
      'quantity is actually used (e.g. whether "3 cups + 2 tbsp flour" is one combined amount or two separate ' +
      'uses) — this tool does not decide that, it only supplies the text. Each ingredient includes a ' +
      'deterministic, schema-only "parsingState": "section" (a pure Mealie ingredient-section heading: a ' +
      'non-empty title with no food, unit, positive quantity, note, display, or originalText other than the title itself — never counted as ' +
      'needing parsing; a title on a row that also carries an ingredient payload does NOT make it a section and ' +
      'the row is classified by its own state), "unparsed" (no food is associated — the primary, ' +
      'high-confidence signal), "partial" (a food is associated but no unit, while quantity is a positive number ' +
      '— NOTE: this also matches legitimately unit-less countable foods like "4 eggs" or "2 lemons", since ' +
      'Mealie\'s schema has no field distinguishing that from an incompletely-structured row; treat "partial" as ' +
      'a coarse audit signal, not a confirmed defect), or "structured" (fully resolved, or has no meaningful ' +
      'quantity to need a unit). Each recipe also includes an ingredientParsingState summary ' +
      '(unparsedCount/partialCount/structuredCount/sectionCount/totalCount); sectionCount independently counts ' +
      'every row with a non-empty title, so a titled real ingredient counts in both its parsing count and ' +
      'sectionCount and the counts need not sum to totalCount. Use "state" to choose the queue: ' +
      '"unparsed_only" (default) — recipes with at least one unparsed ingredient; "partially_parsed" — recipes ' +
      'with at least one partial ingredient; "any" — every scanned recipe, for auditing. Every scanned recipe ' +
      'needs a full detail fetch (Mealie\'s recipe list endpoint does not expose ingredients), fetched with ' +
      'bounded concurrency in small batches — a failure reading one recipe is reported in failures and does not ' +
      'fail the rest of the page. Because of that per-recipe fetch cost, a sparse queue may need to scan far ' +
      'more recipes than it returns to fill a page; returnedCount can come in below the requested limit even ' +
      'when hasMore is true, if an internal time budget is reached first — this is expected, not an error, and ' +
      'the response is still safe to use as-is. Pass the response\'s nextCursor back unchanged as the next ' +
      'call\'s cursor to continue; stop once hasMore is false. Pagination is stable against concurrent recipe ' +
      'edits, the same way get_recipes_for_classification is. When you later write changes: use get_food_matches ' +
      'and get_unit_matches to find existing canonical food/unit candidates for the concepts you interpreted ' +
      '(this tool never looks them up or creates them itself), then call update_recipe_ingredients with the ' +
      'complete, corrected ingredient collection for that recipe. Existing referenceIds are stable identifiers ' +
      'for ingredient rows and may be referenced by recipe instructions — preserve them when an existing ' +
      'ingredient row continues to represent the same ingredient. Recipe instruction ids returned here are NOT ' +
      'stable — Mealie recreates recipeInstructions (and assigns fresh ids) on every recipe update, including ' +
      'update_recipe_ingredients — do not depend on an instruction id read here still being valid after a write.',
    {
      cursor: z
        .string()
        .optional()
        .describe(
          'Opaque continuation token from a previous call\'s nextCursor. Pass it back unchanged to resume ' +
            'exactly where that call left off; omit it to start from the beginning of the collection. Do not ' +
            'construct or edit this value — malformed or foreign cursors are rejected with a clear error.',
        ),
      limit: z
        .number()
        .int(`limit must be between 1 and ${INGREDIENT_PARSING_MAX_LIMIT}.`)
        .min(1, `limit must be between 1 and ${INGREDIENT_PARSING_MAX_LIMIT}.`)
        .max(INGREDIENT_PARSING_MAX_LIMIT, `limit must be between 1 and ${INGREDIENT_PARSING_MAX_LIMIT}.`)
        .optional()
        .describe(`Maximum recipes to return (1-${INGREDIENT_PARSING_MAX_LIMIT}, default ${INGREDIENT_PARSING_DEFAULT_LIMIT}).`),
      state: z
        .enum(['unparsed_only', 'partially_parsed', 'any'])
        .optional()
        .describe(
          `Which recipes to include (default "${INGREDIENT_PARSING_DEFAULT_STATE}"): "unparsed_only" — at least ` +
            'one non-section ingredient has no associated food (pure section headings are excluded); "partially_parsed" — at least one ingredient has a food but ' +
            'no unit despite a positive quantity (coarse signal, see tool description for its known false-positive ' +
            'tradeoff); "any" — no filtering, every scanned recipe is returned (useful for auditing).',
        ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ cursor, limit, state }) => {
      try {
        const result = await getRecipesForIngredientParsing({ cursor, limit, state });
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/recipes, GET /api/recipes/{slug}
  server.tool(
    'get_recipes_for_data_enrichment',
    'Compact, paginated, READ-ONLY holistic work queue of recipes that match deterministic enrichment-review ' +
      'conditions across several dimensions at once: ingredient parsing, ingredient section headings, ' +
      'instruction-to-ingredient links, Tools, Categories, Tags, and image. It reports stored-schema facts and ' +
      'filters on them; it never decides what should change. A match is a review signal, NOT a verdict — e.g. ' +
      '"4 eggs" legitimately has no unit, a recipe may not need sections or equipment, and existing Categories/' +
      'Tags may already be correct. Use matchedDimensions, the recipe context, and the audit counts to decide ' +
      'what actually warrants a change, preserve correct existing data, and apply changes with the focused ' +
      'write tools (update_recipe_ingredients, update_recipe_instructions, update_recipe_tools, ' +
      'update_recipe_taxonomy and their batch forms, and the recipe image tools). When to use it: for a clearly ' +
      'scoped single task prefer the focused queue (get_recipes_for_ingredient_parsing, ' +
      'get_recipes_for_classification); use this queue for several enrichment dimensions in one pass or for ' +
      'broad "clean up / enrich my recipes" requests with its default filters, paging until hasMore is false ' +
      'unless the user narrows scope. Never broaden a specific request into comprehensive cleanup. Filters: ' +
      'ingredientParsing ("unparsed" = some non-heading ingredient has no food — pure section headings excluded; "partial" = some ingredient has a food and ' +
      'positive quantity but no unit — coarse signal; "unparsed_or_partial"), ingredientSections (true = has ' +
      'section headings; false = has ingredients but no section headings — recipes with zero ingredients never ' +
      'match false), instructionIngredientLinks ("missing" = has instructions but none reference an ingredient; ' +
      '"dangling" = an instruction reference matches no current ingredient referenceId; "missing_or_dangling"), ' +
      'tools / categories / tags / image (true = present, false = absent). If filters is omitted, the defaults are ' +
      'ingredientParsing "unparsed_or_partial", ingredientSections false, instructionIngredientLinks ' +
      '"missing_or_dangling", tools false, categories false, tags false, image false. If filters is provided it ' +
      'is the COMPLETE active set — it is not merged with the defaults — and an empty filters object is rejected. match "any" (default) returns ' +
      'recipes matching at least one active filter; "all" requires every active filter. Recipes are scanned ' +
      'oldest-created first (createdAt, then id). Each item includes createdAt and updatedAt (use updatedAt as ' +
      'expectedUpdatedAt for guarded writers), ingredients with parsingState, instructions with ' +
      'ingredientReferenceIds, tools, categories, tags, the audit facts, and matchedDimensions (the active ' +
      'dimensions this recipe matched). Instruction ids are not exposed and are not stable identity — Mealie ' +
      'regenerates them on every recipe update. Every scanned recipe needs a full detail fetch (bounded ' +
      'concurrency); a failure reading one recipe is reported in failures without failing the page. A sparse ' +
      'queue may return fewer than limit items while hasMore is true if the internal time budget is reached — ' +
      'this is expected. Pass nextCursor back unchanged to continue; stop once hasMore is false.',
    {
      cursor: z
        .string()
        .optional()
        .describe(
          'Opaque continuation token from a previous call\'s nextCursor. Pass it back unchanged; omit it to ' +
            'start from the oldest recipe. Malformed or foreign cursors are rejected with a clear error.',
        ),
      limit: z
        .number()
        .int(`limit must be between 1 and ${ENRICHMENT_MAX_LIMIT}.`)
        .min(1, `limit must be between 1 and ${ENRICHMENT_MAX_LIMIT}.`)
        .max(ENRICHMENT_MAX_LIMIT, `limit must be between 1 and ${ENRICHMENT_MAX_LIMIT}.`)
        .optional()
        .describe(`Maximum recipes to return (1-${ENRICHMENT_MAX_LIMIT}, default ${ENRICHMENT_DEFAULT_LIMIT}).`),
      match: z
        .enum(['any', 'all'])
        .optional()
        .describe('How active filters combine: "any" (default) = at least one matches; "all" = every active filter matches.'),
      filters: z
        .object({
          ingredientParsing: z.enum(['unparsed', 'partial', 'unparsed_or_partial']).optional(),
          ingredientSections: z.boolean().optional(),
          instructionIngredientLinks: z.enum(['missing', 'dangling', 'missing_or_dangling']).optional(),
          tools: z.boolean().optional(),
          categories: z.boolean().optional(),
          tags: z.boolean().optional(),
          image: z.boolean().optional(),
        })
        .strict()
        .optional()
        .describe(
          'Complete active filter set (replaces the defaults; must contain at least one key). Booleans: true = ' +
            'present, false = absent. Omit to use the default enrichment filters.',
        ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ cursor, limit, match, filters }) => {
      try {
        const result = await getRecipesForDataEnrichment({ cursor, limit, match, filters });
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints POST /api/recipes, PUT /api/recipes/{slug}
  server.tool(
    'create_recipe',
    'Creates a new recipe. Optionally sets ingredients and instructions on creation.',
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

  // @endpoints GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  server.tool(
    'patch_recipe',
    'Partially updates a recipe. Optional categories/tags/taxonomyMode/createMissing assign taxonomy; unchanged Category/Tag collections are never written and, if taxonomy is the only thing requested and nothing changes, no PATCH is issued and the current recipe is returned with taxonomyChanges. Optional instructions is the complete new list of steps (not a patch): it replaces all steps, [] clears them, omitting it leaves them unchanged.',
    {
      slug: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      recipeYield: z.string().optional(),
      totalTime: z.string().optional(),
      recipeServings: z.number().optional(),
      recipeYieldQuantity: z.number().optional(),
      orgURL: z.string().optional(),
      categories: categoriesParamSchema.optional(),
      tags: tagsParamSchema.optional(),
      taxonomyMode: taxonomyModeSchema.optional(),
      createMissing: createMissingSchema.optional(),
      instructions: z.array(z.string()).optional().describe('Complete new list of steps, in order. Replaces all steps; [] clears them.'),
    },
    async ({ slug, categories, tags, taxonomyMode, createMissing, instructions, ...rest }) => {
      try {
        const data: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) {
            data[key] = value;
          }
        }
        if (instructions !== undefined) {
          data.recipeInstructions = instructions.map((text) => ({ text }));
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
          // Taxonomy-only no-op: skip the write (Mealie regenerates instruction ids on every PATCH).
          if (Object.keys(data).length === 0) {
            return successResponse({ ...recipe, taxonomyChanges });
          }
        }

        const result = await recipesApi.patchRecipe(slug, data);
        return successResponse(taxonomyChanges ? { ...result, taxonomyChanges } : result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  server.tool(
    'update_recipe_ingredients',
    'Replaces the complete structured ingredient collection (recipeIngredient) of an existing recipe, leaving ' +
      'every other recipe field untouched (name, description, categories, tags, settings, nutrition, etc.). ' +
      'Known Mealie limitation, not caused by this tool: every recipe instruction\'s ID is regenerated on any ' +
      'recipe update (PATCH or PUT), including this one — instruction text/title/summary/ingredient-references ' +
      'are preserved correctly, only the IDs change. Low-level write primitive: it does not parse ingredient ' +
      'text and does not look up or create foods/units — foodId/unitId must already reference existing Mealie ' +
      'entities, resolved first with get_food_matches/get_unit_matches (batch, alias-aware lookup for several ' +
      'already-interpreted concepts at once — the normal path after parsing ingredient text) or get_foods/' +
      'get_food/get_units/get_unit for a single manual lookup. The ingredients array ' +
      'is the recipe\'s complete new ingredient list, not a patch: any ingredient not included is removed, and ' +
      'an empty array clears all ingredients. Call get_recipe_detailed first to see the recipe\'s current ' +
      'ingredients, referenceIds, and other fields before replacing them. Note: each ingredient\'s "display" ' +
      'field is never actually persisted by Mealie — it is always recomputed from quantity/unit/food/note, ' +
      'regardless of what is supplied here. Integrity check: after writing, the recipe Mealie returns is ' +
      'verified — for every ingredient that supplied a foodId/unitId, the persisted food/unit must still be ' +
      'non-null, match the given id, and match the given name (case-insensitive against name/pluralName, plus ' +
      'abbreviation/pluralAbbreviation for units). If verification fails (e.g. a nonexistent or mismatched ' +
      'foodId/unitId that Mealie silently dropped or resolved to the wrong entity), the recipe is restored to ' +
      'its pre-write state on a best-effort basis and this call reports failure — never a silent partial ' +
      'write. Referenced recipes: a row may carry referencedRecipeId (an existing recipe\'s id) instead of a ' +
      'food/unit to use that recipe as a sub-recipe; every referenced id is read first (an unknown id fails ' +
      'the call and nothing is written), and after the write the persisted referencedRecipe must be non-null ' +
      'with the same id or the recipe is restored like any other verification failure. Verification adds no ' +
      'extra request on success beyond one GET per distinct referenced recipe; a failed write adds one ' +
      'rollback request. Alternatively, use the delta form (addIngredients/updateIngredients/removeIngredientReferenceIds, ' +
      'instead of ingredients) to edit rows incrementally by stable referenceId: retained rows keep their ' +
      'order, updates edit in place, additions are appended or anchored with insertAfterReferenceId/' +
      'insertBeforeReferenceId, and ingredient sections are just rows with a "title". The delta is applied to ' +
      'the recipe\'s current ingredients, the complete final collection is built, and the same verified write ' +
      'and rollback is used. Duplicate, unknown, or conflicting operations are rejected before any write. ' +
      'Note Mealie generates a fresh referenceId on every read for rows that never had one stored, so such a ' +
      'row may not be addressable by an id from an earlier read — use the complete-replacement form for it.',
    {
      slug: z.string().describe('Slug of the recipe to update.'),
      ingredients: z
        .array(recipeIngredientInputSchema)
        .optional()
        .describe(
          'Replacement form: complete desired ingredient collection, in order — replaces the recipe\'s entire ' +
            'recipeIngredient list. Pass every ingredient that should remain, not just the ones changing. An ' +
            'empty array clears all ingredients. Cannot be combined with the delta fields.',
        ),
      ...recipeIngredientDeltaFields(),
    },
    async ({ slug, ...input }) => {
      try {
        const result = await updateRecipeIngredients(slug, input);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  server.tool(
    'update_recipe_ingredients_batch',
    'Runs update_recipe_ingredients for multiple recipes with bounded concurrency (5 at a time). Use this ' +
      'once several recipes already have COMPLETE, resolved ingredient collections ready to persist — e.g. ' +
      'after batch-resolving food/unit concepts with get_food_matches/get_unit_matches across many recipes — ' +
      'to avoid one individual write call per recipe. Same low-level write semantics as the singular tool, ' +
      'applied independently per entry: each item\'s "ingredients" is that recipe\'s complete new ' +
      'recipeIngredient list (not a patch — any ingredient omitted is removed), foodId/unitId must already ' +
      'reference existing Mealie entities (this tool never looks up, matches, or creates foods/units), and ' +
      'referenceIds are preserved exactly as supplied. Same post-write integrity verification and best-effort ' +
      'rollback as the singular tool applies independently per recipe: a verification failure on one recipe ' +
      'restores only that recipe and is reported in its own result entry (error.rollbackSucceeded, plus ' +
      'error.rollbackError if the restore itself failed) — it never affects siblings. There is no cross-recipe ' +
      'transaction: recipes are processed independently, a failure on one (a 404/422/502 from Mealie, a local ' +
      'validation error like a mismatched foodId/foodName, or a verification failure) does not stop or roll ' +
      'back the others, and the response reports a success/failure result per recipe in the same order ' +
      'submitted. The whole call is rejected before any write starts only for a true request-shape problem — ' +
      `an empty batch, more than ${RECIPE_INGREDIENTS_BATCH_MAX_SIZE} recipes, a missing slug, or the same ` +
      'slug repeated in one call. Rows may carry referencedRecipeId (sub-recipe by recipe id, instead of a ' +
      'food/unit) exactly as in the singular tool: each distinct referenced id costs one extra GET per recipe ' +
      '(counted in apiRequestCount) and an unknown id fails only that recipe, with nothing written for it. ' +
      'The same recipeInstructions-id-regeneration caveat as ' +
      'update_recipe_ingredients applies to every recipe touched here (instruction content is preserved, only ' +
      'ids churn). Each entry uses either the complete-replacement form (ingredients) or the referenceId ' +
      'delta form (addIngredients/updateIngredients/removeIngredientReferenceIds) with the singular tool\'s ' +
      'semantics; an invalid or conflicting entry fails only its own result, before that recipe is written.',
    {
      updates: z
        .array(
          z.object({
            slug: z.string().describe('Slug of the recipe to update.'),
            ingredients: z
              .array(recipeIngredientInputSchema)
              .optional()
              .describe(
                'Replacement form: complete desired ingredient collection for this recipe, in order — replaces ' +
                  'its entire recipeIngredient list. An empty array clears all ingredients for this recipe. ' +
                  'Cannot be combined with the delta fields.',
              ),
            ...recipeIngredientDeltaFields(),
          }),
        )
        .min(1, `At least one recipe update is required.`)
        .max(
          RECIPE_INGREDIENTS_BATCH_MAX_SIZE,
          `At most ${RECIPE_INGREDIENTS_BATCH_MAX_SIZE} recipes are allowed per batch call.`,
        )
        .describe(
          'One entry per recipe to update. Each entry uses either the replacement form (a complete ingredient ' +
            'collection in `ingredients`) or the delta fields, never both. Each recipe is ' +
            'processed independently with bounded concurrency (5 at a time) — a failure on one recipe does not ' +
            `abort the others. Max ${RECIPE_INGREDIENTS_BATCH_MAX_SIZE} recipes per call; each slug must be unique ` +
            'within the call.',
        ),
    },
    async ({ updates }) => {
      try {
        const result = await updateRecipeIngredientsBatch(updates);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  server.tool(
    'update_recipe_instructions',
    'Edits a recipe\'s instructions (text, title, summary, and links to ingredients via ingredientReferenceIds), ' +
      'PATCHing only recipeInstructions. Mealie instruction IDs are ephemeral — regenerated on every recipe write — ' +
      'so they are never accepted or valid as identity and must not be saved. Instead: call get_recipe_detailed ' +
      'first, pass that snapshot\'s exact updatedAt as expectedUpdatedAt, and address instructions by zero-based ' +
      'index in that snapshot. expectedUpdatedAt guards against editing from a stale snapshot: if the recipe has already ' +
      'changed when the tool reads it for mutation, the call fails before writing and the caller must re-read and ' +
      'retry. Mealie does not provide conditional recipe writes, so a concurrent edit occurring in the narrow ' +
      'interval between that validation read and the PATCH cannot be detected before the write. Two mutually exclusive forms: delta ' +
      '(addInstructions/updateInstructions/removeInstructionIndexes — focused edits, all indexes and anchors ' +
      'refer to the original snapshot) or instructions (complete ordered replacement — use for substantial ' +
      'rebuilds/reordering; [] clears all). ingredientReferenceIds must be referenceIds of the recipe\'s current ' +
      'ingredients (unknown, malformed or duplicate ids are rejected before any write; Mealie regenerates the id on every ' +
      'read for a legacy/unpinned ingredient that never had one stored — this affects only such ingredients, not ' +
      'every ingredient. To pin them, use update_recipe_ingredients complete replacement with the full ingredient ' +
      'collection, explicitly supplying a referenceId for every continuing row; then re-read the recipe before ' +
      'retrying, because the ingredient write changes the recipe snapshot and its updatedAt); the MCP never infers links ' +
      '— deciding wording, sectioning and which ingredients belong to a step is your job. Delta updates preserve ' +
      'omitted fields, untouched instructions and existing noteReferences exactly (existing dangling ingredient ' +
      'references are not cleaned up). A change that leaves instructions identical skips the write and returns the ' +
      'current recipe. After a write the returned recipe is verified by content (text/title/summary/ingredient ' +
      'and note references, ignoring ids); on mismatch the original instructions are restored best-effort and the ' +
      'call fails, reporting whether rollback succeeded (ids are regenerated by each write and rollback).',
    {
      slug: z.string().describe('Slug of the recipe to update.'),
      expectedUpdatedAt: expectedUpdatedAtSchema,
      instructions: z
        .array(recipeInstructionInputSchema)
        .optional()
        .describe('Replacement form: complete desired ordered instruction list. Cannot be combined with the delta fields.'),
      ...recipeInstructionDeltaFields(),
    },
    async ({ slug, ...input }) => {
      try {
        const result = await updateRecipeInstructions(slug, input);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  server.tool(
    'update_recipe_instructions_batch',
    'Runs update_recipe_instructions for multiple recipes with bounded concurrency (5 at a time). Each entry has ' +
      'its own slug, its own expectedUpdatedAt (exact updatedAt from that recipe\'s get_recipe_detailed) and exactly ' +
      'one of the replacement form (instructions) or delta form (addInstructions/updateInstructions/' +
      'removeInstructionIndexes), with the singular tool\'s semantics. Mealie instruction IDs are ephemeral and ' +
      'never valid identity. Each recipe is validated, written, verified and rolled back independently: a stale ' +
      'expectedUpdatedAt, invalid entry, API error or verification failure fails only that entry. Results come ' +
      'back in input order with requestedCount/succeededCount/failedCount; there is no cross-recipe transaction. ' +
      `The whole call is rejected before any write for an empty batch, more than ${RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE} ` +
      'entries, a missing slug, or a repeated slug.',
    {
      updates: z
        .array(
          z.object({
            slug: z.string().describe('Slug of the recipe to update.'),
            expectedUpdatedAt: expectedUpdatedAtSchema,
            instructions: z
              .array(recipeInstructionInputSchema)
              .optional()
              .describe('Replacement form: complete desired ordered instruction list. Cannot be combined with the delta fields.'),
            ...recipeInstructionDeltaFields(),
          }),
        )
        .min(1, 'At least one recipe update is required.')
        .max(RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE, `At most ${RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE} recipes are allowed per batch call.`)
        .describe(
          `One entry per recipe. Max ${RECIPE_INSTRUCTIONS_BATCH_MAX_SIZE} per call; each slug must be unique within the call.`,
        ),
    },
    async ({ updates }) => {
      try {
        const result = await updateRecipeInstructionsBatch(updates);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/organizers/categories, POST /api/organizers/categories, GET /api/organizers/tags, POST /api/organizers/tags, GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  server.tool(
    'update_recipe_taxonomy',
    'Updates a recipe\'s categories and/or tags. Resolves requested names/slugs/IDs against existing taxonomy, ' +
      'optionally auto-creating missing values. Reads the recipe first to merge with existing taxonomy. Per ' +
      'collection, use either categories/tags (+ mode merge/replace) or the delta fields ' +
      'addCategories/removeCategories/addTags/removeTags (current - remove + add, other assignments untouched); ' +
      'additions and removals can be combined in one call. Removals must exist and are never created; ' +
      'createMissing only applies to additions. Unchanged Category/Tag collections are never written, whether the ' +
      'legacy merge/replace form or explicit delta form is used; if nothing changes, no recipe PATCH is issued. ' +
      'Returns final/added/removed/created per collection.',
    {
      slug: z.string().describe('Slug of the recipe to update.'),
      categories: categoriesParamSchema.optional(),
      tags: tagsParamSchema.optional(),
      ...taxonomyDeltaFields(),
      mode: taxonomyModeSchema.optional(),
      createMissing: createMissingSchema.optional(),
    },
    async ({ slug, ...input }) => {
      try {
        const result = await updateRecipeTaxonomy(slug, input);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/organizers/categories, POST /api/organizers/categories, GET /api/organizers/tags, POST /api/organizers/tags, GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  server.tool(
    'update_recipe_taxonomy_batch',
    'Runs update_recipe_taxonomy for multiple recipes with bounded concurrency (5 at a time), returning a ' +
      'success/error result per recipe. Each entry accepts the same legacy (categories/tags + mode) or delta ' +
      '(addCategories/removeCategories/addTags/removeTags) fields. Each slug may appear only once; a request ' +
      'that repeats a slug is rejected as a whole before any recipe is processed. Category/tag creation via ' +
      'createMissing is serialized across the batch so a value requested by several recipes is created once, ' +
      'but createMissing applies per entry: an entry without it may fail as missing even if another entry ' +
      'creates that value, so set createMissing on every entry that names a new category or tag.',
    {
      updates: z
        .array(
          z.object({
            slug: z.string().describe('Slug of the recipe to update.'),
            categories: categoriesParamSchema.optional(),
            tags: tagsParamSchema.optional(),
            ...taxonomyDeltaFields(),
            mode: taxonomyModeSchema.optional(),
            createMissing: createMissingSchema.optional(),
          }),
        )
        .describe(
          'One entry per recipe to update; slugs must be unique (duplicates reject the whole request with no ' +
            'changes). Each recipe is processed independently with bounded concurrency — a failure on one recipe ' +
            'does not abort the others, and the response includes a success/error result for every entry.',
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

  // @endpoints GET /api/recipes/{slug}, GET /api/organizers/tools, POST /api/organizers/tools, PATCH /api/recipes/{slug}
  server.tool(
    'update_recipe_tools',
    'Assigns Mealie Tool organizers (equipment, e.g. "Whisk", "Sheet Pan") to one existing recipe. You decide which ' +
      'tools the recipe needs; this tool only resolves them deterministically (exact ID, then slug, then name, ' +
      'case-insensitive — no fuzzy matching or substitution) and persists them, PATCHing only the recipe\'s tools ' +
      'field. Two mutually exclusive forms: (1) tools + mode — "merge" (default) keeps existing assignments, ' +
      '"replace" sets the complete collection and DESTRUCTIVELY clears all assigned tools when tools is an empty ' +
      'array; (2) add and/or remove — a delta computed as current - remove + add, leaving every other assigned ' +
      'tool untouched. Unknown tools fail the call before any recipe write unless createMissing is true, which ' +
      'creates values from tools/add (never from remove); if a later creation or the recipe write then fails, any ' +
      'Tool organizers already created remain (no rollback). The same tool in both add and remove is rejected, ' +
      'and a call that changes nothing skips the recipe write.',
    updateRecipeToolsFields(),
    async ({ slug, tools, mode, add, remove, createMissing }) => {
      try {
        const result = await updateRecipeTools(slug, { tools, mode, add, remove, createMissing });
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/recipes/{slug}, GET /api/organizers/tools, POST /api/organizers/tools, PATCH /api/recipes/{slug}
  server.tool(
    'update_recipe_tools_batch',
    'Applies update_recipe_tools to several recipes in one call. Each update accepts the same legacy (tools + ' +
      'mode) or delta (add/remove) contract as the singular tool, with the same deterministic ID/slug/name ' +
      'resolution — you decide which tools each recipe needs. Recipes are processed independently with bounded ' +
      'concurrency (5 at a time), results are returned in input order with per-recipe success/error plus ' +
      'requested/succeeded/failed counts, and a failure on one recipe never stops or rolls back the others (no ' +
      'cross-recipe transaction; Tool organizers created for a recipe that later fails remain). Organizer ' +
      'creation via createMissing is serialized across the batch so a Tool requested by several recipes is ' +
      'created once. createMissing still applies per entry: an entry without it may fail as missing even if ' +
      'another entry in the same call creates that Tool, so set createMissing on every entry that names a new ' +
      `Tool. The whole call is rejected before any write for an empty batch, more than ${RECIPE_TOOLS_BATCH_MAX_SIZE} ` +
      'updates, a missing slug, or the same recipe slug repeated.',
    {
      updates: z
        .array(z.object({ slug: z.string().describe('Slug of the recipe to update.'), ...updateRecipeToolsMutationFields() }))
        .min(1, 'At least one recipe update is required.')
        .max(RECIPE_TOOLS_BATCH_MAX_SIZE, `At most ${RECIPE_TOOLS_BATCH_MAX_SIZE} recipes are allowed per batch call.`)
        .describe(
          `One entry per recipe, each with its own tools/mode or add/remove mutation. Max ${RECIPE_TOOLS_BATCH_MAX_SIZE} ` +
            'per call; each slug must be unique within the call.',
        ),
    },
    async ({ updates }) => {
      try {
        const result = await updateRecipeToolsBatch(updates);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints POST /api/recipes/{slug}/duplicate
  server.tool(
    'duplicate_recipe',
    'Creates a duplicate of an existing recipe with an optional new name.',
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

  // @endpoints PATCH /api/recipes/{slug}/last-made
  server.tool(
    'mark_recipe_last_made',
    'Records when a recipe was last made. Without `timestamp` it records now. `timestamp` is an ISO 8601 date-time ' +
    '(e.g. 2026-09-29T18:45:00Z; without an offset it is local time) or a plain date (YYYY-MM-DD), which is stored ' +
    'as noon local time on that day so time-zone conversion cannot shift it to the previous day (today is clamped ' +
    'to now). Unparseable values and future times are rejected without calling Mealie. Mealie only moves a recipe\'s ' +
    'lastMade forward: a timestamp older than the current lastMade is accepted but leaves it unchanged.',
    { slug: z.string(), timestamp: z.string().optional() },
    async ({ slug, timestamp }) => {
      try {
        const result = await recipesApi.updateRecipeLastMade(slug, resolveLastMadeTimestamp(timestamp));
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints PUT /api/recipes/{slug}/image, DELETE /api/recipes/{slug}/image
  server.tool(
    'set_recipe_image',
    'Sets, replaces, or deletes a recipe\'s image. Pass `imageBase64` as base64-encoded PNG, JPEG, WebP, or GIF data (max 10 MB; a data: URI prefix is accepted) to upload or replace the image, or pass `null` to delete the existing image. Input is validated before anything is sent to Mealie, and no other recipe fields are touched. `extension` is optional; the format is detected from the data, and a mismatching extension is rejected. To set an image from a URL instead, use `set_recipe_image_from_url`.',
    {
      slug: z.string(),
      imageBase64: z.string().nullable().describe('Base64-encoded image data to upload, or null to delete the recipe image.'),
      extension: z.string().optional().describe('Optional image extension (png, jpg, jpeg, webp, gif); must match the data.'),
    },
    async ({ slug, imageBase64, extension }) => {
      try {
        const result = await setRecipeImage(slug, imageBase64, extension);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  // @endpoints GET /api/users/self, POST /api/users/{id}/ratings/{slug}, GET /api/recipes/{slug}, GET /api/users/self/ratings/{recipe_id}
  server.tool(
    'set_recipe_rating',
    'Sets the rating and/or favorite flag of a recipe for the user behind the API key. The rating is per user; ' +
      'the recipe\'s own `rating` field is the aggregate over all users (with a single rater they are equal). ' +
      `rating is ${RECIPE_RATING_MIN}–${RECIPE_RATING_MAX} in steps of ${RECIPE_RATING_STEP} (Mealie itself does not validate the range); ` +
      'null clears the caller\'s rating (stored as 0, reported as null); omit it to leave the rating unchanged. ' +
      'isFavorite alone changes only the favorite flag. At least one of the two is required. ' +
      'Returns { userRating: { recipeId, rating, isFavorite }, recipeRating } read back after the update.',
    {
      slug: z.string(),
      rating: z
        .number()
        .min(RECIPE_RATING_MIN)
        .max(RECIPE_RATING_MAX)
        .multipleOf(RECIPE_RATING_STEP)
        .nullable()
        .optional(),
      isFavorite: z.boolean().optional(),
    },
    async ({ slug, rating, isFavorite }) => {
      try {
        const result = await setRecipeRating({ slug, rating, isFavorite });
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  const setRecipeImageFromFileTool =
  // @endpoints PUT /api/recipes/{slug}/image
  server.tool(
    'set_recipe_image_from_file',
    'Sets or replaces a recipe\'s image from a host-provided file reference (host-dependent: only hosts that can pass file parameters, such as ChatGPT via `openai/fileParams`, supply `file`). The server downloads `file.download_url` directly, so no base64 passes through the model. Preferred order: this tool when the host provides a file reference; `set_recipe_image_from_url` when the image is at a fetchable URL; `set_recipe_image` with base64 as the portable fallback (and with `null` to delete an image). The download is limited to public http(s) hosts, a timeout, and 10 MB; PNG, JPEG, WebP, and GIF are accepted and the format is detected from the bytes (`mime_type`/`file_name` are only hints). Validation happens before anything is sent to Mealie, and no other recipe fields are touched.',
    {
      slug: z.string(),
      file: z.object({
        download_url: z.string().describe('Temporary URL the server downloads the file from.'),
        file_id: z.string().describe('Host file identifier.'),
        mime_type: z.string().optional().describe('Optional MIME type hint; not trusted.'),
        file_name: z.string().optional().describe('Optional file name hint; not trusted.'),
      }),
    },
    async ({ slug, file }) => {
      try {
        const result = await setRecipeImageFromFile(slug, file);
        return successResponse(result);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
  // Optional OpenAI host extension; generic MCP clients ignore it.
  if (setRecipeImageFromFileTool) {
    setRecipeImageFromFileTool._meta = { 'openai/fileParams': ['file'] };
  }

  // @endpoints POST /api/recipes/{slug}/image
  server.tool(
    'set_recipe_image_from_url',
    'Sets a recipe\'s image from a URL.',
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

  // @endpoints DELETE /api/recipes/{slug}
  server.tool(
    'delete_recipe',
    'Permanently deletes a recipe.',
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

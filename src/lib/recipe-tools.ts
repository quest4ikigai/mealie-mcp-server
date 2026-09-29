import * as recipesApi from '../api/recipes.js';
import * as toolsApi from '../api/tools.js';
import {
  computeFinal,
  resolveTaxonomyValues,
  toApiPayloadItem,
  toTaxonomyItem,
  toTaxonomyItems,
  type TaxonomyCollectionResult,
  type TaxonomyMode,
} from './recipe-taxonomy.js';

export interface RecipeToolsInput {
  tools: string[];
  mode?: TaxonomyMode;
  createMissing?: boolean;
}

export interface RecipeToolsResult {
  id: string;
  slug: string;
  tools: TaxonomyCollectionResult;
}

export class MissingToolsError extends Error {
  constructor(public readonly values: string[]) {
    super(
      `The following tools do not exist: ${values.join(', ')}. ` +
        `Pass createMissing: true to create ${values.length === 1 ? 'it' : 'them'} automatically, ` +
        'or correct the tool name(s)/slug(s)/ID(s). No changes were made to the recipe.',
    );
    this.name = 'MissingToolsError';
  }
}

/**
 * Fetches the recipe, resolves the requested Tool organizers (ID, then slug, then name, all exact
 * and case-insensitive — no fuzzy matching), and PATCHes only the recipe's `tools` field. If
 * createMissing creates an organizer and the recipe PATCH then fails, the created organizer remains.
 */
export async function updateRecipeTools(slug: string, input: RecipeToolsInput): Promise<RecipeToolsResult> {
  const mode = input.mode ?? 'merge';
  const recipe = await recipesApi.getRecipe(slug);
  const current = toTaxonomyItems(recipe.tools);

  const all = (await toolsApi.getTools({ perPage: -1 })).items.map(toTaxonomyItem);
  const { resolved, created, missing } = await resolveTaxonomyValues(
    input.tools,
    all,
    input.createMissing ?? false,
    toolsApi.createTool,
  );
  if (missing.length > 0) {
    throw new MissingToolsError(missing);
  }

  const { final, added, removed } = computeFinal(mode, current, resolved);

  const noop = mode === 'merge' && added.length === 0;
  if (!noop) {
    await recipesApi.patchRecipe(slug, { tools: final.map(toApiPayloadItem) });
  }

  return {
    id: String(recipe.id),
    slug: typeof recipe.slug === 'string' ? recipe.slug : slug,
    tools: { final, added, removed, created },
  };
}

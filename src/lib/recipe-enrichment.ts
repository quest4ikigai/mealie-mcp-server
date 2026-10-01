import { scanAuditedRecipes, type ClockOptions, type RecipeEnrichmentAudit, type AuditFailure } from './recipe-audit.js';
import { toCompactIngredient, type CompactIngredient, type CompactRef } from './recipe-ingredient-parsing.js';
import {
  decodeCursor,
  str,
  idString,
  toArray,
  toTaxonomyItem,
  InvalidCursorError,
  InvalidLimitError as SharedInvalidLimitError,
  type TaxonomyItem,
} from './recipe-scan.js';

export const ENRICHMENT_DEFAULT_LIMIT = 25;
export const ENRICHMENT_MAX_LIMIT = 50;

export { InvalidCursorError };

export class InvalidLimitError extends SharedInvalidLimitError {
  constructor(limit: unknown) {
    super(limit, ENRICHMENT_MAX_LIMIT);
  }
}

export class InvalidEnrichmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnrichmentInputError';
  }
}

export type IngredientParsingFilter = 'unparsed' | 'partial' | 'unparsed_or_partial';
export type InstructionIngredientLinksFilter = 'missing' | 'dangling' | 'missing_or_dangling';
export type EnrichmentMatchMode = 'any' | 'all';

/** Booleans: true = present, false = absent. */
export interface EnrichmentFilters {
  ingredientParsing?: IngredientParsingFilter;
  ingredientSections?: boolean;
  instructionIngredientLinks?: InstructionIngredientLinksFilter;
  tools?: boolean;
  categories?: boolean;
  tags?: boolean;
  image?: boolean;
}

export type EnrichmentDimension = keyof EnrichmentFilters;

export const ENRICHMENT_DIMENSIONS: readonly EnrichmentDimension[] = [
  'ingredientParsing',
  'ingredientSections',
  'instructionIngredientLinks',
  'tools',
  'categories',
  'tags',
  'image',
];

export const DEFAULT_ENRICHMENT_FILTERS: Readonly<Required<EnrichmentFilters>> = {
  ingredientParsing: 'unparsed_or_partial',
  ingredientSections: false,
  instructionIngredientLinks: 'missing_or_dangling',
  tools: false,
  categories: false,
  tags: false,
  image: false,
};

export interface CompactInstruction {
  title: string;
  text: string;
  ingredientReferenceIds: string[];
}

export interface RecipeForDataEnrichment {
  id: string;
  slug: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
  description: string | null;
  totalTime: string | null;
  prepTime: string | null;
  cookTime: string | null;
  servings: number | null;
  yield: string | null;
  sourceUrl: string | null;
  ingredients: CompactIngredient[];
  instructions: CompactInstruction[];
  tools: CompactRef[];
  categories: TaxonomyItem[];
  tags: TaxonomyItem[];
  audit: RecipeEnrichmentAudit;
  matchedDimensions: EnrichmentDimension[];
}

export interface DataEnrichmentPage {
  items: RecipeForDataEnrichment[];
  failures: AuditFailure[];
  nextCursor: string | null;
  scannedCount: number;
  returnedCount: number;
  hasMore: boolean;
}

export interface GetRecipesForDataEnrichmentInput {
  cursor?: string;
  limit?: number;
  match?: EnrichmentMatchMode;
  filters?: EnrichmentFilters;
}

const PARSING_VALUES: readonly string[] = ['unparsed', 'partial', 'unparsed_or_partial'];
const LINKS_VALUES: readonly string[] = ['missing', 'dangling', 'missing_or_dangling'];
const BOOLEAN_DIMENSIONS: readonly EnrichmentDimension[] = ['ingredientSections', 'tools', 'categories', 'tags', 'image'];

function debugLog(...args: unknown[]): void {
  if (process.env.MEALIE_MCP_DEBUG === 'true') {
    // stdout is reserved for MCP JSON-RPC traffic; diagnostics must go to stderr.
    console.error('[get_recipes_for_data_enrichment]', ...args);
  }
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return ENRICHMENT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ENRICHMENT_MAX_LIMIT) throw new InvalidLimitError(limit);
  return limit;
}

function validateMatch(match: unknown): EnrichmentMatchMode {
  if (match === undefined) return 'any';
  if (match !== 'any' && match !== 'all') {
    throw new InvalidEnrichmentInputError(`match must be "any" or "all" (got ${JSON.stringify(match)}).`);
  }
  return match;
}

/** Returns the complete active filter set: explicit filters replace the defaults, never merge. */
export function resolveActiveFilters(filters: unknown): EnrichmentFilters {
  if (filters === undefined) return { ...DEFAULT_ENRICHMENT_FILTERS };
  if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new InvalidEnrichmentInputError('filters must be an object.');
  }
  const raw = filters as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((k) => !(ENRICHMENT_DIMENSIONS as readonly string[]).includes(k));
  if (unknownKeys.length > 0) {
    throw new InvalidEnrichmentInputError(`Unknown filter(s): ${unknownKeys.join(', ')}.`);
  }

  const active: EnrichmentFilters = {};
  for (const dim of ENRICHMENT_DIMENSIONS) {
    const value = raw[dim];
    if (value === undefined) continue;
    if (dim === 'ingredientParsing') {
      if (typeof value !== 'string' || !PARSING_VALUES.includes(value)) {
        throw new InvalidEnrichmentInputError(
          `filters.ingredientParsing must be one of ${PARSING_VALUES.map((v) => `"${v}"`).join(', ')} (got ${JSON.stringify(value)}).`,
        );
      }
      active.ingredientParsing = value as IngredientParsingFilter;
    } else if (dim === 'instructionIngredientLinks') {
      if (typeof value !== 'string' || !LINKS_VALUES.includes(value)) {
        throw new InvalidEnrichmentInputError(
          `filters.instructionIngredientLinks must be one of ${LINKS_VALUES.map((v) => `"${v}"`).join(', ')} (got ${JSON.stringify(value)}).`,
        );
      }
      active.instructionIngredientLinks = value as InstructionIngredientLinksFilter;
    } else if (BOOLEAN_DIMENSIONS.includes(dim)) {
      if (typeof value !== 'boolean') {
        throw new InvalidEnrichmentInputError(`filters.${dim} must be a boolean (got ${JSON.stringify(value)}).`);
      }
      (active as Record<string, unknown>)[dim] = value;
    }
  }
  if (Object.keys(active).length === 0) {
    throw new InvalidEnrichmentInputError(
      'filters must specify at least one dimension. An empty filters object is not "return every recipe"; omit filters to use the default enrichment filters.',
    );
  }
  return active;
}

function matchesDimension(dim: EnrichmentDimension, filters: EnrichmentFilters, audit: RecipeEnrichmentAudit): boolean {
  const { ingredients, instructions } = audit;
  switch (dim) {
    case 'ingredientParsing': {
      const unparsed = ingredients.unparsedCount > 0;
      const partial = ingredients.partialCount > 0;
      if (filters.ingredientParsing === 'unparsed') return unparsed;
      if (filters.ingredientParsing === 'partial') return partial;
      return unparsed || partial;
    }
    case 'ingredientSections':
      return filters.ingredientSections ? ingredients.sectionCount > 0 : ingredients.totalCount > 0 && ingredients.sectionCount === 0;
    case 'instructionIngredientLinks': {
      const missing = instructions.instructionCount > 0 && instructions.referenceCount === 0;
      const dangling = instructions.danglingReferenceCount > 0;
      if (filters.instructionIngredientLinks === 'missing') return missing;
      if (filters.instructionIngredientLinks === 'dangling') return dangling;
      return missing || dangling;
    }
    case 'tools':
      return filters.tools ? audit.toolCount > 0 : audit.toolCount === 0;
    case 'categories':
      return filters.categories ? audit.categoryCount > 0 : audit.categoryCount === 0;
    case 'tags':
      return filters.tags ? audit.tagCount > 0 : audit.tagCount === 0;
    case 'image':
      return filters.image ? audit.hasImage : !audit.hasImage;
  }
}

function matchedDimensionsFor(filters: EnrichmentFilters, audit: RecipeEnrichmentAudit): EnrichmentDimension[] {
  return ENRICHMENT_DIMENSIONS.filter((dim) => filters[dim] !== undefined && matchesDimension(dim, filters, audit));
}

function toCompactInstruction(raw: Record<string, unknown>): CompactInstruction {
  return {
    title: str(raw.title),
    text: str(raw.text),
    ingredientReferenceIds: toArray(raw.ingredientReferences)
      .map((ref) => idString(ref.referenceId))
      .filter(Boolean),
  };
}

function toCompactTool(raw: Record<string, unknown>): CompactRef {
  return { id: idString(raw.id), name: str(raw.name) };
}

function toRecipe(raw: Record<string, unknown>, audit: RecipeEnrichmentAudit, matchedDimensions: EnrichmentDimension[]): RecipeForDataEnrichment {
  return {
    id: idString(raw.id),
    slug: str(raw.slug),
    name: str(raw.name),
    createdAt: str(raw.createdAt) || null,
    updatedAt: str(raw.updatedAt) || null,
    description: str(raw.description) || null,
    totalTime: str(raw.totalTime) || null,
    prepTime: str(raw.prepTime) || null,
    cookTime: str(raw.cookTime) || null,
    servings: typeof raw.recipeServings === 'number' ? raw.recipeServings : null,
    yield: str(raw.recipeYield) || null,
    sourceUrl: str(raw.orgURL) || null,
    ingredients: toArray(raw.recipeIngredient).map(toCompactIngredient),
    instructions: toArray(raw.recipeInstructions).map(toCompactInstruction),
    tools: toArray(raw.tools).map(toCompactTool),
    categories: toArray(raw.recipeCategory).map(toTaxonomyItem),
    tags: toArray(raw.tags).map(toTaxonomyItem),
    audit,
    matchedDimensions,
  };
}

/**
 * Read-only, paginated holistic enrichment work queue. Filters are deterministic predicates over
 * the shared RecipeEnrichmentAudit facts; a match is a review signal, never a verdict. Explicit
 * filters replace the defaults entirely. Scans oldest-created first via the shared stable scanner.
 */
export async function getRecipesForDataEnrichment(
  input: GetRecipesForDataEnrichmentInput,
  clock: ClockOptions = {},
): Promise<DataEnrichmentPage> {
  const limit = validateLimit(input.limit);
  const match = validateMatch(input.match);
  const filters = resolveActiveFilters(input.filters);
  const startCursor = input.cursor ? decodeCursor(input.cursor) : null;
  const activeCount = ENRICHMENT_DIMENSIONS.filter((d) => filters[d] !== undefined).length;

  const startedAt = (clock.now ?? Date.now)();
  const scan = await scanAuditedRecipes<RecipeForDataEnrichment>({
    startCursor,
    limit,
    clock,
    matches: (audit) => {
      const matched = matchedDimensionsFor(filters, audit).length;
      return match === 'all' ? matched === activeCount : matched > 0;
    },
    toItem: (detail, audit) => toRecipe(detail, audit, matchedDimensionsFor(filters, audit)),
  });

  debugLog('scan phase', {
    ms: (clock.now ?? Date.now)() - startedAt,
    scannedCount: scan.scannedCount,
    matchedCount: scan.items.length,
    failureCount: scan.failures.length,
    stopReason: scan.stopReason,
  });

  return {
    items: scan.items,
    failures: scan.failures,
    nextCursor: scan.nextCursor,
    scannedCount: scan.scannedCount,
    returnedCount: scan.items.length,
    hasMore: scan.hasMore,
  };
}

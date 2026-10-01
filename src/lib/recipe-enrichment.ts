import { scanAuditedRecipes, type AuditFailure, type ClockOptions, type RecipeEnrichmentAudit } from './recipe-audit.js';
import {
  toCompactIngredient,
  toCompactInstruction,
  type CompactIngredient,
  type CompactInstruction,
} from './recipe-ingredient-parsing.js';
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

export const ENRICHMENT_DIMENSIONS = [
  'ingredient_parsing',
  'ingredient_sections',
  'instruction_ingredient_links',
  'tools',
  'taxonomy',
  'image',
] as const;

export type EnrichmentDimension = (typeof ENRICHMENT_DIMENSIONS)[number];

export class InvalidDimensionsError extends Error {
  constructor(dimensions: unknown) {
    super(
      `dimensions must be a non-empty list drawn from ${ENRICHMENT_DIMENSIONS.map((d) => `"${d}"`).join(', ')} (got ${JSON.stringify(dimensions)}).`,
    );
    this.name = 'InvalidDimensionsError';
  }
}

/**
 * Deterministic, schema-only check of whether a dimension has something worth a look. A flag only
 * states a fact about stored shape (e.g. "tool count is zero"); it never claims the recipe
 * *should* change — that decision belongs to the calling model.
 */
export function isDimensionFlagged(audit: RecipeEnrichmentAudit, dimension: EnrichmentDimension): boolean {
  switch (dimension) {
    case 'ingredient_parsing':
      return audit.ingredients.unparsedCount > 0;
    case 'ingredient_sections':
      return audit.ingredients.totalCount > audit.ingredients.sectionCount && audit.ingredients.sectionCount === 0;
    case 'instruction_ingredient_links':
      return (
        audit.instructions.instructionCount > 0 &&
        (audit.instructions.referencedInstructionCount === 0 || audit.instructions.danglingReferenceCount > 0)
      );
    case 'tools':
      return audit.toolCount === 0;
    case 'taxonomy':
      return audit.categoryCount === 0 || audit.tagCount === 0;
    case 'image':
      return !audit.hasImage;
    default: {
      const exhaustive: never = dimension;
      throw new Error(`Unsupported dimension: ${String(exhaustive)}`);
    }
  }
}

export interface RecipeForEnrichment {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  categories: TaxonomyItem[];
  tags: TaxonomyItem[];
  tools: TaxonomyItem[];
  totalTime: string | null;
  prepTime: string | null;
  cookTime: string | null;
  servings: number | null;
  yield: string | null;
  hasImage: boolean;
  ingredients: CompactIngredient[];
  instructions: CompactInstruction[];
  audit: RecipeEnrichmentAudit;
  /** Selected dimensions whose deterministic facts are flagged for this recipe. */
  flaggedDimensions: EnrichmentDimension[];
}

export interface EnrichmentPage {
  items: RecipeForEnrichment[];
  failures: AuditFailure[];
  nextCursor: string | null;
  scannedCount: number;
  returnedCount: number;
  hasMore: boolean;
}

export interface GetRecipesForDataEnrichmentInput {
  cursor?: string;
  limit?: number;
  dimensions?: EnrichmentDimension[];
  onlyFlagged?: boolean;
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return ENRICHMENT_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ENRICHMENT_MAX_LIMIT) {
    throw new InvalidLimitError(limit);
  }
  return limit;
}

function validateDimensions(dimensions: EnrichmentDimension[] | undefined): EnrichmentDimension[] {
  if (dimensions === undefined) return [...ENRICHMENT_DIMENSIONS];
  if (!Array.isArray(dimensions) || dimensions.length === 0 || dimensions.some((d) => !ENRICHMENT_DIMENSIONS.includes(d))) {
    throw new InvalidDimensionsError(dimensions);
  }
  return ENRICHMENT_DIMENSIONS.filter((d) => dimensions.includes(d));
}

function toEnrichmentRecipe(
  raw: Record<string, unknown>,
  audit: RecipeEnrichmentAudit,
  flaggedDimensions: EnrichmentDimension[],
): RecipeForEnrichment {
  return {
    id: idString(raw.id),
    slug: str(raw.slug),
    name: str(raw.name),
    description: str(raw.description) || null,
    categories: toArray(raw.recipeCategory).map(toTaxonomyItem),
    tags: toArray(raw.tags).map(toTaxonomyItem),
    tools: toArray(raw.tools).map(toTaxonomyItem),
    totalTime: str(raw.totalTime) || null,
    prepTime: str(raw.prepTime) || null,
    cookTime: str(raw.cookTime) || null,
    servings: typeof raw.recipeServings === 'number' ? raw.recipeServings : null,
    yield: str(raw.recipeYield) || null,
    hasImage: audit.hasImage,
    ingredients: toArray(raw.recipeIngredient).map(toCompactIngredient),
    instructions: toArray(raw.recipeInstructions).map(toCompactInstruction),
    audit,
    flaggedDimensions,
  };
}

/**
 * Read-only, paginated, holistic enrichment queue. Every scanned recipe is detail-fetched (bounded
 * concurrency, per-recipe failure isolation) and audited via the shared auditRecipe model; a recipe
 * is returned when at least one selected dimension is flagged (or always, with onlyFlagged=false).
 * Reports facts only — what to change is decided by the caller.
 */
export async function getRecipesForDataEnrichment(
  input: GetRecipesForDataEnrichmentInput,
  clock: ClockOptions = {},
): Promise<EnrichmentPage> {
  const limit = validateLimit(input.limit);
  const dimensions = validateDimensions(input.dimensions);
  const onlyFlagged = input.onlyFlagged ?? true;
  const startCursor = input.cursor ? decodeCursor(input.cursor) : null;

  const flaggedFor = (audit: RecipeEnrichmentAudit) => dimensions.filter((d) => isDimensionFlagged(audit, d));

  const scan = await scanAuditedRecipes<RecipeForEnrichment>({
    startCursor,
    limit,
    clock,
    matches: (audit) => !onlyFlagged || flaggedFor(audit).length > 0,
    toItem: (detail, audit) => toEnrichmentRecipe(detail, audit, flaggedFor(audit)),
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

import {
  classifyIngredient,
  scanAuditedRecipes,
  type ClockOptions,
  type IngredientParsingCounts,
  type IngredientState,
} from './recipe-audit.js';
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

export const INGREDIENT_PARSING_DEFAULT_LIMIT = 25;
export const INGREDIENT_PARSING_MAX_LIMIT = 50;
export const INGREDIENT_PARSING_DEFAULT_STATE: IngredientParsingQueryState = 'unparsed_only';

function debugLog(...args: unknown[]): void {
  if (process.env.MEALIE_MCP_DEBUG === 'true') {
    // stdout is reserved for MCP JSON-RPC traffic; diagnostics must go to stderr.
    console.error('[get_recipes_for_ingredient_parsing]', ...args);
  }
}

export { InvalidCursorError };

export class InvalidLimitError extends SharedInvalidLimitError {
  constructor(limit: unknown) {
    super(limit, INGREDIENT_PARSING_MAX_LIMIT);
  }
}

/**
 * Which recipes to return, based purely on the deterministic per-ingredient `parsingState`
 * (see classifyIngredient below) — never on semantic interpretation of ingredient text:
 *  - "unparsed_only": at least one ingredient has no associated food (excluding section
 *    headings) — the strong, low-noise signal that a line still needs a food resolved.
 *  - "partially_parsed": at least one ingredient has a food but no unit (see classifyIngredient
 *    for the documented false-positive tradeoff this carries for legitimately unit-less
 *    countable foods like "4 eggs").
 *  - "any": no filtering — every scanned recipe is a "match", useful for auditing.
 */
export type IngredientParsingQueryState = 'unparsed_only' | 'partially_parsed' | 'any';

const INGREDIENT_PARSING_QUERY_STATES: readonly IngredientParsingQueryState[] = ['unparsed_only', 'partially_parsed', 'any'];

export class InvalidStateError extends Error {
  constructor(state: unknown) {
    super(`state must be one of ${INGREDIENT_PARSING_QUERY_STATES.map((s) => `"${s}"`).join(', ')} (got ${JSON.stringify(state)}).`);
    this.name = 'InvalidStateError';
  }
}

export type { IngredientState, IngredientParsingCounts };

export interface CompactRef {
  id: string;
  name: string;
}

export interface CompactIngredient {
  referenceId: string;
  quantity: number | null;
  unit: CompactRef | null;
  food: CompactRef | null;
  note: string;
  display: string;
  originalText: string | null;
  title: string | null;
  parsingState: IngredientState;
}

export interface CompactInstruction {
  id?: string;
  title: string;
  text: string;
  ingredientReferences: unknown[];
}

export interface RecipeForIngredientParsing {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  categories: TaxonomyItem[];
  tags: TaxonomyItem[];
  totalTime: string | null;
  prepTime: string | null;
  cookTime: string | null;
  servings: number | null;
  yield: string | null;
  ingredients: CompactIngredient[];
  instructions: CompactInstruction[];
  ingredientParsingState: IngredientParsingCounts;
}

export interface IngredientParsingFailure {
  slug?: string;
  id?: string;
  error: string;
}

export interface IngredientParsingPage {
  items: RecipeForIngredientParsing[];
  failures: IngredientParsingFailure[];
  nextCursor: string | null;
  scannedCount: number;
  returnedCount: number;
  hasMore: boolean;
}

export interface GetRecipesForIngredientParsingInput {
  cursor?: string;
  limit?: number;
  state?: IngredientParsingQueryState;
}

function toCompactRef(raw: unknown): CompactRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return { id: idString(r.id), name: str(r.name) };
}

export function toCompactIngredient(raw: Record<string, unknown>): CompactIngredient {
  return {
    referenceId: idString(raw.referenceId),
    quantity: typeof raw.quantity === 'number' ? raw.quantity : null,
    unit: toCompactRef(raw.unit),
    food: toCompactRef(raw.food),
    note: str(raw.note),
    display: str(raw.display),
    originalText: str(raw.originalText) || null,
    title: str(raw.title) || null,
    parsingState: classifyIngredient(raw),
  };
}

function toCompactInstruction(raw: Record<string, unknown>): CompactInstruction {
  const id = str(raw.id);
  return {
    ...(id ? { id } : {}),
    title: str(raw.title),
    text: str(raw.text),
    ingredientReferences: Array.isArray(raw.ingredientReferences) ? raw.ingredientReferences : [],
  };
}

function matchesQueryState(counts: IngredientParsingCounts, state: IngredientParsingQueryState): boolean {
  switch (state) {
    case 'any':
      return true;
    case 'unparsed_only':
      return counts.unparsedCount > 0;
    case 'partially_parsed':
      return counts.partialCount > 0;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unsupported state: ${String(exhaustive)}`);
    }
  }
}

function toCompactRecipe(raw: Record<string, unknown>, counts: IngredientParsingCounts): RecipeForIngredientParsing {
  const ingredients = toArray(raw.recipeIngredient).map(toCompactIngredient);
  const instructions = toArray(raw.recipeInstructions).map(toCompactInstruction);
  return {
    id: idString(raw.id),
    slug: str(raw.slug),
    name: str(raw.name),
    description: str(raw.description) || null,
    categories: toArray(raw.recipeCategory).map(toTaxonomyItem),
    tags: toArray(raw.tags).map(toTaxonomyItem),
    totalTime: str(raw.totalTime) || null,
    prepTime: str(raw.prepTime) || null,
    cookTime: str(raw.cookTime) || null,
    servings: typeof raw.recipeServings === 'number' ? raw.recipeServings : null,
    yield: str(raw.recipeYield) || null,
    ingredients,
    instructions,
    ingredientParsingState: counts,
  };
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return INGREDIENT_PARSING_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > INGREDIENT_PARSING_MAX_LIMIT) {
    throw new InvalidLimitError(limit);
  }
  return limit;
}

function validateState(state: IngredientParsingQueryState | undefined): IngredientParsingQueryState {
  if (state === undefined) return INGREDIENT_PARSING_DEFAULT_STATE;
  if (!INGREDIENT_PARSING_QUERY_STATES.includes(state)) {
    throw new InvalidStateError(state);
  }
  return state;
}

/**
 * Read-only, paginated work queue of recipes whose ingredients may need structured parsing. The
 * MCP server does NOT parse ingredient text or interpret it semantically — it only reports each
 * ingredient's already-existing structured state (see classifyIngredient) so the calling model
 * can do the interpretation and later write a complete collection via update_recipe_ingredients.
 *
 * Unlike get_recipes_for_classification, this cannot pre-filter from the cheap list response —
 * Mealie's /api/recipes list endpoint does not include recipeIngredient, so every scanned recipe
 * needs a detail fetch to know whether it matches. Detail fetches happen in small batches
 * (DETAIL_FETCH_BATCH_SIZE) with bounded concurrency while scanning, rather than loading the
 * whole collection into memory or firing every request at once.
 */
export async function getRecipesForIngredientParsing(
  input: GetRecipesForIngredientParsingInput,
  clock: ClockOptions = {},
): Promise<IngredientParsingPage> {
  const limit = validateLimit(input.limit);
  const state = validateState(input.state);
  const startCursor = input.cursor ? decodeCursor(input.cursor) : null;

  const scanStartedAt = (clock.now ?? Date.now)();
  const scan = await scanAuditedRecipes<RecipeForIngredientParsing>({
    startCursor,
    limit,
    clock,
    matches: (audit) => matchesQueryState(audit.ingredients, state),
    toItem: (detail, audit) => toCompactRecipe(detail, audit.ingredients),
  });

  debugLog('scan phase', {
    ms: (clock.now ?? Date.now)() - scanStartedAt,
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

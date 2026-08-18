import * as recipesApi from '../api/recipes.js';
import { mapWithConcurrency, DEFAULT_DETAIL_FETCH_CONCURRENCY } from './concurrency.js';

export const CLASSIFICATION_DEFAULT_LIMIT = 25;
export const CLASSIFICATION_MAX_LIMIT = 50;
export const CLASSIFICATION_DEFAULT_TAXONOMY_STATE: TaxonomyState = 'missing_either';

// Mealie's recipe list endpoint has no native "after" cursor, only page/perPage. We scan it
// ordered by createdAt (immutable, and new recipes always sort last) in pages of this size,
// re-sorting each page client-side by (createdAt, id) so ordering is deterministic even if
// the server's tie-break for equal timestamps is not. See buildCursor/resumeScan below for
// how this is turned into a stable, self-correcting continuation token.
const SCAN_PAGE_SIZE = 50;

// Soft internal budget: if scanning runs long (e.g. a large library with few unclassified
// recipes when taxonomyState is restrictive), stop and hand back a partial page with a cursor
// rather than risking an MCP gateway timeout.
const DEFAULT_DEADLINE_MS = 20_000;

function debugLog(...args: unknown[]): void {
  if (process.env.MEALIE_MCP_DEBUG === 'true') {
    // stdout is reserved for MCP JSON-RPC traffic; diagnostics must go to stderr.
    console.error('[get_recipes_for_classification]', ...args);
  }
}

export type TaxonomyState = 'missing_either' | 'missing_both' | 'missing_categories' | 'missing_tags' | 'any';

export interface TaxonomyItem {
  id: string;
  name: string;
  slug: string;
}

export interface RecipeForClassification {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  totalTime: string | null;
  prepTime: string | null;
  cookTime: string | null;
  servings: number | null;
  yield: string | null;
  sourceUrl: string | null;
  ingredients: string[];
  instructions: string[];
  categories: TaxonomyItem[];
  tags: TaxonomyItem[];
}

export interface ClassificationFailure {
  slug?: string;
  id?: string;
  error: string;
}

export interface ClassificationPage {
  items: RecipeForClassification[];
  failures: ClassificationFailure[];
  nextCursor: string | null;
  scannedCount: number;
  returnedCount: number;
  hasMore: boolean;
}

export interface GetRecipesForClassificationInput {
  cursor?: string;
  limit?: number;
  taxonomyState?: TaxonomyState;
}

export class InvalidLimitError extends Error {
  constructor(limit: unknown) {
    super(`limit must be between 1 and ${CLASSIFICATION_MAX_LIMIT} (got ${JSON.stringify(limit)}).`);
    this.name = 'InvalidLimitError';
  }
}

export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`Invalid cursor: ${reason}`);
    this.name = 'InvalidCursorError';
  }
}

interface ScanCursor {
  v: 1;
  lastCreatedAt: string;
  lastId: string;
  page: number;
}

function encodeCursor(cursor: ScanCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): ScanCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('not valid base64url-encoded JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidCursorError('decoded payload is not an object.');
  }
  const c = parsed as Record<string, unknown>;
  if (c.v !== 1) {
    throw new InvalidCursorError('unsupported or missing cursor version.');
  }
  if (typeof c.lastCreatedAt !== 'string' || !c.lastCreatedAt) {
    throw new InvalidCursorError('missing or malformed lastCreatedAt.');
  }
  if (typeof c.lastId !== 'string' || !c.lastId) {
    throw new InvalidCursorError('missing or malformed lastId.');
  }
  if (typeof c.page !== 'number' || !Number.isInteger(c.page) || c.page < 1) {
    throw new InvalidCursorError('missing or malformed page.');
  }

  return { v: 1, lastCreatedAt: c.lastCreatedAt, lastId: c.lastId, page: c.page };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Mealie ids are UUID strings, but this stays defensive against unexpected shapes rather than
// stringifying an object into "[object Object]".
function idString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function toArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function compareScanPosition(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

interface ScannedRecipe {
  summary: Record<string, unknown>;
  createdAt: string;
  id: string;
  page: number;
}

/**
 * Walks the complete recipe collection in a stable order (createdAt asc, id as tie-breaker),
 * resuming from `startCursor` if given. New recipes always sort after everything already
 * scanned (createdAt only increases), so they never shift already-issued page positions.
 * Deletions/edits to already-scanned recipes are handled by re-fetching the cursor's page and
 * skipping everything at or before the cursor position, rather than trusting page arithmetic
 * blindly — so a recipe gaining/losing categories or tags between calls can never cause another
 * recipe to be skipped.
 */
async function* scanRecipesStable(startCursor: ScanCursor | null): AsyncGenerator<ScannedRecipe> {
  let page = startCursor?.page ?? 1;
  let skipUntil: { createdAt: string; id: string } | null = startCursor
    ? { createdAt: startCursor.lastCreatedAt, id: startCursor.lastId }
    : null;

  for (;;) {
    const result = await recipesApi.getRecipes({
      page,
      perPage: SCAN_PAGE_SIZE,
      orderBy: 'createdAt',
      orderDirection: 'asc',
    });
    const items = result.items ?? [];
    if (items.length === 0) return;

    const normalized = items
      .map((raw) => ({
        raw,
        createdAt: str(raw.createdAt),
        id: idString(raw.id),
      }))
      .sort((a, b) => compareScanPosition(a, b));

    for (const entry of normalized) {
      if (skipUntil && compareScanPosition(entry, skipUntil) <= 0) continue;
      yield { summary: entry.raw, createdAt: entry.createdAt, id: entry.id, page };
    }

    skipUntil = null;

    const total = typeof result.total === 'number' ? result.total : undefined;
    const isLastPage = items.length < SCAN_PAGE_SIZE || (total !== undefined && page * SCAN_PAGE_SIZE >= total);
    if (isLastPage) return;
    page++;
  }
}

function matchesTaxonomyState(categories: unknown[], tags: unknown[], state: TaxonomyState): boolean {
  const categoriesEmpty = categories.length === 0;
  const tagsEmpty = tags.length === 0;
  switch (state) {
    case 'any':
      return true;
    case 'missing_either':
      return categoriesEmpty || tagsEmpty;
    case 'missing_both':
      return categoriesEmpty && tagsEmpty;
    case 'missing_categories':
      return categoriesEmpty;
    case 'missing_tags':
      return tagsEmpty;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unsupported taxonomyState: ${String(exhaustive)}`);
    }
  }
}

function toTaxonomyItem(raw: unknown): TaxonomyItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { id: idString(r.id), name: str(r.name), slug: str(r.slug) };
}

function getName(value: unknown): string {
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).name === 'string') {
    return str((value as Record<string, unknown>).name);
  }
  return '';
}

function reconstructIngredientText(raw: Record<string, unknown>): string {
  const quantity = typeof raw.quantity === 'number' && raw.quantity > 0 ? String(raw.quantity) : '';
  const unitName = getName(raw.unit);
  const foodName = getName(raw.food);
  return [quantity, unitName, foodName].filter(Boolean).join(' ').trim();
}

/**
 * Most useful human-readable line for one ingredient row: prefer Mealie's computed display
 * text, then the free-form note, then a quantity/unit/food reconstruction, then the raw
 * original text. Bare section-heading rows (title only, no ingredient content) are preserved
 * as their heading. Fully empty rows are dropped rather than emitted as blank strings.
 */
function formatIngredientLine(raw: Record<string, unknown>): string | null {
  const display = str(raw.display);
  if (display) return display;

  const note = str(raw.note);
  if (note) return note;

  const reconstructed = reconstructIngredientText(raw);
  if (reconstructed) return reconstructed;

  const originalText = str(raw.originalText);
  if (originalText) return originalText;

  const title = str(raw.title);
  if (title) return title;

  return null;
}

/**
 * Flattens instruction rows into ordered text, keeping section headings (Mealie sets `title`
 * on the first row of a group and leaves it empty on the rest) as their own entries, and
 * dropping instruction ids, ingredient references, and summaries entirely.
 */
function formatInstructions(raw: unknown): string[] {
  const rows = toArray(raw);
  const out: string[] = [];
  let lastHeading = '';

  for (const row of rows) {
    const title = str(row.title);
    const text = str(row.text);
    if (title && title !== lastHeading) {
      out.push(title);
      lastHeading = title;
    }
    if (text) out.push(text);
  }

  return out;
}

function toCompactRecipe(raw: Record<string, unknown>): RecipeForClassification {
  return {
    id: idString(raw.id),
    slug: str(raw.slug),
    name: str(raw.name),
    description: str(raw.description) || null,
    totalTime: str(raw.totalTime) || null,
    prepTime: str(raw.prepTime) || null,
    cookTime: str(raw.cookTime) || null,
    servings: typeof raw.recipeServings === 'number' ? raw.recipeServings : null,
    yield: str(raw.recipeYield) || null,
    sourceUrl: str(raw.orgURL) || null,
    ingredients: toArray(raw.recipeIngredient)
      .map(formatIngredientLine)
      .filter((line): line is string => line !== null),
    instructions: formatInstructions(raw.recipeInstructions),
    categories: toArray(raw.recipeCategory).map(toTaxonomyItem),
    tags: toArray(raw.tags).map(toTaxonomyItem),
  };
}

interface ClockOptions {
  now?: () => number;
  deadlineMs?: number;
}

function validateLimit(limit: number | undefined): number {
  if (limit === undefined) return CLASSIFICATION_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > CLASSIFICATION_MAX_LIMIT) {
    throw new InvalidLimitError(limit);
  }
  return limit;
}

/**
 * Read-only, paginated feed of recipes for Category/Tag classification. Filters cheaply using
 * the recipe list endpoint's already-embedded recipeCategory/tags (no extra category/tag
 * lookups, no per-candidate detail fetch for recipes that don't match), then fetches full
 * detail with bounded concurrency only for the recipes that will actually be returned, so
 * failures on individual recipes are reported per-item instead of failing the whole call.
 */
export async function getRecipesForClassification(
  input: GetRecipesForClassificationInput,
  clock: ClockOptions = {},
): Promise<ClassificationPage> {
  const limit = validateLimit(input.limit);
  const taxonomyState = input.taxonomyState ?? CLASSIFICATION_DEFAULT_TAXONOMY_STATE;
  const startCursor = input.cursor ? decodeCursor(input.cursor) : null;

  const now = clock.now ?? Date.now;
  const deadline = now() + (clock.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const scanStartedAt = now();
  const matched: ScannedRecipe[] = [];
  let scannedCount = 0;
  let lastScanned: ScannedRecipe | null = null;
  let stopReason: 'limit' | 'deadline' | 'exhausted' = 'exhausted';

  for await (const entry of scanRecipesStable(startCursor)) {
    scannedCount++;
    lastScanned = entry;

    const categories = toArray(entry.summary.recipeCategory);
    const tags = toArray(entry.summary.tags);
    if (matchesTaxonomyState(categories, tags, taxonomyState)) {
      matched.push(entry);
    }

    if (matched.length >= limit) {
      stopReason = 'limit';
      break;
    }
    if (now() > deadline) {
      stopReason = 'deadline';
      break;
    }
  }
  debugLog('scan phase', {
    ms: now() - scanStartedAt,
    scannedCount,
    matchedCount: matched.length,
    stopReason,
  });

  const fetchStartedAt = now();
  const failures: ClassificationFailure[] = [];
  const items: RecipeForClassification[] = [];

  const detailResults = await mapWithConcurrency(matched, DEFAULT_DETAIL_FETCH_CONCURRENCY, async (entry) => {
    const slug = str(entry.summary.slug) || entry.id;
    try {
      const detail = await recipesApi.getRecipe(slug);
      return { success: true as const, detail };
    } catch (error) {
      return {
        success: false as const,
        slug: slug || undefined,
        id: entry.id || undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  debugLog('detail fetch phase', { ms: now() - fetchStartedAt, count: matched.length, concurrency: DEFAULT_DETAIL_FETCH_CONCURRENCY });

  const transformStartedAt = now();
  for (const result of detailResults) {
    if (result.success) {
      items.push(toCompactRecipe(result.detail));
    } else {
      failures.push({ slug: result.slug, id: result.id, error: result.error });
    }
  }
  debugLog('transform phase', { ms: now() - transformStartedAt });

  const hasMore = stopReason !== 'exhausted';
  const nextCursor =
    hasMore && lastScanned
      ? encodeCursor({ v: 1, lastCreatedAt: lastScanned.createdAt, lastId: lastScanned.id, page: lastScanned.page })
      : null;

  return {
    items,
    failures,
    nextCursor,
    scannedCount,
    returnedCount: items.length,
    hasMore,
  };
}

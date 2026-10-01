import * as recipesApi from '../api/recipes.js';
import { mapWithConcurrency, DEFAULT_DETAIL_FETCH_CONCURRENCY } from './concurrency.js';
import { scanRecipesStable, encodeCursor, str, idString, toArray, type ScanCursor, type ScannedRecipe } from './recipe-scan.js';

/**
 * Shared, deterministic, schema-only audit model for recipe enrichment. Every fact here is a
 * count or a presence/absence signal derived from field *shape* — never from text content. The
 * audit layer must not judge whether a recipe should have a given tool, whether a tag is
 * correct, or what an ingredient line means; interpretation belongs to the calling model.
 *
 * Focused work queues (`get_recipes_for_ingredient_parsing`, `get_recipes_for_classification`)
 * consume these facts for their filters, and a future holistic enrichment queue can combine them.
 */

/** See classifyIngredient for the documented meaning (and known limits) of each state. */
export type IngredientState = 'section' | 'unparsed' | 'partial' | 'structured';

export interface IngredientParsingCounts {
  totalCount: number;
  structuredCount: number;
  partialCount: number;
  unparsedCount: number;
  sectionCount: number;
}

export interface InstructionReferenceFacts {
  instructionCount: number;
  /** Instruction steps with at least one ingredient reference. */
  referencedInstructionCount: number;
  /** Total ingredient references across all steps. */
  referenceCount: number;
  /** References whose referenceId matches no ingredient row's referenceId. */
  danglingReferenceCount: number;
  /** Instruction rows that carry a section title. */
  sectionCount: number;
}

export interface RecipeEnrichmentAudit {
  ingredients: IngredientParsingCounts;
  instructions: InstructionReferenceFacts;
  toolCount: number;
  categoryCount: number;
  tagCount: number;
  hasImage: boolean;
}

export interface TaxonomyFacts {
  categoryCount: number;
  tagCount: number;
}

function hasObject(value: unknown): boolean {
  return value !== null && value !== undefined && typeof value === 'object';
}

/**
 * Deterministic, schema-only classification of a single ingredient row. Mealie's RecipeIngredient
 * schema (confirmed against a live instance) exposes no explicit "isFood"/"disableAmount"/
 * "freeform" flag — only `title`, `quantity`, `unit`, `food`, `note`, `display`, `originalText`,
 * and `referenceId` are actually present on read. So the only reliable, non-linguistic signals
 * available are field *presence*, not text content:
 *  - "section": `title` is non-empty. This is Mealie's own documented mechanism for ingredient
 *    section headers (e.g. "For the sauce") — a heading row normally carries no food/unit/note of
 *    its own. Section rows are never counted as needing parsing.
 *  - "unparsed": `title` is empty and `food` is null. This is the primary, high-confidence signal
 *    the tool is built around — Mealie itself has not linked this line to any food.
 *  - "partial": `food` is present but `unit` is null and `quantity` is a positive number. KNOWN,
 *    DOCUMENTED LIMITATION: this cannot be distinguished, without linguistic parsing of the
 *    ingredient text, from a fully-and-correctly-structured count-based ingredient that simply
 *    has no unit (e.g. "4 eggs", "2 lemons", "1 pie crust" — all observed as unit: null on a real
 *    Mealie instance despite being completely resolved). Expect false positives here; treat
 *    "partial" as a coarse audit signal, not a confirmed defect.
 *  - "structured": food is present and either a unit is present, or quantity is not a positive
 *    number (e.g. a garnish like "avocado, diced, for serving" with no meaningful quantity).
 *
 * `originalText` was investigated as a potential "this came from unparsed source text" signal but
 * discarded: on a live instance it was null on every observed ingredient, both fully structured
 * and completely unparsed alike — imported/scraped recipes put the raw line straight into `note`/
 * `display` instead. It is not a reliable signal and is not used for classification.
 *
 * "free_form" (a deliberately non-food entry, e.g. "extra napkins") is NOT a distinct state:
 * nothing in the schema distinguishes it from a genuinely unparsed food ingredient (both are
 * food: null, title: empty, with text in note/display), so such rows are classified "unparsed"
 * rather than fabricating a distinction the data doesn't support.
 */
export function classifyIngredient(raw: Record<string, unknown>): IngredientState {
  if (str(raw.title)) return 'section';
  if (!hasObject(raw.food)) return 'unparsed';

  const quantity = typeof raw.quantity === 'number' ? raw.quantity : null;
  if (!hasObject(raw.unit) && quantity !== null && quantity > 0) return 'partial';

  return 'structured';
}

export function countIngredientStates(states: IngredientState[]): IngredientParsingCounts {
  const counts: IngredientParsingCounts = {
    totalCount: states.length,
    structuredCount: 0,
    partialCount: 0,
    unparsedCount: 0,
    sectionCount: 0,
  };
  for (const state of states) {
    switch (state) {
      case 'structured':
        counts.structuredCount++;
        break;
      case 'partial':
        counts.partialCount++;
        break;
      case 'unparsed':
        counts.unparsedCount++;
        break;
      case 'section':
        counts.sectionCount++;
        break;
    }
  }
  return counts;
}

function auditInstructions(instructions: Record<string, unknown>[], ingredients: Record<string, unknown>[]): InstructionReferenceFacts {
  const knownRefIds = new Set(ingredients.map((row) => idString(row.referenceId)).filter(Boolean));
  const facts: InstructionReferenceFacts = {
    instructionCount: instructions.length,
    referencedInstructionCount: 0,
    referenceCount: 0,
    danglingReferenceCount: 0,
    sectionCount: 0,
  };
  for (const step of instructions) {
    if (str(step.title)) facts.sectionCount++;
    const refs = toArray(step.ingredientReferences);
    if (refs.length > 0) facts.referencedInstructionCount++;
    for (const ref of refs) {
      facts.referenceCount++;
      if (!knownRefIds.has(idString(ref.referenceId))) facts.danglingReferenceCount++;
    }
  }
  return facts;
}

/** Category/tag counts, computable from either the cheap list summary or a full detail. */
export function auditTaxonomy(raw: Record<string, unknown>): TaxonomyFacts {
  return {
    categoryCount: toArray(raw.recipeCategory).length,
    tagCount: toArray(raw.tags).length,
  };
}

/** Computes every audit dimension from a full recipe detail. Pure and deterministic. */
export function auditRecipe(detail: Record<string, unknown>): RecipeEnrichmentAudit {
  const ingredients = toArray(detail.recipeIngredient);
  const taxonomy = auditTaxonomy(detail);
  return {
    ingredients: countIngredientStates(ingredients.map(classifyIngredient)),
    instructions: auditInstructions(toArray(detail.recipeInstructions), ingredients),
    toolCount: toArray(detail.tools).length,
    categoryCount: taxonomy.categoryCount,
    tagCount: taxonomy.tagCount,
    hasImage: str(detail.image) !== '',
  };
}

export interface AuditFailure {
  slug?: string;
  id?: string;
  error: string;
}

export interface ClockOptions {
  now?: () => number;
  deadlineMs?: number;
}

export type ScanStopReason = 'limit' | 'deadline' | 'exhausted';

export const DETAIL_FETCH_BATCH_SIZE = 20;
export const DEFAULT_AUDIT_DEADLINE_MS = 20_000;

export function nextCursorFor(lastScanned: ScannedRecipe | null, hasMore: boolean): string | null {
  if (!hasMore || !lastScanned) return null;
  const cursor: ScanCursor = { v: 1, lastCreatedAt: lastScanned.createdAt, lastId: lastScanned.id, page: lastScanned.page };
  return encodeCursor(cursor);
}

export type DetailFetchResult =
  | { success: true; detail: Record<string, unknown> }
  | { success: false; slug?: string; id?: string; error: string };

/** Fetches one recipe detail, reporting failure as data so one bad recipe never fails a batch. */
export async function fetchRecipeDetail(entry: ScannedRecipe): Promise<DetailFetchResult> {
  const slug = str(entry.summary.slug) || entry.id;
  try {
    const detail = await recipesApi.getRecipe(slug);
    if (!detail || typeof detail !== 'object') {
      return { success: false, slug: slug || undefined, id: entry.id || undefined, error: 'Recipe detail response was empty or invalid' };
    }
    return { success: true, detail };
  } catch (error) {
    return {
      success: false,
      slug: slug || undefined,
      id: entry.id || undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function pullBatch(iterator: AsyncGenerator<ScannedRecipe, void, undefined>, size: number): Promise<ScannedRecipe[]> {
  const batch: ScannedRecipe[] = [];
  for (let i = 0; i < size; i++) {
    const { value, done } = await iterator.next();
    if (done) break;
    batch.push(value);
  }
  return batch;
}

export interface AuditScanOptions<T> {
  startCursor: ScanCursor | null;
  limit: number;
  /** Decides whether an audited recipe belongs in the page; uses audit facts only. */
  matches: (audit: RecipeEnrichmentAudit) => boolean;
  toItem: (detail: Record<string, unknown>, audit: RecipeEnrichmentAudit) => T;
  clock?: ClockOptions;
}

export interface AuditScanResult<T> {
  items: T[];
  failures: AuditFailure[];
  nextCursor: string | null;
  scannedCount: number;
  hasMore: boolean;
  stopReason: ScanStopReason;
}

/**
 * Stable-cursor scan that fetches full detail for every scanned recipe (in bounded concurrent
 * batches), audits it, and collects those the predicate accepts until `limit` matches or the
 * soft deadline. Detail failures are isolated per recipe and reported in `failures`. For queues
 * that can pre-filter from the list summary, scan with scanRecipesStable and fetchRecipeDetail
 * directly instead.
 */
export async function scanAuditedRecipes<T>(options: AuditScanOptions<T>): Promise<AuditScanResult<T>> {
  const now = options.clock?.now ?? Date.now;
  const deadline = now() + (options.clock?.deadlineMs ?? DEFAULT_AUDIT_DEADLINE_MS);

  const iterator = scanRecipesStable(options.startCursor);
  const items: T[] = [];
  const failures: AuditFailure[] = [];
  let scannedCount = 0;
  let lastScanned: ScannedRecipe | null = null;
  let stopReason: ScanStopReason = 'exhausted';

  outer: for (;;) {
    const batch = await pullBatch(iterator, DETAIL_FETCH_BATCH_SIZE);
    if (batch.length === 0) {
      stopReason = 'exhausted';
      break;
    }

    const results = await mapWithConcurrency(batch, DEFAULT_DETAIL_FETCH_CONCURRENCY, async (entry) => ({
      entry,
      result: await fetchRecipeDetail(entry),
    }));

    for (const { entry, result } of results) {
      scannedCount++;
      lastScanned = entry;

      if (!result.success) {
        failures.push({ slug: result.slug, id: result.id, error: result.error });
        continue;
      }

      const audit = auditRecipe(result.detail);
      if (options.matches(audit)) {
        items.push(options.toItem(result.detail, audit));
      }

      if (items.length >= options.limit) {
        stopReason = 'limit';
        break outer;
      }
    }

    if (now() > deadline) {
      stopReason = 'deadline';
      break;
    }
  }

  const hasMore = stopReason !== 'exhausted';
  return { items, failures, nextCursor: nextCursorFor(lastScanned, hasMore), scannedCount, hasMore, stopReason };
}

import * as categoriesApi from '../api/categories.js';
import * as tagsApi from '../api/tags.js';

export type TaxonomyKind = 'category' | 'tag';

export interface TaxonomyItem {
  id: string;
  name: string;
  slug: string;
}

export interface TaxonomyValueResolutionResult {
  resolved: TaxonomyItem[];
  unresolved: string[];
}

export class UnresolvedTaxonomyFilterError extends Error {
  constructor(
    public readonly kind: TaxonomyKind,
    public readonly values: string[],
  ) {
    const label = kind === 'category' ? 'categories' : 'tags';
    super(
      `The following ${label} do not exist: ${values.join(', ')}. ` +
        `Correct the ${label} name(s)/slug(s)/ID(s), or remove ${values.length === 1 ? 'it' : 'them'} from the filter.`,
    );
    this.name = 'UnresolvedTaxonomyFilterError';
  }
}

function toTaxonomyItem(raw: Record<string, unknown>): TaxonomyItem {
  return {
    id: String(raw.id),
    name: String(raw.name),
    slug: String(raw.slug),
  };
}

async function getAllTaxonomyItems(kind: TaxonomyKind): Promise<TaxonomyItem[]> {
  const result =
    kind === 'category' ? await categoriesApi.getCategories({ perPage: -1 }) : await tagsApi.getTags({ perPage: -1 });
  return result.items.map(toTaxonomyItem);
}

/**
 * Resolves human-readable category/tag values (name, slug, or ID, case-insensitive) against
 * Mealie's actual taxonomy. Per value: exact ID match, then exact case-insensitive name match,
 * then exact case-insensitive slug match; anything left over is reported as unresolved rather
 * than guessed at or passed through.
 */
export async function resolveTaxonomyValues(
  kind: TaxonomyKind,
  values: string[],
): Promise<TaxonomyValueResolutionResult> {
  const existing = await getAllTaxonomyItems(kind);
  const byId = new Map<string, TaxonomyItem>();
  const byName = new Map<string, TaxonomyItem>();
  const bySlug = new Map<string, TaxonomyItem>();
  for (const item of existing) {
    byId.set(item.id.toLowerCase(), item);
    byName.set(item.name.toLowerCase(), item);
    bySlug.set(item.slug.toLowerCase(), item);
  }

  const resolvedMap = new Map<string, TaxonomyItem>();
  const unresolved: string[] = [];

  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const match = byId.get(key) ?? byName.get(key) ?? bySlug.get(key);
    if (match) {
      resolvedMap.set(match.id, match);
    } else {
      unresolved.push(raw);
    }
  }

  return { resolved: [...resolvedMap.values()], unresolved };
}

/**
 * Resolves a category/tag filter value list to canonical Mealie IDs for use in Mealie's own
 * list-filtering query params (categories/tags on GET /api/recipes and friends).
 *
 * This exists because Mealie's own category/tag query params only match by exact slug or ID for
 * non-UUID input — a name like "Dinner" that doesn't exactly equal the real slug ("dinner")
 * resolves to zero category IDs server-side, and Mealie's filter-building code then silently
 * *skips* the filter entirely on an empty ID list rather than filtering to zero results (verified
 * against a live instance: categories=["Dinner"] returned the entire library unfiltered, while
 * categories=["dinner"] correctly filtered it). Resolving to IDs here — rather than to slugs —
 * sidesteps that matching path entirely, since Mealie's query parsing treats a valid UUID as an
 * ID directly without ever consulting the slug column.
 *
 * Throws UnresolvedTaxonomyFilterError instead of silently forwarding anything that doesn't
 * resolve, so a typo'd or unknown category/tag fails loudly rather than looking like a
 * successful, silently-unfiltered call.
 */
export async function resolveTaxonomyFilter(
  kind: TaxonomyKind,
  values: string[] | undefined,
): Promise<string[] | undefined> {
  if (!values || values.length === 0) return values;

  const { resolved, unresolved } = await resolveTaxonomyValues(kind, values);
  if (unresolved.length > 0) {
    throw new UnresolvedTaxonomyFilterError(kind, unresolved);
  }

  return resolved.map((item) => item.id);
}

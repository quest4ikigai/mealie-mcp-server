// Neutral resolution/change-calculation helpers shared by category, tag, and Tool assignment on a
// recipe. All organizers are id/name/slug triples resolved by exact ID, then slug, then name
// (case-insensitive) — never fuzzy or semantic matching.

export type OrganizerMode = 'merge' | 'replace';

export interface OrganizerItem {
  id: string;
  name: string;
  slug: string;
}

export interface OrganizerCollectionResult {
  final: OrganizerItem[];
  added: OrganizerItem[];
  removed: OrganizerItem[];
  created: OrganizerItem[];
}

export function toOrganizerItem(raw: Record<string, unknown>): OrganizerItem {
  return {
    id: String(raw.id),
    name: String(raw.name),
    slug: String(raw.slug),
  };
}

export function toOrganizerItems(raw: unknown): OrganizerItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => toOrganizerItem(item as Record<string, unknown>));
}

export function toApiPayloadItem(item: OrganizerItem): Record<string, unknown> {
  return { id: item.id, name: item.name, slug: item.slug };
}

export interface ResolveResult {
  resolved: OrganizerItem[];
  created: OrganizerItem[];
  missing: string[];
}

export async function resolveOrganizerValues(
  values: string[],
  existing: OrganizerItem[],
  createMissing: boolean,
  createFn: (name: string) => Promise<Record<string, unknown>>,
): Promise<ResolveResult> {
  const byId = new Map<string, OrganizerItem>();
  const bySlug = new Map<string, OrganizerItem>();
  const byName = new Map<string, OrganizerItem>();
  for (const item of existing) {
    byId.set(item.id.toLowerCase(), item);
    bySlug.set(item.slug.toLowerCase(), item);
    byName.set(item.name.toLowerCase(), item);
  }

  const resolvedMap = new Map<string, OrganizerItem>();
  const created: OrganizerItem[] = [];
  const missing: string[] = [];
  const createdThisCall = new Map<string, OrganizerItem>();

  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const match = byId.get(key) ?? bySlug.get(key) ?? byName.get(key) ?? createdThisCall.get(key);
    if (match) {
      resolvedMap.set(match.id, match);
      continue;
    }

    if (!createMissing) {
      missing.push(raw);
      continue;
    }

    const createdRaw = await createFn(value);
    const item = toOrganizerItem(createdRaw);
    createdThisCall.set(key, item);
    createdThisCall.set(item.id.toLowerCase(), item);
    createdThisCall.set(item.slug.toLowerCase(), item);
    createdThisCall.set(item.name.toLowerCase(), item);
    resolvedMap.set(item.id, item);
    created.push(item);
  }

  return { resolved: [...resolvedMap.values()], created, missing };
}

export function computeFinal(
  mode: OrganizerMode,
  current: OrganizerItem[],
  requested: OrganizerItem[],
): { final: OrganizerItem[]; added: OrganizerItem[]; removed: OrganizerItem[] } {
  if (mode === 'replace') {
    const finalMap = new Map(requested.map((item) => [item.id, item]));
    const currentIds = new Set(current.map((item) => item.id));
    const final = [...finalMap.values()];
    const added = final.filter((item) => !currentIds.has(item.id));
    const removed = current.filter((item) => !finalMap.has(item.id));
    return { final, added, removed };
  }

  const finalMap = new Map(current.map((item) => [item.id, item]));
  const added: OrganizerItem[] = [];
  for (const item of requested) {
    if (!finalMap.has(item.id)) {
      finalMap.set(item.id, item);
      added.push(item);
    }
  }
  return { final: [...finalMap.values()], added, removed: [] };
}

/**
 * Delta form: current - removals + additions. Callers must have already rejected any overlap
 * between the two sets. `removed` only lists organizers that were actually on the recipe.
 */
export function computeDelta(
  current: OrganizerItem[],
  additions: OrganizerItem[],
  removals: OrganizerItem[],
): { final: OrganizerItem[]; added: OrganizerItem[]; removed: OrganizerItem[] } {
  const removalIds = new Set(removals.map((item) => item.id));
  const removed = current.filter((item) => removalIds.has(item.id));
  const finalMap = new Map(current.filter((item) => !removalIds.has(item.id)).map((item) => [item.id, item]));
  const added: OrganizerItem[] = [];
  for (const item of additions) {
    if (!finalMap.has(item.id)) {
      finalMap.set(item.id, item);
      added.push(item);
    }
  }
  return { final: [...finalMap.values()], added, removed };
}

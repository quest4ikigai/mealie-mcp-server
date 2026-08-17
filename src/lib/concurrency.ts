// Mealie's own timeout tolerance isn't known from this repo alone; 4 concurrent requests sits
// in the middle of the "3-5" range known to avoid gateway timeouts that unbounded fan-out
// (e.g. Promise.all/Promise.allSettled over every slug at once) produces on non-trivial batches.
export const DEFAULT_DETAIL_FETCH_CONCURRENCY = 4;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once, preserving output order.
 * Used instead of `Promise.all`/`Promise.allSettled` for calls that fan out to a slow upstream API,
 * where firing every request simultaneously can overload the server and blow gateway timeouts.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

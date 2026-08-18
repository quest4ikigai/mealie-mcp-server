import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../api/client.js')>('../api/client.js');
  return { ...actual, apiGet: vi.fn() };
});

import { apiGet } from '../api/client.js';
import { getRecipesBatch } from '../api/recipes.js';
import { DEFAULT_DETAIL_FETCH_CONCURRENCY } from '../lib/concurrency.js';

const mockApiGet = vi.mocked(apiGet);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getRecipesBatch', () => {
  it('bounds concurrent detail requests instead of firing them all at once', async () => {
    const slugs = Array.from({ length: 10 }, (_, i) => `recipe-${i}`);
    let inFlight = 0;
    let maxInFlight = 0;

    mockApiGet.mockImplementation(async (path: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      return { slug: path.split('/').pop() };
    });

    const result = await getRecipesBatch(slugs);

    expect(Object.keys(result)).toHaveLength(10);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(DEFAULT_DETAIL_FETCH_CONCURRENCY);
  });

  it('preserves the slug -> result mapping regardless of completion order', async () => {
    const slugs = ['fast', 'slow', 'medium'];
    const delays: Record<string, number> = { fast: 1, slow: 30, medium: 15 };

    mockApiGet.mockImplementation(async (path: string) => {
      const slug = path.split('/').pop()!;
      await new Promise((resolve) => setTimeout(resolve, delays[slug]));
      return { slug, name: `Recipe ${slug}` };
    });

    const result = await getRecipesBatch(slugs);

    expect(result.fast).toEqual({ slug: 'fast', name: 'Recipe fast' });
    expect(result.slow).toEqual({ slug: 'slow', name: 'Recipe slow' });
    expect(result.medium).toEqual({ slug: 'medium', name: 'Recipe medium' });
  });

  it('reports a per-slug error without failing the rest of the batch', async () => {
    const slugs = ['good-1', 'broken', 'good-2'];

    mockApiGet.mockImplementation((path: string) => {
      const slug = path.split('/').pop()!;
      if (slug === 'broken') return Promise.reject(new Error('Mealie API error 404: Not Found'));
      return Promise.resolve({ slug });
    });

    const result = await getRecipesBatch(slugs);

    expect(result['good-1']).toEqual({ slug: 'good-1' });
    expect(result['good-2']).toEqual({ slug: 'good-2' });
    expect(result.broken).toEqual({ error: 'Mealie API error 404: Not Found' });
  });
});

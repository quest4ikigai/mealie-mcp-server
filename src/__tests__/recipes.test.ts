import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('getRecipes', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends multi-value categories/tags as repeated query keys', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response('{"items":[],"total":0,"page":1,"size":0}', { status: 200 }));

    const { getRecipes } = await import('../api/recipes.js');
    await getRecipes({ categories: ['Dinner', 'Dessert'], tags: ['Quick'] });

    const url = mockFetch.mock.calls[0][0] as string;
    const qs = url.split('?')[1];
    expect(qs).toContain('categories=Dinner');
    expect(qs).toContain('categories=Dessert');
    expect(qs).toContain('tags=Quick');
    expect((qs.match(/categories=/g) ?? []).length).toBe(2);
  });

  it('sends a single-value category as one key (no comma-joining)', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response('{"items":[],"total":0,"page":1,"size":0}', { status: 200 }));

    const { getRecipes } = await import('../api/recipes.js');
    await getRecipes({ categories: ['Dinner'] });

    const url = mockFetch.mock.calls[0][0] as string;
    const qs = url.split('?')[1];
    expect(qs).toBe('categories=Dinner');
  });

  it('sends no querystring when called with no params', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response('{"items":[],"total":0,"page":1,"size":0}', { status: 200 }));

    const { getRecipes } = await import('../api/recipes.js');
    await getRecipes();

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain('?');
  });

  it('omits categories/tags entirely when not provided alongside other params', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response('{"items":[],"total":0,"page":1,"size":0}', { status: 200 }));

    const { getRecipes } = await import('../api/recipes.js');
    await getRecipes({ search: 'chicken', page: 2 });

    const url = mockFetch.mock.calls[0][0] as string;
    const qs = url.split('?')[1];
    expect(qs).toBe('search=chicken&page=2');
  });
});

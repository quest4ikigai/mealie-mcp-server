import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../api/client.js')>('../api/client.js');
  return { ...actual, apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() };
});

import { apiGet, apiPost, apiPut, apiDelete, MealieApiError } from '../api/client.js';
import { getTools, getTool, createTool, updateTool, deleteTool, getToolMatches } from '../api/tools.js';

const mockGet = vi.mocked(apiGet);
const mockPost = vi.mocked(apiPost);
const mockPut = vi.mocked(apiPut);
const mockDelete = vi.mocked(apiDelete);

const paginated = <T>(items: T[]) => ({ items, total: items.length, page: 1, size: items.length });

beforeEach(() => vi.clearAllMocks());

describe('tools api', () => {
  it('forwards search/page/perPage to GET /api/organizers/tools', async () => {
    mockGet.mockResolvedValue(paginated([]));
    await getTools({ search: 'whisk', page: 2, perPage: 5 });
    expect(mockGet).toHaveBeenCalledWith('/api/organizers/tools', { search: 'whisk', page: '2', perPage: '5' });
  });

  it('wraps list errors with context', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    await expect(getTools()).rejects.toThrow(/Unable to retrieve tools: boom/);
  });

  it('gets a tool by ID including householdsWithTool', async () => {
    mockGet.mockResolvedValue({ id: 't1', name: 'Whisk', householdsWithTool: ['h1'] });
    const result = await getTool(' t1 ');
    expect(mockGet).toHaveBeenCalledWith('/api/organizers/tools/t1');
    expect(result.householdsWithTool).toEqual(['h1']);
  });

  it('rejects blank IDs and reports 404s clearly', async () => {
    await expect(getTool('  ')).rejects.toThrow('toolId is required.');
    await expect(deleteTool('')).rejects.toThrow('toolId is required.');
    await expect(updateTool('', { name: 'x' })).rejects.toThrow('toolId is required.');
    mockGet.mockRejectedValue(new MealieApiError(404, 'nope'));
    await expect(getTool('missing')).rejects.toThrow(/Tool not found: missing/);
  });

  it('creates a tool with a trimmed name and rejects blank names', async () => {
    mockPost.mockResolvedValue({ id: 't1', name: 'Whisk' });
    await createTool('  Whisk ');
    expect(mockPost).toHaveBeenCalledWith('/api/organizers/tools', { name: 'Whisk' });
    await expect(createTool('  ')).rejects.toThrow('Tool name cannot be empty.');
  });

  it('update GETs then PUTs, preserving householdsWithTool', async () => {
    mockGet.mockResolvedValue({ id: 't1', name: 'Whisk', slug: 'whisk', householdsWithTool: ['h1', 'h2'] });
    mockPut.mockResolvedValue({ id: 't1', name: 'Balloon Whisk' });
    await updateTool('t1', { name: 'Balloon Whisk' });
    expect(mockGet).toHaveBeenCalledWith('/api/organizers/tools/t1');
    expect(mockPut).toHaveBeenCalledWith('/api/organizers/tools/t1', {
      id: 't1',
      name: 'Balloon Whisk',
      householdsWithTool: ['h1', 'h2'],
    });
  });

  it('update rejects a no-op request shape without calling the API', async () => {
    await expect(updateTool('t1', {})).rejects.toThrow('At least one field must be supplied for an update.');
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('update reports 404 with context', async () => {
    mockGet.mockRejectedValue(new MealieApiError(404, 'nope'));
    await expect(updateTool('t1', { name: 'x' })).rejects.toThrow(/Tool not found: t1/);
  });

  it('deletes a tool and surfaces Mealie refusals', async () => {
    mockDelete.mockResolvedValue({});
    await deleteTool('t1');
    expect(mockDelete).toHaveBeenCalledWith('/api/organizers/tools/t1');
    mockDelete.mockRejectedValue(new MealieApiError(400, 'in use'));
    await expect(deleteTool('t1')).rejects.toThrow(/Unable to delete tool t1.*in use/);
  });
});

describe('getToolMatches', () => {
  const WHISK = { id: '1', name: 'Whisk', slug: 'whisk' };
  const BALLOON = { id: '2', name: 'Balloon Whisk', slug: 'balloon-whisk' };
  const SKILLET = { id: '3', name: 'Skillet', slug: 'skillet' };

  it('queries the tools endpoint with a queryFilter over name and slug', async () => {
    mockGet.mockResolvedValue({ items: [WHISK], total: 1, page: 1, size: 1 });
    await getToolMatches(['whisk']);
    const [path, params] = mockGet.mock.calls[0];
    expect(path).toBe('/api/organizers/tools');
    expect(params?.queryFilter).toMatch(/name/);
    expect(params?.queryFilter).toMatch(/slug/);
  });

  it('ranks exact name ahead of substring, matches by slug, and never infers semantically', async () => {
    mockGet.mockResolvedValue({ items: [BALLOON, WHISK, SKILLET], total: 3, page: 1, size: 3 });
    const result = await getToolMatches(['whisk', 'balloon-whisk', 'beater']);
    const [byName, bySlug, semantic] = result.matches;
    expect(byName.items.map((i) => i.name)).toEqual(['Whisk', 'Balloon Whisk']);
    expect(byName.items[0].matchType).toBe('exact');
    expect(bySlug.items[0]).toMatchObject({ name: 'Balloon Whisk', matchedBy: 'slug' });
    expect(semantic.items).toEqual([]);
  });

  it('preserves duplicate input entries and validates blank queries', async () => {
    mockGet.mockResolvedValue({ items: [WHISK], total: 1, page: 1, size: 1 });
    const result = await getToolMatches(['whisk', 'WHISK']);
    expect(result.matches).toHaveLength(2);
    expect(result.uniqueQueryCount).toBe(1);
    await expect(getToolMatches(['  '])).rejects.toThrow(/blank/);
  });

  it('wraps upstream failures with context', async () => {
    mockGet.mockRejectedValue(new Error('down'));
    const result = await getToolMatches(['whisk']).catch((e: Error) => e);
    // A failed chunk is reported per-query or thrown with context; either way the message is clear.
    if (result instanceof Error) expect(result.message).toMatch(/tool matches/);
    else expect(result.matches[0].error).toBeDefined();
  });
});

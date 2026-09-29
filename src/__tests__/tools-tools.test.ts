import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../api/tools.js', () => ({
  getTools: vi.fn(),
  getTool: vi.fn(),
  getToolMatches: vi.fn(),
  createTool: vi.fn(),
  updateTool: vi.fn(),
  deleteTool: vi.fn(),
}));

import * as toolsApi from '../api/tools.js';
import { registerToolTools } from '../tools/tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const handlers = new Map<string, Handler>();
const schemas = new Map<string, Record<string, { safeParse: (v: unknown) => { success: boolean } }>>();

beforeEach(() => {
  vi.clearAllMocks();
  registerToolTools({
    tool: (name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as Handler);
      schemas.set(name, rest[rest.length - 2] as never);
    },
  } as unknown as McpServer);
});

describe('tool organizer tools', () => {
  it('registers the full surface', () => {
    expect([...handlers.keys()].sort()).toEqual(
      ['create_tool', 'delete_tool', 'get_tool', 'get_tool_matches', 'get_tools', 'update_tool'],
    );
  });

  it('forwards arguments to the API layer', async () => {
    vi.mocked(toolsApi.getTools).mockResolvedValue({ items: [], total: 0, page: 1, size: 0 });
    await handlers.get('get_tools')!({ search: 'w', page: 1, perPage: 2 });
    expect(toolsApi.getTools).toHaveBeenCalledWith({ search: 'w', page: 1, perPage: 2 });

    vi.mocked(toolsApi.getTool).mockResolvedValue({ id: 't1' });
    await handlers.get('get_tool')!({ toolId: 't1' });
    expect(toolsApi.getTool).toHaveBeenCalledWith('t1');

    vi.mocked(toolsApi.createTool).mockResolvedValue({ id: 't2' });
    await handlers.get('create_tool')!({ name: 'Wok' });
    expect(toolsApi.createTool).toHaveBeenCalledWith('Wok');

    vi.mocked(toolsApi.updateTool).mockResolvedValue({ id: 't1' });
    await handlers.get('update_tool')!({ toolId: 't1', name: 'X' });
    expect(toolsApi.updateTool).toHaveBeenCalledWith('t1', { name: 'X' });

    vi.mocked(toolsApi.deleteTool).mockResolvedValue({});
    await handlers.get('delete_tool')!({ toolId: 't1' });
    expect(toolsApi.deleteTool).toHaveBeenCalledWith('t1');

    vi.mocked(toolsApi.getToolMatches).mockResolvedValue({ matches: [] } as never);
    await handlers.get('get_tool_matches')!({ queries: ['a'], maxMatchesPerQuery: 3 });
    expect(toolsApi.getToolMatches).toHaveBeenCalledWith(['a'], { maxMatchesPerQuery: 3 });
  });

  it('returns errors as isError responses', async () => {
    vi.mocked(toolsApi.deleteTool).mockRejectedValue(new Error('Unable to delete tool t1: refused'));
    const response = await handlers.get('delete_tool')!({ toolId: 't1' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/refused/);
  });

  it('validates get_tool_matches queries in the schema', () => {
    const { queries } = schemas.get('get_tool_matches')!;
    expect(queries.safeParse([]).success).toBe(false);
    expect(queries.safeParse(['  ']).success).toBe(false);
    expect(queries.safeParse(Array(26).fill('a')).success).toBe(false);
    expect(queries.safeParse(['whisk']).success).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../api/client.js')>('../api/client.js');
  return {
    ...actual,
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPut: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import * as client from '../api/client.js';
import { registerRecipeTools } from '../tools/recipes.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const mockApiPatch = vi.mocked(client.apiPatch);

let handler: ToolHandler;

beforeEach(() => {
  vi.clearAllMocks();
  const handlers = new Map<string, ToolHandler>();
  registerRecipeTools({
    tool: (name: string, ...rest: unknown[]) => {
      handlers.set(name, rest[rest.length - 1] as ToolHandler);
      return {};
    },
  } as unknown as McpServer);
  handler = handlers.get('mark_recipe_last_made')!;
  mockApiPatch.mockResolvedValue({ slug: 'pasta' });
});

describe('mark_recipe_last_made tool', () => {
  it('patches the last-made endpoint with the passed date as noon local time', async () => {
    const response = await handler({ slug: 'pasta', timestamp: '2020-09-29' });

    expect(response.isError).toBeUndefined();
    expect(mockApiPatch).toHaveBeenCalledWith('/api/recipes/pasta/last-made', {
      timestamp: new Date(2020, 8, 29, 12, 0, 0).toISOString(),
    });
  });

  it('sends now when timestamp is omitted', async () => {
    const before = Date.now();
    await handler({ slug: 'pasta' });
    const after = Date.now();

    const payload: unknown = mockApiPatch.mock.calls[0][1];
    const sent = Date.parse(
      String(payload && typeof payload === 'object' && 'timestamp' in payload ? payload.timestamp : ''),
    );
    expect(sent).toBeGreaterThanOrEqual(before);
    expect(sent).toBeLessThanOrEqual(after);
  });

  it.each(['not-a-date', '2999-01-01'])('rejects %j without calling the API', async (timestamp) => {
    const response = await handler({ slug: 'pasta', timestamp });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/timestamp|future/i);
    expect(mockApiPatch).not.toHaveBeenCalled();
  });
});

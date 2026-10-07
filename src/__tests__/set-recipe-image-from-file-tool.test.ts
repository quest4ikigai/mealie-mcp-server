import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../lib/recipe-image.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/recipe-image.js')>('../lib/recipe-image.js');
  return { ...actual, setRecipeImageFromFile: vi.fn() };
});

import { setRecipeImageFromFile } from '../lib/recipe-image.js';
import { registerRecipeTools } from '../tools/recipes.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const mockSetFromFile = vi.mocked(setRecipeImageFromFile);
const file = { download_url: 'https://files.example.com/a', file_id: 'file_1', mime_type: 'image/png' };

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
  handler = handlers.get('set_recipe_image_from_file')!;
});

describe('set_recipe_image_from_file tool', () => {
  it('passes the slug and host file reference through and returns the Mealie result', async () => {
    mockSetFromFile.mockResolvedValue({ image: 'v1' });

    const response = await handler({ slug: 'soup', file });

    expect(mockSetFromFile).toHaveBeenCalledWith('soup', file);
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0].text)).toEqual({ image: 'v1' });
  });

  it('returns download and validation failures as tool errors', async () => {
    mockSetFromFile.mockRejectedValue(
      new Error('download_url points to a private or non-public address and was refused.'),
    );

    const response = await handler({ slug: 'soup', file });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('download_url points to a private or non-public address');
  });
});

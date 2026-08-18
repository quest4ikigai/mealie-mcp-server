import { describe, it, expect, vi } from 'vitest';
import { registerRecipeTools } from '../tools/recipes.js';

const EXISTING_RECIPE_TOOLS = [
  'get_recipes',
  'get_recipe_detailed',
  'get_recipe_concise',
  'get_recipes_batch',
  'get_recipes_detailed_batch',
  'create_recipe',
  'patch_recipe',
  'duplicate_recipe',
  'mark_recipe_last_made',
  'set_recipe_image_from_url',
  'delete_recipe',
];

describe('registerRecipeTools backward compatibility', () => {
  it('still registers every pre-existing recipe tool alongside the new classification tool', () => {
    const registeredNames: string[] = [];
    const stubServer = {
      tool: vi.fn((name: string) => {
        registeredNames.push(name);
        return undefined;
      }),
      registerTool: vi.fn((name: string) => {
        registeredNames.push(name);
        return undefined;
      }),
    };

    registerRecipeTools(stubServer as never);

    for (const name of EXISTING_RECIPE_TOOLS) {
      expect(registeredNames).toContain(name);
    }
    expect(registeredNames).toContain('get_recipes_for_classification');
  });

  it('registers get_recipes_for_classification as read-only, non-destructive, with an output schema', () => {
    interface RegisterToolConfig {
      annotations?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }
    const registerTool = vi.fn<(name: string, config: RegisterToolConfig, cb: unknown) => undefined>();
    const stubServer = { tool: vi.fn(), registerTool };

    registerRecipeTools(stubServer as never);

    const call = registerTool.mock.calls.find(([name]) => name === 'get_recipes_for_classification');
    expect(call).toBeDefined();
    const [, config] = call!;

    expect(config.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(config.outputSchema).toBeDefined();
    expect(Object.keys(config.outputSchema!)).toEqual(
      expect.arrayContaining(['items', 'failures', 'nextCursor', 'scannedCount', 'returnedCount', 'hasMore']),
    );
  });
});

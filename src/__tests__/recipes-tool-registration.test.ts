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
    };

    registerRecipeTools(stubServer as never);

    for (const name of EXISTING_RECIPE_TOOLS) {
      expect(registeredNames).toContain(name);
    }
    expect(registeredNames).toContain('get_recipes_for_classification');
  });
});

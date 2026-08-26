import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as tagsApi from '../api/tags.js';

export function registerTagTools(server: McpServer) {
  // @endpoints GET /api/organizers/tags
  server.tool(
    'get_tags',
    'Lists and searches the household\'s recipe tags with pagination.',
    { page: z.number().optional(), perPage: z.number().optional() },
    async (params) => {
      try {
        const result = await tagsApi.getTags(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints GET /api/organizers/tags/empty
  server.tool(
    'get_empty_tags',
    'Returns tags that have no recipes assigned.',
    {},
    async () => {
      try {
        const result = await tagsApi.getEmptyTags();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints POST /api/organizers/tags
  server.tool(
    'create_tag',
    'Creates a new recipe tag.',
    { name: z.string() },
    async (params) => {
      try {
        const result = await tagsApi.createTag(params.name);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints GET /api/organizers/tags/{id}
  server.tool(
    'get_tag',
    'Retrieves a single tag by its UUID.',
    { tagId: z.string() },
    async (params) => {
      try {
        const result = await tagsApi.getTag(params.tagId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints GET /api/organizers/tags/slug/{slug}
  server.tool(
    'get_tag_by_slug',
    'Retrieves a single tag by its URL slug.',
    { tagSlug: z.string() },
    async (params) => {
      try {
        const result = await tagsApi.getTagBySlug(params.tagSlug);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints PUT /api/organizers/tags/{id}
  server.tool(
    'update_tag',
    'Updates a tag\'s name.',
    { tagId: z.string(), name: z.string().optional() },
    async (params) => {
      try {
        const data: Record<string, unknown> = {};
        if (params.name !== undefined) data.name = params.name;
        const result = await tagsApi.updateTag(params.tagId, data);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  // @endpoints DELETE /api/organizers/tags/{id}
  server.tool(
    'delete_tag',
    'Deletes a tag. Mealie may refuse if recipes still reference it.',
    { tagId: z.string() },
    async (params) => {
      try {
        const result = await tagsApi.deleteTag(params.tagId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );
}

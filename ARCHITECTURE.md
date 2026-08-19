# Architecture

Internal design notes for anyone extending or maintaining this server — why things are shaped the way they are, and a record of Mealie API behavior that was investigated so it doesn't need re-discovering. This is not required reading to *use* the tools; see [Workflows](./WORKFLOWS.md) for that, and [API Coverage](./API_COVERAGE.md) for the endpoint mapping.

## Bounded Concurrency

Firing every request in a batch at once (`Promise.all`/`Promise.allSettled` over a full slug list) reliably produces HTTP 504s through the MCP transport on non-trivial batch sizes — observed even at 8-9 concurrent full-detail requests, regardless of how many were ultimately requested. `mapWithConcurrency` (`src/lib/concurrency.ts`) caps in-flight requests to `DEFAULT_DETAIL_FETCH_CONCURRENCY` (4) instead, which sits in the middle of the "3-5 concurrent" range known to avoid this without materially slowing down a batch. Every tool that fans out to multiple recipe detail fetches — `get_recipes_batch`, `get_recipes_detailed_batch`, `get_recipes_for_classification`, `update_recipe_taxonomy_batch` — goes through this same helper rather than reimplementing its own concurrency limit.

## Pagination & Cursor Design

`get_recipes_for_classification` needs pagination that survives a job that's actively changing the thing it's filtering on: as recipes get classified mid-job, they drop out of "missing taxonomy," which would shift every later page backward under naive page-number pagination and cause recipes to be silently skipped. This was hit empirically before being fixed, not designed in the abstract.

Mealie's `/api/recipes` list endpoint only supports `page`/`perPage`, not a native "after" cursor. This tool builds a stable cursor on top of that by:

1. Scanning the full recipe collection ordered by `createdAt` (never `updatedAt`, since applying a taxonomy change updates that field) with the recipe id as a deterministic tie-breaker.
2. Encoding the cursor as the last-scanned recipe's `(createdAt, id, page)`, base64url-encoded JSON — opaque to callers, versioned (`v: 1`) so a malformed or foreign cursor fails clearly instead of silently misbehaving.
3. Resuming by re-fetching the cursor's last known page and skipping everything at or before the cursor position, rather than trusting page-number arithmetic — so if a recipe was inserted or removed from an already-scanned page between calls, resumption still lands in the right place.

This gives two guarantees:
- A recipe gaining or losing categories/tags between calls never causes another recipe to be skipped or duplicated, because pagination position is tracked independently of the taxonomy filter.
- New recipes created while paginating are always sorted after everything already scanned, so they never shift previously-issued cursors.

**Known limitation**: this assumes Mealie's `/api/recipes` list endpoint accepts `orderBy=createdAt` and returns each recipe's `recipeCategory`/`tags` in the list response (not just in the detail response), consistent with the `recipeCategory`/`tags`/`orderBy` field names used elsewhere in this codebase. If a Mealie version does not honor `orderBy=createdAt` for this endpoint, the tool degrades to whatever stable order Mealie falls back to — traversal stays correct (no skips/duplicates, since resumption re-derives its position from the cursor's `createdAt`/`id` rather than trusting page arithmetic), but "oldest first" is no longer guaranteed. If a Mealie version omits `recipeCategory`/`tags` from the list response, filtering would need to move to the detail response instead — check the `MEALIE_MCP_DEBUG` scan-phase timing (see README's Development section) if classification pages come back empty or unexpectedly small against a real instance.

A recipe that matches the filter but fails its detail fetch (see `failures` in the response) is not retried automatically by continuing pagination — retry it directly (e.g. with `get_recipe_detailed`) once the failure is addressed.

## Known Mealie API Quirks

Behavior confirmed by live testing against a real Mealie instance, traced to root cause in Mealie's own source, and worth knowing before changing anything that touches recipe writes.

### `recipeInstructions[].id` is regenerated on every recipe update

Confirmed on Mealie `v3.23.1` and `mealie-next`, via two live experiments: omitting `recipeInstructions` from an `update_recipe_ingredients` request, and explicitly echoing it back with its exact current IDs — both regenerated the IDs anyway.

Root cause: both `PUT /api/recipes/{slug}` and `PATCH /api/recipes/{slug}` ultimately call the same repository `update()`, which re-invokes the SQLAlchemy model's constructor (`self.__init__(*args, **kwargs)`) on the already-persisted recipe. `recipe_instructions` is declared with `cascade="all, delete-orphan"`, so every instruction row is deleted and recreated with a fresh ID as a side effect of that re-construction — regardless of what the request body contained. This happens from any client, including Mealie's own web UI, on any recipe save; it is not something this MCP server causes or can work around.

Instruction *content* (text, title, summary, `ingredientReferences`) is preserved correctly — only the IDs churn. Any feature that needs a stable identity for linking instructions to ingredients across writes should use the ingredient's own `referenceId` (which Mealie does not regenerate), never the instruction's `id`.

### `display` is not a persisted field on `RecipeIngredient`

Confirmed directly against the `RecipeIngredientModel` ORM definition — there is no `display` database column. Mealie's `format_display` validator only recomputes the field when it's empty, but since nothing ever persists a supplied value, it reads back empty (and gets recomputed) on every subsequent load, including the response to the very same write that supplied it. Kept as an accepted/forwarded field for forward compatibility in case a future Mealie version starts persisting it, but never treat a round-tripped `display` value as authoritative.

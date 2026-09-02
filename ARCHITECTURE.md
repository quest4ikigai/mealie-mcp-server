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

**Known limitation**: this assumes Mealie's `/api/recipes` list endpoint accepts `orderBy=createdAt` and returns each recipe's `recipeCategory`/`tags` in the list response (not just in the detail response), consistent with the `recipeCategory`/`tags`/`orderBy` field names used elsewhere in this codebase. If a Mealie version does not honor `orderBy=createdAt` for this endpoint, the tool degrades to whatever stable order Mealie falls back to — traversal stays correct (no skips/duplicates, since resumption re-derives its position from the cursor's `createdAt`/`id` rather than trusting page arithmetic), but "oldest first" is no longer guaranteed. If a Mealie version omits `recipeCategory`/`tags` from the list response, filtering would need to move to the detail response instead — check the `MEALIE_MCP_DEBUG` scan-phase timing (see [Debugging](#debugging) below) if classification pages come back empty or unexpectedly small against a real instance.

A recipe that matches the filter but fails its detail fetch (see `failures` in the response) is not retried automatically by continuing pagination — retry it directly (e.g. with `get_recipe_detailed`) once the failure is addressed.

## Debugging

Set `MEALIE_MCP_DEBUG=true` in the server's environment to log per-call phase timings (scan/list, detail fetch, transform) for `get_recipes_for_classification` and `get_recipes_for_ingredient_parsing` to stderr — useful for telling whether a slow call is spending its time listing recipes, fetching detail, or building the response. Diagnostics always go to stderr, never stdout, since stdout carries the MCP JSON-RPC transport.

## Known Mealie API Quirks

Behavior confirmed by live testing against a real Mealie instance, traced to root cause in Mealie's own source, and worth knowing before changing anything that touches recipe writes.

### `recipeInstructions[].id` is regenerated on every recipe update

Confirmed on Mealie `v3.23.1` and `mealie-next`, via two live experiments: omitting `recipeInstructions` from an `update_recipe_ingredients` request, and explicitly echoing it back with its exact current IDs — both regenerated the IDs anyway.

Root cause: both `PUT /api/recipes/{slug}` and `PATCH /api/recipes/{slug}` ultimately call the same repository `update()`, which re-invokes the SQLAlchemy model's constructor (`self.__init__(*args, **kwargs)`) on the already-persisted recipe. `recipe_instructions` is declared with `cascade="all, delete-orphan"`, so every instruction row is deleted and recreated with a fresh ID as a side effect of that re-construction — regardless of what the request body contained. This happens from any client, including Mealie's own web UI, on any recipe save; it is not something this MCP server causes or can work around.

Instruction *content* (text, title, summary, `ingredientReferences`) is preserved correctly — only the IDs churn. Any feature that needs a stable identity for linking instructions to ingredients across writes should use the ingredient's own `referenceId` (which Mealie does not regenerate), never the instruction's `id`.

### `display` is not a persisted field on `RecipeIngredient`

Confirmed directly against the `RecipeIngredientModel` ORM definition — there is no `display` database column. Mealie's `format_display` validator only recomputes the field when it's empty, but since nothing ever persists a supplied value, it reads back empty (and gets recomputed) on every subsequent load, including the response to the very same write that supplied it. Kept as an accepted/forwarded field for forward compatibility in case a future Mealie version starts persisting it, but never treat a round-tripped `display` value as authoritative.

### A `foodId`/`unitId` can be accepted and still silently corrupt the association

Confirmed by live testing against a real Mealie instance via `update_recipe_ingredients`: a syntactically valid UUID that does not correspond to any existing food was accepted by the write with no error, and the persisted ingredient came back with `food: null` — a previously structured ingredient silently became unparsed, while unrelated fields (`note`, `originalText`) were preserved. Separately, a valid food UUID paired with a mismatched `foodName` (an existing tomato's ID given the name `"cilantro"`) was also accepted silently, and the persisted ingredient's `food.name` came back as the UUID's actual name (`"tomato"`) — the ID won, and the supplied name was discarded with no indication anything was wrong. Both cases previously left `update_recipe_ingredients` and `update_recipe_ingredients_batch` reporting a plain success. See [Post-Write Ingredient Verification](#post-write-ingredient-verification) below for how this MCP now guards against it.

## Post-Write Ingredient Verification

`update_recipe_ingredients`/`update_recipe_ingredients_batch` don't pre-validate every `foodId`/`unitId` against Mealie before writing — that would add a GET per referenced food/unit to every call, which defeats the point of writing structured ingredients in bulk (and would need its own caching/deduplication to stay reasonable). Instead, both tools verify the *response* Mealie already returns from the write, since that response already contains the persisted `recipeIngredient` collection.

The write path is: fetch the recipe (`GET`, also captured as the rollback snapshot) → write the requested `recipeIngredient` collection (`PATCH`) → verify the returned collection. Verification is deterministic and intentionally narrow — it is not a general recipe diff:

- **Count.** The persisted ingredient count must equal the requested count.
- **Food.** For any ingredient that supplied a `foodId` (and thus, per the existing pairing rule, a `foodName`), the persisted ingredient's `food` must be non-null, its `id` must equal the requested `foodId`, and its name must be compatible with the requested `foodName` — case-insensitive equality against the persisted food's `name` or `pluralName` (its stored `aliases`, already present on the returned entity at no extra request cost, count too). An ingredient with no `foodId` requires no food association, preserving section headings and other legitimately food-less rows.
- **Unit.** Same shape, for `unitId`/`unitName` — compatible names are the persisted unit's `name`, `pluralName`, `abbreviation`, `pluralAbbreviation`, or stored `aliases`. An ingredient with no `unitId` requires no unit, preserving legitimate unitless countables (`4 eggs`, `2 lemons`).
- **Pairing.** Requested and persisted ingredients are matched positionally (`requested[i]` ↔ `persisted[i]`) — this writer always sends the array as a complete ordered replacement, and nothing in observed Mealie behavior suggests it reorders `recipeIngredient` rows on write.

Fields Mealie is known to normalize on its own — `display`, empty-string/`null` handling, formatting — are deliberately not compared.

If verification fails, the MCP makes a best-effort attempt to `PATCH` the recipe back to the `recipeIngredient` collection captured by the initial fetch, then reports the write as failed either way — a corrupted structured association is never reported as a success, even though the underlying Mealie write technically went through. If that rollback attempt itself fails, the error says so explicitly (`rollbackSucceeded: false`, plus the rollback attempt's own error) instead of silently leaving the recipe half-written. `update_recipe_ingredients_batch` reuses this exact same per-recipe write path; a verification failure and its rollback are scoped to that one recipe and never affect siblings in the same batch call.

One field is deliberately *not* taken verbatim from that initial-fetch snapshot: each ingredient's `referenceId`. The rollback payload uses the *requested* ingredient's own `referenceId` at each position when one was supplied, falling back to the fetched snapshot's value only when it wasn't. This is necessary because of a Mealie quirk described next — blindly resending the snapshot's `referenceId` can silently swap in a value the caller never saw.

### `reference_id` can differ between two reads of the same never-pinned ingredient

`recipe_ingredient.reference_id` is a nullable database column with no stored default, and Mealie's `RecipeIngredient` schema (`reference_id: UUID = Field(default_factory=uuid4)` plus a `field_validator(mode="before")` that returns `value or uuid4()` — added in [mealie-recipes/mealie PR #7139](https://github.com/mealie-recipes/mealie/pull/7139), fixing [issue #7072](https://github.com/mealie-recipes/mealie/issues/7072)) synthesizes a fresh random UUID for that field on *every read* of a row whose stored value is still `NULL` — it is never written back to the database just by being read. Two independent reads of the same untouched ingredient can therefore legitimately return two different `referenceId` values, and only a write that explicitly supplies a non-empty value durably pins it going forward.

This matters for rollback specifically: this writer's own pre-write `GET` (the rollback snapshot) is a separate read from whatever the caller's own earlier `get_recipe_detailed` call saw when it built its request. For an ingredient whose `reference_id` was never durably pinned, the snapshot's synthesized value and the caller's requested value can disagree — and the write that's about to be rolled back already carried the caller's requested value through to Mealie and durably persisted it for every ingredient row (row persistence itself never fails; only the food/unit association can be silently dropped or misresolved). Restoring from the snapshot verbatim would discard that already-persisted, caller-intended value in favor of an unrelated, arbitrary one — which is exactly why rollback prefers the requested `referenceId` over the snapshot's, as described above. When an ingredient's `reference_id` is already durably non-null, both sources agree and this makes no difference.

**Residual limitation:** for an ingredient whose requested payload also omits `referenceId` (e.g. a genuinely new row with no known prior identity), rollback still falls back to the pre-write snapshot's value, which itself may be a synthesized, non-durable artifact if that row's `reference_id` was never pinned. There is no signal in Mealie's API distinguishing a durably-stored `referenceId` from a freshly-synthesized display value for a null column, so this narrow case cannot be fully resolved client-side.

**Request cost.** A successful write costs 1 `GET` + 1 `PATCH`, same as if the rollback snapshot were unconditionally fetched — no per-ingredient food/unit lookup is ever made. A verification failure adds exactly one more `PATCH` (the rollback attempt). No vocabulary lookups are performed at any point by this code path.

**Known limitations, not addressed here:**

- **Stale-snapshot rollback.** If another actor edits the same recipe between the initial `GET` and this write, a rollback restores the snapshot this call read, not necessarily the latest state. This is an existing limitation of this writer's read-modify-write shape, not something introduced or fixed here — no optimistic concurrency/versioning is implemented.
- **Instruction ID churn.** A rollback is itself a recipe `PATCH`, so it triggers the same `recipeInstructions[].id` regeneration described above — a failed write followed by a rollback can churn instruction IDs twice in one call. Instruction content still survives correctly either time.
- **`referenceId` for a never-pinned, newly-added ingredient with no requested value.** See [`reference_id` can differ between two reads of the same never-pinned ingredient](#reference_id-can-differ-between-two-reads-of-the-same-never-pinned-ingredient) above — this one narrow case has no fully client-side fix.

## Why Ingredient Parsing Can't Pre-Filter Cheaply

`get_recipes_for_classification` can filter cheaply because the list endpoint's response already embeds `recipeCategory`/`tags` for every recipe. Mealie's `/api/recipes` list response does **not** include `recipeIngredient` at all — this codebase's own `get_recipe_concise` tool has to call the full `getRecipe(slug)` and trim client-side for the same reason, since there is no server-side field-selection/projection param. That means `get_recipes_for_ingredient_parsing` genuinely needs a detail fetch for every scanned recipe, not just matches — fetched in small batches (`DETAIL_FETCH_BATCH_SIZE`, `src/lib/recipe-ingredient-parsing.ts`) with the same bounded concurrency as everything else, rather than loading the whole collection into memory or firing every request at once.

Before accepting that, two alternatives were investigated directly against a live Mealie instance's real REST API (not this server's own tools) rather than assumed away:

**Mealie's `queryFilter` query-language param can reach into `recipeIngredient` fields — but its pagination is broken for a to-many relation like this one, so it's unsafe to use.** `GET /api/recipes?queryFilter=recipeIngredient.foodId IS NULL` is accepted and returns matches, which looked like it could replace the whole per-recipe detail-fetch design. Testing it against Mealie `v3.20.1`, though:

- Requesting `perPage=50` on that filter returned as few as 4 items on some pages, regardless of how many actually matched.
- Walking `page=1` then `page=2` at `perPage=100` returned **the same recipe on both pages**.
- The `total`/`total_pages` response fields were internally inconsistent across different `perPage` values for the identical filter (1580 at `perPage=50`, 378 at `perPage=5000`, `total_pages: 1` at both).

This is consistent with `LIMIT`/`OFFSET` being applied to the raw joined `recipe_ingredient` rows before `DISTINCT` on the parent recipe — a recipe with many unparsed ingredient rows can straddle a page boundary and get split or duplicated across pages. That's a direct violation of the no-skip/no-duplicate pagination guarantee this tool (and `get_recipes_for_classification`) depends on, so `queryFilter` is not used for traversal here. It may be worth reporting upstream to Mealie; this repository has not done so.

**The household/group export/backup endpoints were considered and not pursued.** They can dump the full recipe collection (including ingredients) in fewer round trips in principle, but likely need admin-level export permissions this server's API key may not have, produce a point-in-time snapshot rather than fitting this tool's live paginated/cursor model, and their actual payload efficiency at scale (images/assets likely bundled in) was not verified. Revisit only with evidence it's actually cheaper for this use case, not on the assumption that it is.

Given that every scanned recipe costs a detail fetch, a sparse queue (few recipes actually needing parsing) can require scanning many recipes to fill one page — a live 25-recipe pilot needed 71 scans (a ~2.8:1 scan-to-return ratio) for `unparsed_only`, and an earlier, smaller pilot saw 30 scans for 5 matches (6:1). That ratio only gets worse as more of a library becomes structured. `DEFAULT_DEADLINE_MS` (`src/lib/recipe-ingredient-parsing.ts`, currently 20s, matching `get_recipes_for_classification`'s own budget) bounds how long a single call will keep scanning before returning whatever it's found so far with `hasMore: true` — the same soft-deadline pattern classification already uses, for the same reason (avoid an MCP gateway timeout on a call that would otherwise keep scanning indefinitely). `returnedCount` coming in under the requested `limit` while `hasMore` is `true` is this budget doing its job, not a bug.

### The `partial` parsing-state heuristic's tradeoff, quantified

The `"food present, unit absent, quantity positive"` heuristic behind `partial` (see [Workflows](./WORKFLOWS.md#what-each-ingredients-parsingstate-means-and-what-it-doesnt)) was checked against real recipes rather than assumed reasonable. A single ordinary, fully-structured recipe fetched during investigation (`lemon-chess-pie`) had 3 of its 9 ingredients — `"1 pie crust"`, `"4 eggs"`, `"4 lemons"` — as legitimately unit-less counts that this heuristic cannot distinguish from incomplete structuring, since there is no schema field recording "unit intentionally omitted". That's roughly a third of one recipe's ingredients, not a rare edge case; `partially_parsed` is documented as a coarse audit signal for exactly this reason, not a confirmed-defect filter.

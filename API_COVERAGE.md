# API Coverage

| Category | Tools |
|---|---|
| Recipes | 23 |
| Meal Plans | 6 |
| Categories | 7 |
| Tags | 7 |
| Shopping Lists | 13 |
| Foods | 6 |
| Units | 6 |
| Tools | 6 |
| **Total** | **74** |

## Recipes Operations (23)

- `create_recipe` — POST /api/recipes, PUT /api/recipes/{slug}
  Creates a new recipe. Optionally sets ingredients and instructions on creation.
  Params: `name`, `ingredients`, `instructions`

- `delete_recipe` — DELETE /api/recipes/{slug}
  Permanently deletes a recipe.
  Params: `slug`

- `duplicate_recipe` — POST /api/recipes/{slug}/duplicate
  Creates a duplicate of an existing recipe with an optional new name.
  Params: `slug`, `name`

- `find_recipes_for_ingredients` — GET /api/foods, GET /api/recipes/suggestions, GET /api/recipes
  Finds recipes that contain one or more requested ingredients. Ingredient names are resolved against Mealie's food taxonomy internally — never pass Mealie food UUIDs, just human-readable names like "branzino" or "chicken thighs". Use this for exact or approximate ingredient-based recipe discovery, e.g. deciding what to cook with an ingredient on hand. If an ingredient has no useful matches (see resolvedIngredients/unresolvedIngredients/matchSource in the response), the MCP will not guess a substitute on your behalf — retry this same tool with broader or substitutable ingredient terms you choose (e.g. "branzino" with no matches -> retry with "sea bass", "whole fish", or "snapper"), then use get_recipe_detailed or get_recipes_batch to inspect the most promising candidates.
  Params: `ingredients`, `categories`, `tags`, `requireAllIngredients`, `requireAllCategories`, `requireAllTags`, `limit`

- `get_recipe_concise` — GET /api/recipes/{slug}
  Retrieves a recipe by slug, filtered to summary fields (name, slug, servings, yield, total time, rating, ingredients, last made).
  Params: `slug`

- `get_recipe_detailed` — GET /api/recipes/{slug}
  Retrieves a recipe by slug with full details including nutrition, settings, and assets.
  Params: `slug`

- `get_recipes` — GET /api/recipes
  Searches and lists recipes with pagination. Categories and tags are resolved by name/slug/ID against Mealie's organizer endpoints before the request, since Mealie's query params only match by exact slug/ID.
  Params: `search`, `page`, `perPage`, `categories`, `tags`, `requireAllTags`, `requireAllCategories`

- `get_recipes_batch` — GET /api/recipes/{slug}
  Fetches multiple recipes by slug with bounded concurrency (4 in-flight requests at a time).
  Params: `slugs`

- `get_recipes_detailed_batch` — GET /api/recipes/{slug}
  Fetches multiple recipes by slug with full details (including nutrition) and bounded concurrency.
  Params: `slugs`

- `get_recipes_for_classification` — GET /api/recipes, GET /api/recipes/{slug}
  Compact, paginated, READ-ONLY feed of recipes for assigning Categories and Tags. Returns only the fields useful for classification (name, description, times, servings, source URL, ingredients, instructions) plus each recipe's EXISTING categories and tags — include and preserve those when classifying; do not drop or overwrite them. By default only recipes missing at least one taxonomy collection are returned (taxonomyState "missing_either"); use "missing_both", "missing_categories", "missing_tags", or "any" to change that. Pass the response's nextCursor back unchanged as the next call's cursor to continue; stop once hasMore is false. Pagination is stable against concurrent taxonomy edits — a recipe that gains categories/tags between calls will not cause other recipes to be skipped. A failure reading one recipe is reported in failures and does not fail the rest of the page. This tool never creates or modifies anything — it does not assign taxonomy, create categories/tags, or change any recipe. To apply classifications, call update_recipe_taxonomy_batch separately (preferably in batches of about five recipes), normally with mode "merge" and createMissing: false unless the user explicitly asks to replace collections or auto-create new categories/tags.
  Params: `cursor`, `limit`, `taxonomyState`

- `get_recipes_for_ingredient_parsing` — GET /api/recipes, GET /api/recipes/{slug}
  Compact, paginated, READ-ONLY work queue of recipes whose ingredients may need structured parsing. This tool identifies candidate recipes using only their EXISTING stored schema state — it never parses or interprets ingredient language itself: it does not call Mealie's NLP ingredient parser, does not guess a food/unit association, and never modifies any recipe, food, unit, alias, or ingredient. It returns each ingredient's current stored state (quantity, unit id/name, food id/name, note, display, originalText, title, referenceId) plus recipe instructions (title, text, ingredientReferences) as context — turning that into structured data (e.g. "2 tablespoons chopped fresh parsley leaves" -> quantity 2, unit tablespoon, food parsley, note "chopped fresh") is entirely the calling model's job. Instructions are included because they can disambiguate an otherwise-ambiguous ingredient line or reveal how a compound quantity is actually used (e.g. whether "3 cups + 2 tbsp flour" is one combined amount or two separate uses) — this tool does not decide that, it only supplies the text. Each ingredient includes a deterministic, schema-only "parsingState": "section" (a Mealie ingredient-section heading, identified by a non-empty title — never counted as needing parsing), "unparsed" (no food is associated — the primary, high-confidence signal), "partial" (a food is associated but no unit, while quantity is a positive number — NOTE: this also matches legitimately unit-less countable foods like "4 eggs" or "2 lemons", since Mealie's schema has no field distinguishing that from an incompletely-structured row; treat "partial" as a coarse audit signal, not a confirmed defect), or "structured" (fully resolved, or has no meaningful quantity to need a unit). Each recipe also includes an ingredientParsingState summary (unparsedCount/partialCount/structuredCount/sectionCount/totalCount). Use "state" to choose the queue: "unparsed_only" (default) — recipes with at least one unparsed ingredient; "partially_parsed" — recipes with at least one partial ingredient; "any" — every scanned recipe, for auditing. Every scanned recipe needs a full detail fetch (Mealie's recipe list endpoint does not expose ingredients), fetched with bounded concurrency in small batches — a failure reading one recipe is reported in failures and does not fail the rest of the page. Because of that per-recipe fetch cost, a sparse queue may need to scan far more recipes than it returns to fill a page; returnedCount can come in below the requested limit even when hasMore is true, if an internal time budget is reached first — this is expected, not an error, and the response is still safe to use as-is. Pass the response's nextCursor back unchanged as the next call's cursor to continue; stop once hasMore is false. Pagination is stable against concurrent recipe edits, the same way get_recipes_for_classification is. When you later write changes: use get_food_matches and get_unit_matches to find existing canonical food/unit candidates for the concepts you interpreted (this tool never looks them up or creates them itself), then call update_recipe_ingredients with the complete, corrected ingredient collection for that recipe. Existing referenceIds are stable identifiers for ingredient rows and may be referenced by recipe instructions — preserve them when an existing ingredient row continues to represent the same ingredient. Recipe instruction ids returned here are NOT stable — Mealie recreates recipeInstructions (and assigns fresh ids) on every recipe update, including update_recipe_ingredients — do not depend on an instruction id read here still being valid after a write.
  Params: `cursor`, `limit`, `state`

- `mark_recipe_last_made` — PATCH /api/recipes/{slug}/last-made
  Records the current timestamp as the recipe's last-made date.
  Params: `slug`

- `patch_recipe` — GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  Partially updates a recipe. Also accepts optional categories/tags/taxonomyMode/createMissing for taxonomy assignment. Unchanged Category/Tag collections are never written; if taxonomy is the only thing requested and nothing changes, no PATCH is issued and the current recipe is returned with taxonomyChanges.
  Params: `slug`, `name`, `description`, `recipeYield`, `totalTime`, `categories`, `tags`, `taxonomyMode`, `createMissing`

- `set_recipe_image` — PUT /api/recipes/{slug}/image, DELETE /api/recipes/{slug}/image
  Sets, replaces, or deletes a recipe's image. Pass `imageBase64` as base64-encoded PNG, JPEG, WebP, or GIF data (max 10 MB; a data: URI prefix is accepted) to upload or replace the image, or pass `null` to delete the existing image. Input is validated before anything is sent to Mealie, and no other recipe fields are touched. `extension` is optional; the format is detected from the data, and a mismatching extension is rejected. To set an image from a URL instead, use `set_recipe_image_from_url`.
  Params: `slug`, `imageBase64`, `extension`

- `set_recipe_image_from_url` — POST /api/recipes/{slug}/image
  Sets a recipe's image from a URL.
  Params: `slug`, `imageUrl`

- `update_recipe_ingredients` — GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  Replaces the complete structured ingredient collection (recipeIngredient) of an existing recipe, leaving every other recipe field untouched (name, description, categories, tags, settings, nutrition, etc.). Known Mealie limitation, not caused by this tool: every recipe instruction's ID is regenerated on any recipe update (PATCH or PUT), including this one — instruction text/title/summary/ingredient-references are preserved correctly, only the IDs change. Low-level write primitive: it does not parse ingredient text and does not look up or create foods/units — foodId/unitId must already reference existing Mealie entities, resolved first with get_food_matches/get_unit_matches (batch, alias-aware lookup for several already-interpreted concepts at once — the normal path after parsing ingredient text) or get_foods/get_food/get_units/get_unit for a single manual lookup. The ingredients array is the recipe's complete new ingredient list, not a patch: any ingredient not included is removed, and an empty array clears all ingredients. Call get_recipe_detailed first to see the recipe's current ingredients, referenceIds, and other fields before replacing them. Note: each ingredient's "display" field is never actually persisted by Mealie — it is always recomputed from quantity/unit/food/note, regardless of what is supplied here. Integrity check: after writing, the recipe Mealie returns is verified — for every ingredient that supplied a foodId/unitId, the persisted food/unit must still be non-null, match the given id, and match the given name (case-insensitive against name/pluralName, plus abbreviation/pluralAbbreviation for units). If verification fails (e.g. a nonexistent or mismatched foodId/unitId that Mealie silently dropped or resolved to the wrong entity), the recipe is restored to its pre-write state on a best-effort basis and this call reports failure — never a silent partial write. Verification adds no extra request on success; a failed write adds one rollback request. Alternatively, use the delta form (addIngredients/updateIngredients/removeIngredientReferenceIds, instead of ingredients) to edit rows incrementally by stable referenceId: retained rows keep their order, updates edit in place, additions are appended or anchored with insertAfterReferenceId/insertBeforeReferenceId, and ingredient sections are just rows with a "title". The delta is applied to the recipe's current ingredients, the complete final collection is built, and the same verified write and rollback is used. Duplicate, unknown, or conflicting operations are rejected before any write. Note Mealie generates a fresh referenceId on every read for rows that never had one stored, so such a row may not be addressable by an id from an earlier read — use the complete-replacement form for it.
  Params: `slug`, `ingredients`, `addIngredients`, `updateIngredients`, `removeIngredientReferenceIds`

- `update_recipe_ingredients_batch` — GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  Runs update_recipe_ingredients for multiple recipes with bounded concurrency (5 at a time). Use this once several recipes already have COMPLETE, resolved ingredient collections ready to persist — e.g. after batch-resolving food/unit concepts with get_food_matches/get_unit_matches across many recipes — to avoid one individual write call per recipe. Same low-level write semantics as the singular tool, applied independently per entry: each item's "ingredients" is that recipe's complete new recipeIngredient list (not a patch — any ingredient omitted is removed), foodId/unitId must already reference existing Mealie entities (this tool never looks up, matches, or creates foods/units), and referenceIds are preserved exactly as supplied. Same post-write integrity verification and best-effort rollback as the singular tool applies independently per recipe: a verification failure on one recipe restores only that recipe and is reported in its own result entry (error.rollbackSucceeded, plus error.rollbackError if the restore itself failed) — it never affects siblings. There is no cross-recipe transaction: recipes are processed independently, a failure on one (a 404/422/502 from Mealie, a local validation error like a mismatched foodId/foodName, or a verification failure) does not stop or roll back the others, and the response reports a success/failure result per recipe in the same order submitted. The whole call is rejected before any write starts only for a true request-shape problem — an empty batch, more than 25 recipes, a missing slug, or the same slug repeated in one call. The same recipeInstructions-id-regeneration caveat as update_recipe_ingredients applies to every recipe touched here (instruction content is preserved, only ids churn). Each entry uses either the complete-replacement form (ingredients) or the referenceId delta form (addIngredients/updateIngredients/removeIngredientReferenceIds) with the singular tool's semantics; an invalid or conflicting entry fails only its own result, before that recipe is written.
  Params: `updates`

- `update_recipe_instructions` — GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  Edits a recipe's instructions (text, title, summary, and links to ingredients via ingredientReferenceIds), PATCHing only recipeInstructions. Mealie instruction IDs are ephemeral — regenerated on every recipe write — so they are never accepted or valid as identity and must not be saved. Instead: call get_recipe_detailed first, pass that snapshot's exact updatedAt as expectedUpdatedAt, and address instructions by zero-based index in that snapshot. expectedUpdatedAt guards against editing from a stale snapshot: if the recipe has already changed when the tool reads it for mutation, the call fails before writing and the caller must re-read and retry. Mealie does not provide conditional recipe writes, so a concurrent edit occurring in the narrow interval between that validation read and the PATCH cannot be detected before the write. Two mutually exclusive forms: delta (addInstructions/updateInstructions/removeInstructionIndexes — focused edits, all indexes and anchors refer to the original snapshot) or instructions (complete ordered replacement — use for substantial rebuilds/reordering; [] clears all). ingredientReferenceIds must be referenceIds of the recipe's current ingredients (unknown, malformed or duplicate ids are rejected before any write; Mealie regenerates the id on every read for a legacy/unpinned ingredient that never had one stored — this affects only such ingredients, not every ingredient. To pin them, use update_recipe_ingredients complete replacement with the full ingredient collection, explicitly supplying a referenceId for every continuing row; then re-read the recipe before retrying, because the ingredient write changes the recipe snapshot and its updatedAt); the MCP never infers links — deciding wording, sectioning and which ingredients belong to a step is your job. Delta updates preserve omitted fields, untouched instructions and existing noteReferences exactly (existing dangling ingredient references are not cleaned up). A change that leaves instructions identical skips the write and returns the current recipe. After a write the returned recipe is verified by content (text/title/summary/ingredient and note references, ignoring ids); on mismatch the original instructions are restored best-effort and the call fails, reporting whether rollback succeeded (ids are regenerated by each write and rollback).
  Params: `slug`, `expectedUpdatedAt`, `instructions`, `addInstructions`, `updateInstructions`, `removeInstructionIndexes`

- `update_recipe_instructions_batch` — GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  Runs update_recipe_instructions for multiple recipes with bounded concurrency (5 at a time). Each entry has its own slug, its own expectedUpdatedAt (exact updatedAt from that recipe's get_recipe_detailed) and exactly one of the replacement form (instructions) or delta form (addInstructions/updateInstructions/removeInstructionIndexes), with the singular tool's semantics. Mealie instruction IDs are ephemeral and never valid identity. Each recipe is validated, written, verified and rolled back independently: a stale expectedUpdatedAt, invalid entry, API error or verification failure fails only that entry. Results come back in input order with requestedCount/succeededCount/failedCount; there is no cross-recipe transaction. The whole call is rejected before any write for an empty batch, more than 25 entries, a missing slug, or a repeated slug.
  Params: `updates`

- `update_recipe_taxonomy` — GET /api/organizers/categories, POST /api/organizers/categories, GET /api/organizers/tags, POST /api/organizers/tags, GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  Updates a recipe's categories and/or tags. Resolves requested names/slugs/IDs against existing taxonomy, optionally auto-creating missing values. Reads the recipe first to merge with existing taxonomy. Per collection, use either categories/tags (+ mode merge/replace) or the delta fields addCategories/removeCategories/addTags/removeTags (current - remove + add, other assignments untouched); additions and removals can be combined in one call. Removals must exist and are never created; createMissing only applies to additions. Unchanged Category/Tag collections are never written, whether the legacy merge/replace form or explicit delta form is used; if nothing changes, no recipe PATCH is issued. Returns final/added/removed/created per collection.
  Params: `slug`, `categories`, `tags`, `addCategories`, `removeCategories`, `addTags`, `removeTags`, `mode`, `createMissing`

- `update_recipe_taxonomy_batch` — GET /api/organizers/categories, POST /api/organizers/categories, GET /api/organizers/tags, POST /api/organizers/tags, GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
  Runs update_recipe_taxonomy for multiple recipes with bounded concurrency (5 at a time), returning a success/error result per recipe. Each entry accepts the same legacy (categories/tags + mode) or delta (addCategories/removeCategories/addTags/removeTags) fields. Each slug may appear only once; a request that repeats a slug is rejected as a whole before any recipe is processed. Category/tag creation via createMissing is serialized across the batch so a value requested by several recipes is created once, but createMissing applies per entry: an entry without it may fail as missing even if another entry creates that value, so set createMissing on every entry that names a new category or tag.
  Params: `updates`

- `update_recipe_tools` — GET /api/recipes/{slug}, GET /api/organizers/tools, POST /api/organizers/tools, PATCH /api/recipes/{slug}
  Assigns Mealie Tool organizers (equipment, e.g. "Whisk", "Sheet Pan") to one existing recipe. You decide which tools the recipe needs; this tool only resolves them deterministically (exact ID, then slug, then name, case-insensitive — no fuzzy matching or substitution) and persists them, PATCHing only the recipe's tools field. Two mutually exclusive forms: (1) tools + mode — "merge" (default) keeps existing assignments, "replace" sets the complete collection and DESTRUCTIVELY clears all assigned tools when tools is an empty array; (2) add and/or remove — a delta computed as current - remove + add, leaving every other assigned tool untouched. Unknown tools fail the call before any recipe write unless createMissing is true, which creates values from tools/add (never from remove); if a later creation or the recipe write then fails, any Tool organizers already created remain (no rollback). The same tool in both add and remove is rejected, and a call that changes nothing skips the recipe write.
  Params: `slug`, `tools`, `mode`, `add`, `remove`, `createMissing`

- `update_recipe_tools_batch` — GET /api/recipes/{slug}, GET /api/organizers/tools, POST /api/organizers/tools, PATCH /api/recipes/{slug}
  Applies update_recipe_tools to several recipes in one call. Each update accepts the same legacy (tools + mode) or delta (add/remove) contract as the singular tool, with the same deterministic ID/slug/name resolution — you decide which tools each recipe needs. Recipes are processed independently with bounded concurrency (5 at a time), results are returned in input order with per-recipe success/error plus requested/succeeded/failed counts, and a failure on one recipe never stops or rolls back the others (no cross-recipe transaction; Tool organizers created for a recipe that later fails remain). Organizer creation via createMissing is serialized across the batch so a Tool requested by several recipes is created once. createMissing still applies per entry: an entry without it may fail as missing even if another entry in the same call creates that Tool, so set createMissing on every entry that names a new Tool. The whole call is rejected before any write for an empty batch, more than 25 updates, a missing slug, or the same recipe slug repeated.
  Params: `updates`

## Meal Plans Operations (6)

- `create_mealplan` — POST /api/households/mealplans
  Creates a single meal plan entry for a given date.
  Params: `date`, `recipeId`, `title`, `entryType`

- `create_mealplan_bulk` — POST /api/households/mealplans
  Creates multiple meal plan entries at once via concurrent requests.
  Params: `entries`

- `get_all_mealplans` — GET /api/households/mealplans
  Lists meal plans with optional date range filtering and pagination.
  Params: `startDate`, `endDate`, `page`, `perPage`

- `get_mealplan_with_recipes` — GET /api/households/mealplans, GET /api/recipes/{slug}
  Returns meal plans with embedded recipe details (full recipe data fetched via batch requests with bounded concurrency).
  Params: `startDate`, `endDate`

- `get_todays_mealplan` — GET /api/households/mealplans/today
  Returns today's meal plan.

- `patch_mealplan` — DELETE /api/households/mealplans/{id}, GET /api/households/mealplans/{id}, PUT /api/households/mealplans/{id}, POST /api/households/mealplans
  Performs a batch of mixed operations on meal plan entries in a single call. Use this to move recipes between meal types, update entries, or add new ones.
  Params: `actions`

## Categories Operations (7)

- `create_category` — POST /api/organizers/categories
  Creates a new recipe category.
  Params: `name`

- `delete_category` — DELETE /api/organizers/categories/{id}
  Deletes a category. Mealie may refuse if recipes still reference it.
  Params: `categoryId`

- `get_categories` — GET /api/organizers/categories
  Lists and searches the household's recipe categories with pagination.
  Params: `page`, `perPage`

- `get_category` — GET /api/organizers/categories/{id}
  Retrieves a single category by its UUID.
  Params: `categoryId`

- `get_category_by_slug` — GET /api/organizers/categories/slug/{slug}
  Retrieves a single category by its URL slug.
  Params: `categorySlug`

- `get_empty_categories` — GET /api/organizers/categories/empty
  Returns categories that have no recipes assigned.

- `update_category` — PUT /api/organizers/categories/{id}
  Updates a category's name.
  Params: `categoryId`, `name`

## Tags Operations (7)

- `create_tag` — POST /api/organizers/tags
  Creates a new recipe tag.
  Params: `name`

- `delete_tag` — DELETE /api/organizers/tags/{id}
  Deletes a tag. Mealie may refuse if recipes still reference it.
  Params: `tagId`

- `get_empty_tags` — GET /api/organizers/tags/empty
  Returns tags that have no recipes assigned.

- `get_tag` — GET /api/organizers/tags/{id}
  Retrieves a single tag by its UUID.
  Params: `tagId`

- `get_tag_by_slug` — GET /api/organizers/tags/slug/{slug}
  Retrieves a single tag by its URL slug.
  Params: `tagSlug`

- `get_tags` — GET /api/organizers/tags
  Lists and searches the household's recipe tags with pagination.
  Params: `page`, `perPage`

- `update_tag` — PUT /api/organizers/tags/{id}
  Updates a tag's name.
  Params: `tagId`, `name`

## Shopping Lists Operations (13)

- `add_recipe_to_shopping_list` — POST /api/households/shopping/lists/{id}/recipe/{recipeId}
  Adds a recipe's ingredients to a shopping list.
  Params: `listId`, `recipeId`, `recipeIncrementQuantity`

- `create_shopping_list` — POST /api/households/shopping/lists
  Creates a new shopping list.
  Params: `name`

- `create_shopping_list_item` — POST /api/households/shopping/items
  Creates a single shopping list item.
  Params: `shoppingListId`, `note`, `quantity`, `unitId`, `foodId`, `labelId`

- `create_shopping_list_items_bulk` — POST /api/households/shopping/items/create-bulk
  Creates multiple shopping list items at once.
  Params: `items`

- `delete_shopping_list` — DELETE /api/households/shopping/lists/{id}
  Deletes a shopping list.
  Params: `listId`

- `delete_shopping_list_item` — DELETE /api/households/shopping/items/{id}
  Deletes a single shopping list item.
  Params: `itemId`

- `delete_shopping_list_items_bulk` — DELETE /api/households/shopping/items
  Deletes multiple shopping list items at once.
  Params: `itemIds`

- `get_shopping_list` — GET /api/households/shopping/lists/{id}
  Retrieves a shopping list by its UUID.
  Params: `listId`

- `get_shopping_list_items` — GET /api/households/shopping/items
  Lists all shopping list items across lists with pagination.
  Params: `page`, `perPage`, `search`

- `get_shopping_lists` — GET /api/households/shopping/lists
  Lists the household's shopping lists with pagination.
  Params: `page`, `perPage`

- `remove_recipe_from_shopping_list` — POST /api/households/shopping/lists/{id}/recipe/{recipeId}/delete
  Removes a recipe's ingredients from a shopping list.
  Params: `listId`, `recipeId`

- `update_shopping_list` — PUT /api/households/shopping/lists/{id}
  Updates a shopping list's name.
  Params: `listId`, `name`

- `update_shopping_list_item` — PUT /api/households/shopping/items/{id}
  Updates a shopping list item's note, quantity, or checked status.
  Params: `itemId`, `note`, `quantity`, `checked`

## Foods Operations (6)

- `create_food` — POST /api/foods
  Creates a new food. Call get_foods first to check whether an existing food or alias already covers this name — creating a duplicate food fragments the taxonomy instead of reusing what is already there.
  Params: `name`, `pluralName`, `description`, `aliases`, `labelId`

- `delete_food` — DELETE /api/foods/{id}
  DESTRUCTIVE and irreversible: permanently deletes a food. Use get_food first to verify this is the exact food intended. Deleting a food may affect recipes and shopping list items that reference it — Mealie may refuse the deletion in that case, leaving the food intact.
  Params: `foodId`

- `get_food` — GET /api/foods/{id}
  Retrieves a single food by ID, including its aliases and label information when present.
  Params: `foodId`

- `get_food_matches` — GET /api/foods (with queryFilter)
  Finds existing canonical Mealie food candidates for multiple already-interpreted food concepts in one call, including stored aliases (which get_foods' search does not check). Use this after deciding what foods an ingredient refers to (e.g. an LLM parsing "2 tbsp chopped fresh parsley" into unit=tablespoon, food=parsley) and before calling create_food, to check whether a matching food or alias already exists. Returns ranked candidates per query rather than choosing one — the caller decides which candidate (if any) to use. Each query's result includes truncated: true when additional matching candidates may exist beyond the returned items (either because there were more than maxMatchesPerQuery, or because Mealie's own retrieval for that query was itself incomplete) — narrow the query text or raise maxMatchesPerQuery if that matters for a given lookup. Does not parse ingredient text, does not perform fuzzy/semantic matching, and does not create, update, or otherwise modify any food or alias.
  Params: `queries`, `maxMatchesPerQuery`

- `get_foods` — GET /api/foods
  Lists and searches the household's foods (reusable structured ingredient entities such as "chicken breast" or "onion") with plain pagination. For resolving several already-interpreted food concepts to candidate IDs at once (e.g. after an LLM parses a batch of ingredients), prefer get_food_matches instead — it checks aliases too and answers many lookups in one call. Performs no fuzzy matching itself; matching is delegated entirely to Mealie's search.
  Params: `search`, `page`, `perPage`

- `update_food` — GET /api/foods/{id}, PUT /api/foods/{id}
  Updates an existing food. Fields left unspecified keep their current value. Sufficient for adding an alias: get_food the current record, append to its existing aliases, and pass the complete list back here.
  Params: `foodId`, `name`, `pluralName`, `description`, `aliases`, `labelId`

## Units Operations (6)

- `create_unit` — POST /api/units
  Creates a canonical Mealie ingredient unit when an appropriate unit does not already exist. Call get_units first to check whether an existing unit or alias already covers this name — creating a duplicate unit fragments the vocabulary instead of reusing what is already there. Note: if the new unit's name/abbreviation matches one of Mealie's built-in standardized units (e.g. "tablespoon"), Mealie will automatically populate standardQuantity/standardUnit itself unless both are explicitly supplied here — this tool does not perform that matching itself.
  Params: `name`, `pluralName`, `description`, `abbreviation`, `pluralAbbreviation`, `useAbbreviation`, `fraction`, `aliases`, `standardQuantity`, `standardUnit`

- `delete_unit` — DELETE /api/units/{id}
  DESTRUCTIVE and irreversible: permanently deletes a canonical Mealie ingredient unit. Use get_unit first to verify this is the exact unit intended. Deleting a unit that is still referenced by existing recipe ingredients will be refused by Mealie rather than cascaded.
  Params: `unitId`

- `get_unit` — GET /api/units/{id}
  Retrieves a single canonical Mealie ingredient unit by ID, including its aliases, abbreviations, and standard-quantity conversion metadata when present.
  Params: `unitId`

- `get_unit_matches` — GET /api/units (with queryFilter)
  Finds existing canonical Mealie unit candidates for multiple already-interpreted unit concepts in one call, matching against names, plural names, abbreviations, plural abbreviations, and stored aliases (which get_units' search does not check). Use after interpreting unit text (e.g. an LLM parsing "2 tbsp olive oil" into unit=tablespoon) and before calling create_unit, to check whether a matching unit or alias already exists. Returns ranked candidates per query rather than choosing one — the caller decides which candidate (if any) to use. Each query's result includes truncated: true when additional matching candidates may exist beyond the returned items (either because there were more than maxMatchesPerQuery, or because Mealie's own retrieval for that query was itself incomplete) — narrow the query text or raise maxMatchesPerQuery if that matters for a given lookup. Does not parse ingredient text, does not perform fuzzy/semantic matching, and does not create, update, or otherwise modify any unit or alias.
  Params: `queries`, `maxMatchesPerQuery`

- `get_units` — GET /api/units
  Search or list canonical Mealie ingredient units (e.g. "tablespoon", "cup", "gram") with plain pagination. Use this after interpreting an ingredient's unit text (e.g. deciding that "tbsp" in "2 tbsp olive oil" means tablespoon) to resolve the existing Mealie unit and its ID for use with update_recipe_ingredients. This tool does not parse ingredient language or infer units from free text — search matches only against existing unit name, pluralName, abbreviation, and pluralAbbreviation, not aliases. For resolving several already-interpreted unit concepts at once, and for alias-aware matching, prefer get_unit_matches.
  Params: `search`, `page`, `perPage`

- `update_unit` — GET /api/units/{id}, PUT /api/units/{id}
  Updates an existing canonical Mealie ingredient unit. Fields left unspecified keep their current value. Sufficient for adding an alias: get_unit the current record, append to its existing aliases, and pass the complete list back here. Units are shared vocabulary referenced by many recipes' ingredients — update deliberately, since renaming or repurposing a unit changes how every recipe using it displays.
  Params: `unitId`, `name`, `pluralName`, `description`, `abbreviation`, `pluralAbbreviation`, `useAbbreviation`, `fraction`, `aliases`, `standardQuantity`, `standardUnit`

## Tools Operations (6)

- `create_tool` — POST /api/organizers/tools
  Creates a canonical Mealie Tool organizer when no appropriate one exists. Call get_tool_matches first to check whether an existing Tool already covers this equipment — creating a duplicate fragments the shared vocabulary. This tool does not manage household "on hand" ownership.
  Params: `name`

- `delete_tool` — DELETE /api/organizers/tools/{id}
  DESTRUCTIVE and irreversible: permanently deletes a Mealie Tool organizer. Use get_tool first to verify this is the exact Tool intended. If Mealie refuses the deletion, its error is surfaced unchanged.
  Params: `toolId`

- `get_tool` — GET /api/organizers/tools/{id}
  Retrieves a single Mealie Tool organizer by ID, including metadata such as householdsWithTool when present.
  Params: `toolId`

- `get_tool_matches` — GET /api/organizers/tools (with queryFilter)
  Finds existing canonical Mealie Tool organizer candidates for multiple equipment names in one call, matching against tool name and slug. You decide which equipment a recipe needs (e.g. that it needs a whisk); this tool only finds the canonical organizer for a name you already chose. Returns ranked candidates per query (exact matches before substring matches, name before slug) and never picks a winner. Each query's result includes truncated: true when more candidates may exist than were returned. Deterministic string matching only — no fuzzy or semantic equipment inference — and it never creates, updates, or deletes anything. Use before create_tool.
  Params: `queries`, `maxMatchesPerQuery`

- `get_tools` — GET /api/organizers/tools
  Search or list canonical Mealie Tool organizers (kitchen equipment, e.g. "Whisk", "Sheet Pan") with plain pagination. Search uses Mealie's native name-based search. Read-only. For resolving several already-decided equipment names at once, prefer get_tool_matches.
  Params: `search`, `page`, `perPage`

- `update_tool` — GET /api/organizers/tools/{id}, PUT /api/organizers/tools/{id}
  Renames an existing Mealie Tool organizer. Reads the current Tool first and carries forward its existing householdsWithTool ownership metadata, since Mealie's PUT is a full replacement; household ownership itself cannot be changed here. Tools are shared by every recipe that uses them, so rename deliberately.
  Params: `toolId`, `name`

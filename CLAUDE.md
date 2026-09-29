# CLAUDE.md

Project conventions for Claude and other implementation agents working on
mealie-mcp-server.

## Role in the Agent Workflow

Claude is the **implementation and remediation agent**. It is not the design
authority and it is not the final reviewer.

For automated feature work:

1. The triggering \`[agent-build]\` issue is the approved design contract.
2. Implement that contract without silently broadening scope.
3. Open changes on a \`claude/\` branch only.
4. Codex performs an independent review of the pull request.
5. On remediation runs, address Codex's actionable findings without redesigning
   the feature.
6. The human contributor performs final acceptance testing and decides whether
   the work is ready to submit upstream.

If a requirement is materially ambiguous, a Codex finding conflicts with the
approved design, or a safe fix requires a product decision, stop and report the
blocker instead of guessing.

Never merge a pull request, push directly to \`main\` or \`agent-main\`, or open
an upstream pull request unless a human explicitly asks for that action.

## Branch Model

- `main` is the clean upstream-tracking branch and should remain aligned with
  `timo-reymann/mealie-mcp-server:main`.
- `agent-main` is the personal development branch. It contains the local
  automation harness and is the base for automated implementation PRs.
- `claude/*` branches are disposable feature/remediation branches based on
  `agent-main`.
- Agent-created PRs target `agent-main`, never `main`.
- Upstream submissions must be prepared separately from a fresh `main` base so
  personal automation files are not included.

## Working Method

- Read the issue, relevant source, tests, \`ARCHITECTURE.md\`, and relevant
  sections of \`WORKFLOWS.md\` before modifying code.
- Prefer the smallest complete change that satisfies the approved design.
- Follow existing project patterns before adding new abstractions.
- Preserve public behavior and MCP compatibility unless the design explicitly
  calls for a change.
- Add or update tests for changed behavior and important edge cases.
- Do not make unrelated cleanup, formatting, dependency, or refactoring changes.
- Do not weaken tests merely to make them pass.
- Never expose credentials, tokens, Mealie API keys, or secret values in code,
  logs, comments, fixtures, or documentation.

## Tool Registration

Every tool registered via \`server.tool()\` in \`src/tools/*.ts\` **must** have:

1. A \`// @endpoints\` comment on the line(s) directly above the \`server.tool(\`
   call listing every Mealie API endpoint the tool hits, using \`METHOD /path\`
   format:

   \`\`\`ts
   // @endpoints GET /api/recipes/{slug}, PATCH /api/recipes/{slug}
   server.tool(
     'update_recipe_ingredients',
     'Description of the tool.',
     { ... },
     async (...) => { ... },
   );
   \`\`\`

2. A description string as the second argument to \`server.tool()\`.

These conventions are enforced by generated-documentation checks and tests.

## Adding or Changing a Tool

1. Add or modify the tool in \`src/tools/<category>.ts\`.
2. Keep its \`// @endpoints\` metadata and description accurate.
3. Add or update tests for the behavior.
4. Run \`yarn gen:docs\` when generated tool documentation changes.
5. Run the complete validation suite before finishing.

## Endpoint Mapping Rules

- Simple tools: list the endpoint(s) the handler calls directly.
- Composite tools such as \`find_recipes_for_ingredients\`: list every endpoint
  reachable from the handler, including calls through \`src/lib/*.ts\` helpers.
- \`GET\` with queryFilter, such as \`get_food_matches\`: note it as
  \`GET /api/foods (with queryFilter)\`.
- Multiple endpoints are comma-separated, for example:
  \`GET /api/recipes/{slug}, PATCH /api/recipes/{slug}\`.

## Validation

Run all of the following before declaring implementation or remediation
complete:

\`\`\`bash
corepack enable
yarn install --immutable
yarn typecheck
yarn lint
yarn gen:docs:check
yarn test
yarn build
\`\`\`

If \`yarn gen:docs:check\` reports stale generated documentation after an
intentional tool/documentation change, run \`yarn gen:docs\`, include the
generated changes, and repeat the relevant checks.

Tests live in \`src/__tests__/\` and run with Vitest.

## Human Ownership of AI-Assisted Changes

The AI-generated contribution policy in \`CONTRIBUTING.md\` applies to all agent
work. Automation may identify a pull request as AI-assisted, but it must not
claim that the human contributor understands or accepts the changes. Those
acknowledgements belong to the human after review and testing.

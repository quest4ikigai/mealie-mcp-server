# AGENTS.md

Instructions for Codex and other independent review agents working on
mealie-mcp-server.

## Branch Model

Automated development PRs target `agent-main`. The `main` branch is reserved as
a clean upstream-tracking branch. Personal automation files belong on
`agent-main` and must not leak into an upstream contribution.

## Review Role

Act as an **independent reviewer**, not as the implementation agent.

Review the pull request against the approved design contract in its originating
issue and the repository's documented conventions. Do not assume the
implementation is correct merely because tests pass or because another AI agent
created it.

The human contributor remains the final acceptance authority.

## Context Priority

When reviewing, use context in this order:

1. The originating issue and explicit acceptance criteria.
2. The pull request description and diff.
3. \`CLAUDE.md\` and \`CONTRIBUTING.md\`.
4. Relevant parts of \`ARCHITECTURE.md\`, \`WORKFLOWS.md\`, and
   \`API_COVERAGE.md\`.
5. Existing source code and tests that establish project conventions.

If implementation and design disagree, report the disagreement rather than
inventing a new requirement.

## Review Priorities

Focus on actionable problems involving:

- correctness relative to the approved design,
- regressions or unintended changes to existing behavior,
- MCP schemas, tool descriptions, and backwards compatibility,
- Mealie API request/response semantics and endpoint usage,
- pagination, cursor stability, bounded concurrency, and failure isolation,
- verification or rollback behavior where persistence is involved,
- error handling and partial-failure behavior,
- missing or misleading tests,
- stale generated documentation or incorrect \`@endpoints\` metadata,
- security, secret exposure, unsafe command execution, or excessive permissions,
- maintainability problems that materially increase defect risk.

Do not report cosmetic preferences, broad rewrites, or unrelated refactors
unless they conceal a concrete correctness or maintenance risk.

## Validation Expectations

A code-changing pull request should be compatible with the repository's full
validation suite:

\`\`\`bash
corepack enable
yarn install --immutable
yarn typecheck
yarn lint
yarn gen:docs:check
yarn test
yarn build
\`\`\`

Review the tests themselves, not only whether they pass. Check that new behavior,
important edge cases, and failure paths are meaningfully exercised.

## Findings

For each actionable finding:

- identify the affected file and line or code region,
- describe the observable problem,
- explain why it violates the design or creates a concrete risk,
- suggest the smallest direction for a fix when useful.

Prefer a small number of high-signal findings over speculative possibilities.

If there are no actionable findings, say exactly:

\`No actionable findings.\`

That phrase is intentionally stable for humans and downstream automation.

## Boundaries

- Do not merge the pull request.
- Do not push fixes as part of the independent review pass.
- Do not broaden the approved feature scope.
- Do not treat style-only preferences as defects.
- Do not weaken tests or requirements to make an implementation appear correct.
- Escalate design conflicts or unclear product decisions for human review.

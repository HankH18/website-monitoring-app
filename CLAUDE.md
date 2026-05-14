# website-monitoring-app

<!-- Initialized by claude-init v1.3.0 on 2026-05-14 -->
<!-- Keep under ~200 lines. Claude reads this every turn. -->

## What this is

TODO: 2–3 sentences. What does it do, who uses it, what's the deploy surface?

## Stack

Node/TypeScript,Docker

## Build & test

- Build: `npm run build`
- Dev:   `npm run dev`

## Topology

- `src/` — application code
- `tests/` — test suite
- `.claude/` — agent config (hooks, sub-agents, commands)
- TODO: add the rest

## Conventions

- Match existing patterns. Search before inventing — Grep first.
- New files mirror nearest-neighbor structure.
- No new dependencies without justification.
- Tests are required for new code paths.

## Guardrails (never do these)

- Never commit secrets, .env files, or credentials.
- Never push directly to `main` / `master`. Branch + PR.
- Never modify generated artifacts (`dist/`, `build/`, `.next/`, `__pycache__/`, `target/`).
- Never disable a test to get green. Fix the cause or ask.
- Never rewrite migrations that have run anywhere.

## Sub-agents (use them)

Defined in `.claude/agents/`:

- `planner` (Opus) — call BEFORE coding any feature touching >2 files.
- `code-reviewer` (Opus) — call AFTER a feature, before commit. Catches subtle correctness/security issues.
- `test-runner` (Sonnet) — call instead of running tests inline; saves context.
- `debugger` (Opus) — call when a test fails or behavior is unexpected. Root-cause analysis, not pattern-matching.

## Slash commands

- `/plan <request>` — invoke planner sub-agent
- `/review [target]` — invoke code-reviewer
- `/ship [msg]` — test + commit (no push)

## MCP

See `.claude/MCP_SETUP.md` for copy-paste recipes (GitHub, Postgres, Context7, Sentry, Playwright, etc.).

## Failure modes (lessons learned)

<!-- Add as you discover them. This is the most valuable section over time. Examples: -->
<!-- - The `users` table has soft deletes (deleted_at); always filter unless told otherwise. -->
<!-- - Integration tests need Postgres on port 5433 (`docker-compose up -d db`). -->

TODO: Start populating after the first session. When Claude gets something wrong, document it here.

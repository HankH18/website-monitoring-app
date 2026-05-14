# website-monitoring-app

<!-- Initialized by claude-init v1.3.0 on 2026-05-14 -->
<!-- Keep under ~200 lines. Claude reads this every turn. -->

## What this is

Self-hosted visual-regression / website-change monitor. Playwright captures screenshots + DOM text on a cron, runs pixel + text diff, escalates non-trivial changes to Claude for an AI verdict, and notifies via Slack (interactive) or email. SQLite for state, EJS dashboard, Docker deploy. User is hank@decidethrive.com — solo operator, primarily monitoring own e-commerce sites.

## Stack

Node/TypeScript,Docker

## Build & test

- Build: `npm run build`
- Dev: `npm run dev`

## Topology

- `src/` — application code
- `src/index.ts` — entrypoint (CLI flags `--baseline`, `--check`; otherwise boots scheduler + dashboard)
- `src/scheduler.ts` — node-cron loop driving `runAllChecks`
- `src/monitor.ts` — orchestrates one URL check (capture → compare → notify)
- `src/capture.ts` — Playwright wrapper (screenshot + DOM text)
- `src/compare/` — `pixel.ts`, `text.ts`, `ai.ts` (comparison pipeline)
- `src/notify/` — `slack.ts`, `email.ts`
- `src/storage/` — `db.ts` (SQLite via better-sqlite3), `files.ts` (capture file I/O)
- `src/dashboard/` — Express + EJS (`server.ts`, `routes.ts`, `views/`)
- `src/config.ts`, `src/logger.ts`, `src/types.ts`, `src/acknowledge.ts`
- `config.yaml` — URL list + settings (loaded at startup; DB is runtime source of truth)
- `data/` — runtime: SQLite DB (`pageguard.db`) + per-URL screenshot tree under `captures/` (gitignored)
- `.claude/` — agent config (hooks, sub-agents, commands)
- `Dockerfile`, `docker-compose.yml` — deploy surface

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

1. **AI image inputs are full-page screenshots.** Multi-MB images get base64-encoded into every `assessChange` call. That's expensive in Anthropic tokens (priced by image area) and slow. Resize with Sharp to ≤1568px on the long axis before sending — full-page is fine for the dashboard and human review, but AI gets the cropped or resized version.

2. **Reference-baseline can be poisoned by an errored capture.** In `src/monitor.ts`, when `isRef` is true the code inserts the capture and calls `setUrlReference` even if `capture.error` is set. An error screenshot becomes the baseline forever. Always check `capture.error` before promoting to reference; surface "baseline failed" in the dashboard instead.

3. **Cron cycles can overlap and double-bill Anthropic.** `runAllChecks` is sequential and can exceed the cron interval. `node-cron` fires the next tick regardless, so two cycles run in parallel and every AI call gets duplicated. Add a "currently running" mutex in `src/scheduler.ts` and skip (don't queue) the next tick if one's already in flight.

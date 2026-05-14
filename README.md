# PageGuard

Self-hosted website monitoring that detects visual and structural changes on key web pages and alerts you when something looks wrong.

## How It Works

1. **Scheduled checks** (cron, default every 15 minutes) visit each URL sequentially with a configurable delay between each.
2. **Playwright** captures a full-page screenshot and extracts the visible text/structural outline of the rendered DOM.
3. **First-pass comparison** (cheap, no API call): pixel-level diff via pixelmatch + text diff. If both are below threshold, logs "no change" and skips AI.
4. **Second-pass comparison** (only when first pass detects changes): sends before/after screenshots + text diff to Claude (claude-sonnet-4-20250514) for significance assessment.
5. **Notification** via Slack (primary, interactive) and/or email (secondary, send-only).
6. **Acknowledgment** via Slack button/thread reply or the web dashboard — updates the reference baseline.

## Quick Start

### Prerequisites

- Node.js 20+
- Playwright system dependencies (auto-installed by Docker, or run `npx playwright install chromium`)

### Local Development

```bash
# Install dependencies
npm install
npx playwright install chromium

# Copy and configure environment
cp .env.example .env
# Edit .env with your API keys

# Edit config.yaml with your URLs

# Capture initial baselines
npm run baseline

# Start the server (dashboard + scheduler + Slack app)
npm run dev
```

### Docker Deployment

```bash
# Copy and configure
cp .env.example .env
# Edit .env and config.yaml

# Build and run
docker compose up -d

# Capture initial baselines
docker compose exec pageguard node dist/index.js --baseline

# View logs
docker compose logs -f pageguard
```

The dashboard is at `http://localhost:3000` (default credentials: admin/changeme).

## Configuration

### config.yaml

| Key                             | Default               | Description                                         |
| ------------------------------- | --------------------- | --------------------------------------------------- |
| `schedule`                      | `*/15 * * * *`        | Cron expression for check frequency                 |
| `delay_between_checks_ms`       | `3000`                | Delay between each URL check (ms)                   |
| `thresholds.pixel_diff_percent` | `2.0`                 | Pixel diff % below which AI is skipped              |
| `thresholds.text_change_lines`  | `0`                   | Text line changes below which AI is skipped         |
| `ack_timeout_minutes`           | `60`                  | Time before an unacknowledged alert gets a reminder |
| `notifications.slack`           | `true`                | Enable Slack notifications globally                 |
| `notifications.email`           | `false`               | Enable email notifications globally                 |
| `slack.channel`                 | `#website-monitoring` | Slack channel for alerts                            |
| `dashboard.port`                | `3000`                | Dashboard and API port                              |

URLs can override notification settings individually:

```yaml
urls:
  - url: "https://example.com"
    label: "Homepage"
    notifications:
      slack: true
      email: true
```

### Environment Variables

| Variable               | Required         | Description                            |
| ---------------------- | ---------------- | -------------------------------------- |
| `ANTHROPIC_API_KEY`    | Yes              | Anthropic API key for Claude           |
| `SLACK_BOT_TOKEN`      | For Slack        | Slack bot token (xoxb-...)             |
| `SLACK_SIGNING_SECRET` | For Slack        | Slack app signing secret               |
| `SLACK_APP_TOKEN`      | For Socket Mode  | Slack app-level token (xapp-...)       |
| `SMTP_USER`            | For SMTP email   | SMTP username                          |
| `SMTP_PASS`            | For SMTP email   | SMTP password                          |
| `RESEND_API_KEY`       | For Resend email | Resend API key                         |
| `DASHBOARD_USER`       | No               | Dashboard username (default: admin)    |
| `DASHBOARD_PASS`       | No               | Dashboard password (default: changeme) |
| `DATA_DIR`             | No               | Data directory (default: ./data)       |

## Slack App Setup

1. Create a new app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** (simplest — no public URL needed) and generate an app-level token with `connections:write` scope
3. Under **OAuth & Permissions**, add bot scopes: `chat:write`, `files:write`, `channels:read`
4. Under **Event Subscriptions**, subscribe to `message.channels` (for thread replies)
5. Under **Interactivity & Shortcuts**, enable interactivity (Socket Mode handles the endpoint)
6. Install the app to your workspace
7. Set `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `SLACK_APP_TOKEN` in `.env`

## CLI Commands

```bash
# Capture baselines for all configured URLs
npm run baseline

# Run a one-time check (no server)
npm run check

# Start the full server (dashboard + scheduler + Slack)
npm run dev        # development (tsx)
npm run start      # production (compiled)
```

## Dashboard

The web dashboard (protected by HTTP basic auth) lets you:

- View all monitored URLs and their current status
- See latest vs. reference screenshots side-by-side
- Manually trigger a check for any URL
- Manually update the reference baseline
- Add/remove URLs from the monitoring list
- View change history and past alerts
- Acknowledge changes (updates the reference)

## Backup & export

The `./data` directory (DB + captures) is the source of truth. `GET /api/export` streams a tar.gz of it for offsite backup, and `POST /api/cleanup` enforces per-URL retention (configurable via `RETENTION_KEEP_PER_URL`, default 20). For SQLite-consistent online backups, recovery, and CSRF details, see [docs/BACKUP.md](docs/BACKUP.md).

## REST API

A versioned, bearer-authenticated REST API is available at `/api/v1/*` for programmatic use, parallel to the dashboard. Set `API_TOKEN` in `.env` to enable it. See [docs/API.md](docs/API.md) for usage and [docs/openapi.yaml](docs/openapi.yaml) for the schema.

## Architecture

```
src/
├── index.ts              # Entry point — CLI modes + server startup
├── config.ts             # YAML config loader
├── types.ts              # Shared TypeScript types
├── logger.ts             # Winston logger
├── capture.ts            # Playwright page capture
├── monitor.ts            # Core monitoring logic (capture → compare → notify)
├── scheduler.ts          # Cron scheduler + baseline/check runners
├── acknowledge.ts        # Ack timeout checker
├── compare/
│   ├── pixel.ts          # pixelmatch screenshot diff
│   ├── text.ts           # Text content diff
│   └── ai.ts             # Claude multimodal assessment
├── notify/
│   ├── slack.ts          # Slack Bolt app (messages + interactivity)
│   └── email.ts          # SMTP / Resend email sender
├── storage/
│   ├── db.ts             # SQLite (better-sqlite3)
│   └── files.ts          # Disk storage for captures
└── dashboard/
    ├── server.ts         # Express + basic auth
    ├── routes.ts         # Dashboard + API routes
    └── views/            # EJS templates
```

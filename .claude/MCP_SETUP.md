# MCP Setup — Comprehensive Reference

Curated MCP servers for Claude Code, organized by purpose. Every entry includes
install command, when to reach for it, and gotchas. Pick what serves your
project, not what's trending.

---

## Quick concepts

**Scope** — three places to register a server:

| Scope     | Stored in                          | Visible to                       | When to use                                |
|-----------|------------------------------------|----------------------------------|--------------------------------------------|
| `user`    | `~/.claude.json`                   | every project on your machine    | personal credentials, cross-repo tools     |
| `project` | `.mcp.json` (committed to repo)    | every contributor on the project | shared dev tools (DB schemas, Playwright)  |
| `local`   | `.claude/settings.local.json`      | only this machine, this project  | one-off experiments, ignored by git        |

**Transports** — three ways a server runs:

- `stdio` — local subprocess (most common; npx/uvx commands).
- `sse` / `streamable-http` — remote HTTP server with OAuth or bearer token.
- Pick HTTP for vendor-hosted servers (GitHub, Sentry, Linear). Pick stdio when
  the server needs local credentials or filesystem access.

**Tool Search** — Claude Code lazy-loads MCP tools by default (saves ~95% of
context). You can run 10+ servers without drowning the prompt. Override with
`alwaysLoad: true` in the server config for tools you call constantly.

**Verify** — after any install:

```bash
claude mcp list                 # see registered servers
claude mcp get <name>           # inspect / debug one
claude mcp remove <name>        # clean up failed attempts
```

---

## How to choose

Three to seven servers is the sweet spot. Each adds tool descriptions to
Claude's context budget — even with Tool Search, more servers means slower
tool selection. Audit yearly: a server you don't use is a server slowing you
down.

Decision rules:

1. **Does Claude Code already do this?** Filesystem and basic memory are
   built-in. Skip the dedicated MCP versions unless you need cross-repo file
   access or shared memory across agents.
2. **Vendor-maintained > community.** Roughly 66% of audited community MCP
   servers had security findings in early 2026. Default to official servers
   from the actual vendor (GitHub by GitHub, Sentry by Sentry, Stripe by
   Stripe).
3. **Read-only by default.** Use a read-only DB role, a read-only GitHub
   token, a read-only AWS role. Promote to write access only when you need it.
4. **Pin versions.** Once a server works, pin it in `.mcp.json`. Don't
   auto-update on every spawn — the ecosystem is young and breaking changes
   happen.

---

## 1. Core (start here)

### GitHub — official, hosted, OAuth
The single highest-impact install for most repos. PR review, issue triage,
branch operations.

```bash
claude mcp add --transport http --scope user github https://api.githubcopilot.com/mcp/ \
  --header "Authorization: Bearer $GITHUB_PAT"
```

Scope your token: read-only for review workflows, push access only when Claude
should actually open PRs. Use a fine-grained PAT, not classic.

### Context7 — live, version-pinned library docs
Kills hallucinated APIs on fast-moving frameworks (Next.js, LangChain,
Drizzle, anything that changes more than once a quarter). Claude pulls the
real signature for the version you're on, not a stale 2024 example.

```bash
claude mcp add --scope user context7 "npx -y @upstash/context7-mcp"
```

Reach for it whenever Claude says "here's how that library works" and you're
not 100% sure it's right.

### Git (built-in repo operations)
Most Claude Code installs already shell out to git via Bash. The dedicated
server is only worth it if you want structured commit/diff/log objects rather
than parsed text output.

```bash
claude mcp add --scope user git "uvx mcp-server-git"
```

Most users skip this — Bash with git is simpler.

---

## 2. Databases & Data Stores

### Postgres / Redshift (Postgres wire protocol works for Redshift)
```bash
claude mcp add --scope project postgres "npx -y @modelcontextprotocol/server-postgres" \
  --env "POSTGRES_CONNECTION_STRING=postgres://USER:PASS@HOST:5432/DB"
```

**Always** point at a read-only role for anything resembling production.
Claude *will* propose UPDATEs and DELETEs if it thinks they're warranted.

### MySQL / MariaDB
```bash
claude mcp add --scope project mysql "npx -y @benborla29/mcp-server-mysql" \
  --env "MYSQL_HOST=..." --env "MYSQL_USER=..." --env "MYSQL_PASS=..."
```

### SQLite
```bash
claude mcp add --scope project sqlite "uvx mcp-server-sqlite --db-path ./db.sqlite"
```

### MongoDB
```bash
claude mcp add --scope project mongo "npx -y mongodb-mcp-server" \
  --env "MDB_MCP_CONNECTION_STRING=mongodb+srv://..."
```

### Redis / Valkey
```bash
claude mcp add --scope project redis "npx -y @modelcontextprotocol/server-redis" \
  --env "REDIS_URL=redis://localhost:6379"
```

### Snowflake
```bash
claude mcp add --scope project snowflake "uvx mcp-server-snowflake" \
  --env "SNOWFLAKE_ACCOUNT=..." --env "SNOWFLAKE_USER=..." --env "SNOWFLAKE_PASSWORD=..."
```

### BigQuery
```bash
claude mcp add --scope project bigquery "uvx mcp-server-bigquery" \
  --env "GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json"
```

### DynamoDB
Use the AWS MCP (below) — it covers DynamoDB plus the rest of AWS.

---

## 3. Cloud & Infrastructure

### AWS — official Amazon MCP
Lambda, Redshift, S3, IAM, CloudWatch, DynamoDB, etc. Single server, broad
coverage. Authenticates via your local AWS profile.

```bash
claude mcp add --scope user aws "uvx awslabs.aws-api-mcp-server@latest" \
  --env "AWS_PROFILE=default" --env "AWS_REGION=us-east-1"
```

For production: use named profiles with read-only IAM roles. Promote to
write-capable profiles only for the session that needs them.

### Cloudflare — official
Workers, R2, KV, D1, DNS, deployment.

```bash
claude mcp add --transport http --scope user cloudflare https://mcp.cloudflare.com/sse
```

### Vercel — official
Project status, deployment logs, env vars, preview URLs.

```bash
claude mcp add --transport http --scope user vercel https://mcp.vercel.com/sse
```

### Supabase
Database, auth, storage, edge functions in one server.

```bash
claude mcp add --scope project supabase "npx -y @supabase/mcp-server-supabase" \
  --env "SUPABASE_URL=..." --env "SUPABASE_SERVICE_ROLE_KEY=..."
```

### Firebase
```bash
claude mcp add --scope project firebase "npx -y @gannonh/firebase-mcp" \
  --env "GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json"
```

### Docker / Docker Hub
Container ops, image search, registry interactions.

```bash
claude mcp add --scope user docker "uvx docker-mcp"
```

### Kubernetes
```bash
claude mcp add --scope user k8s "npx -y mcp-server-kubernetes"
```

Read-only by default; pass `--enable-write` only when you actively need
`kubectl apply`.

### Terraform
```bash
claude mcp add --scope project terraform "uvx terraform-mcp-server"
```

---

## 4. Browser, Web, & Scraping

### Playwright — official Microsoft
Browser automation, UI verification, E2E test debugging, screenshot/PDF
generation. Best-in-class for any UI-touching work.

```bash
claude mcp add --scope project playwright "npx -y @playwright/mcp@latest"
```

### Puppeteer
Older sibling. Use Playwright unless you specifically need Chrome DevTools
Protocol features Playwright doesn't expose.

```bash
claude mcp add --scope project puppeteer "npx -y @modelcontextprotocol/server-puppeteer"
```

### Fetch — built-in style web fetching
Pull and convert web pages to markdown. Useful for "summarize this URL" tasks.

```bash
claude mcp add --scope user fetch "uvx mcp-server-fetch"
```

Pin to a specific commit/tag — this server has security implications since it
can hit any URL.

### Firecrawl
Production-grade web scraping with JS rendering, structured extraction.

```bash
claude mcp add --scope user firecrawl "npx -y @firecrawl/mcp-server" \
  --env "FIRECRAWL_API_KEY=fc-..."
```

### Brave Search / Tavily / Perplexity
Web search inside agent loops. Pick one — they're functionally similar.

```bash
# Brave (free tier, 2k queries/mo)
claude mcp add --scope user brave "npx -y @modelcontextprotocol/server-brave-search" \
  --env "BRAVE_API_KEY=..."

# Tavily (developer-friendly, free tier)
claude mcp add --scope user tavily "npx -y tavily-mcp" --env "TAVILY_API_KEY=tvly-..."

# Perplexity (paid, higher-quality summaries)
claude mcp add --scope user perplexity "npx -y server-perplexity-ask" \
  --env "PERPLEXITY_API_KEY=pplx-..."
```

---

## 5. Observability & Monitoring

### Sentry — official, OAuth
Alert → fix loops without context-switching. Claude reads the error,
identifies the file, drafts the fix.

```bash
claude mcp add --transport http --scope user sentry https://mcp.sentry.dev/mcp
```

### Datadog
```bash
claude mcp add --scope user datadog "uvx mcp-server-datadog" \
  --env "DD_API_KEY=..." --env "DD_APP_KEY=..."
```

### Grafana
```bash
claude mcp add --scope project grafana "npx -y @grafana/mcp-grafana" \
  --env "GRAFANA_URL=..." --env "GRAFANA_API_KEY=..."
```

### CloudWatch
Covered by the AWS server. Don't install separately.

### Honeycomb
```bash
claude mcp add --scope project honeycomb "npx -y @honeycombio/honeycomb-mcp" \
  --env "HONEYCOMB_API_KEY=..."
```

---

## 6. Communication & Project Management

### Slack
Search messages, post updates, summarize channels. OAuth flow on first run.

```bash
claude mcp add --transport http --scope user slack https://mcp.slack.com/mcp
```

### Linear — official
Issue tracking, sprint management, comment threads.

```bash
claude mcp add --transport http --scope user linear https://mcp.linear.app/sse
```

### Jira / Atlassian
```bash
claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v1/sse
```

### Notion — official
```bash
claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp
```

### Asana — official
```bash
claude mcp add --transport http --scope user asana https://mcp.asana.com/sse
```

### Discord
```bash
claude mcp add --scope user discord "npx -y @v-3/discordmcp" \
  --env "DISCORD_TOKEN=..."
```

### Gmail / Google Calendar / Drive — Google Workspace
```bash
claude mcp add --transport http --scope user gmail https://gmailmcp.googleapis.com/mcp/v1
claude mcp add --transport http --scope user gcal https://calendarmcp.googleapis.com/mcp/v1
claude mcp add --transport http --scope user gdrive https://drivemcp.googleapis.com/mcp/v1
```

---

## 7. Commerce & Payments

### Stripe — official
Search customers, query subscriptions, draft refunds, query payment intents.

```bash
claude mcp add --scope user stripe "npx -y @stripe/mcp" \
  --env "STRIPE_SECRET_KEY=sk_test_..."  # use restricted key, not live root
```

Use a *restricted* API key for read-only investigations. Live root keys in an
agent loop are how accidents happen.

### Shopify Admin — official
Products, orders, customers, metafields, analytics.

```bash
claude mcp add --scope user shopify "npx -y @shopify/admin-mcp"
```

### PayPal
```bash
claude mcp add --scope user paypal "npx -y @paypal/mcp-server" \
  --env "PAYPAL_CLIENT_ID=..." --env "PAYPAL_CLIENT_SECRET=..."
```

### Square
```bash
claude mcp add --scope user square "npx -y @square/mcp-server" \
  --env "SQUARE_ACCESS_TOKEN=..."
```

---

## 8. Marketing & Analytics

### Klaviyo
Email/SMS automation, segments, flow performance. Useful for e-commerce.

```bash
claude mcp add --scope user klaviyo "npx -y @klaviyo/mcp-server" \
  --env "KLAVIYO_API_KEY=pk_..."
```

### Google Ads — official
```bash
claude mcp add --transport http --scope user gads https://mcp.google.com/ads/sse
```

### Meta Ads (Facebook + Instagram) — official
```bash
claude mcp add --transport http --scope user meta https://mcp.meta.com/ads/sse
```

### HubSpot
```bash
claude mcp add --transport http --scope user hubspot https://mcp.hubspot.com/sse
```

### Salesforce
```bash
claude mcp add --transport http --scope user salesforce https://mcp.salesforce.com/sse
```

### Posthog
```bash
claude mcp add --scope user posthog "npx -y @posthog/mcp" \
  --env "POSTHOG_API_KEY=..." --env "POSTHOG_HOST=https://app.posthog.com"
```

### Plausible / Fathom / Simple Analytics
Most expose REST APIs cleanly enough that Claude can hit them via Bash + curl
without a dedicated MCP server.

---

## 9. AI / ML / Search

### HuggingFace Hub
Model search, dataset browsing, Spaces interactions.

```bash
claude mcp add --scope user huggingface "npx -y @huggingface/mcp-server" \
  --env "HF_TOKEN=hf_..."
```

### Vectara
Managed RAG / vector search for production semantic search.

```bash
claude mcp add --scope project vectara "npx -y @vectara/mcp-server" \
  --env "VECTARA_API_KEY=..." --env "VECTARA_CORPUS_ID=..."
```

### Pinecone
```bash
claude mcp add --scope project pinecone "npx -y @pinecone/mcp-server" \
  --env "PINECONE_API_KEY=..."
```

### Qdrant
```bash
claude mcp add --scope project qdrant "uvx mcp-server-qdrant" \
  --env "QDRANT_URL=..." --env "QDRANT_API_KEY=..."
```

### Sequential Thinking — reference server
Forces a structured reasoning loop. Useful for complex multi-step problems
where you want Claude to externalize each step.

```bash
claude mcp add --scope user thinking "npx -y @modelcontextprotocol/server-sequential-thinking"
```

---

## 10. Specialty / Niche

### Filesystem (use with caution)
Only install if you need Claude to access files *outside* your project root.
Inside the project, Claude Code's built-in Read/Write/Edit tools are
sufficient and safer.

```bash
claude mcp add --scope user fs "npx -y @modelcontextprotocol/server-filesystem /Users/you/scratch /Users/you/Documents"
```

Always scope to specific directories. Never pass `/` as a path.

### Memory (knowledge graph)
Persistent knowledge graph across sessions. Skip unless you're building
something cross-agent — Claude Code's CLAUDE.md and auto-memory cover most
single-developer workflows.

```bash
claude mcp add --scope user memory "npx -y @modelcontextprotocol/server-memory"
```

### Time
Timezone math, scheduling. Trivial; skip unless you've actually had Claude get
timezone arithmetic wrong.

```bash
claude mcp add --scope user time "uvx mcp-server-time"
```

### Apple Notes / Reminders (macOS)
Personal task wrangling, not for production code.

```bash
claude mcp add --scope user apple "npx -y @apple/mcp-server"
```

### Zapier
Bridge to ~7,000 apps via Zapier's natural-language action layer. Useful when
no native MCP exists and the alternative is writing your own wrapper.

```bash
claude mcp add --transport http --scope user zapier https://mcp.zapier.com/api/mcp/mcp
```

### n8n
Self-hosted alternative to Zapier with MCP support.

```bash
claude mcp add --scope user n8n "npx -y @n8n-io/n8n-mcp-server" \
  --env "N8N_API_KEY=..." --env "N8N_HOST=..."
```

---

## Project-tier picks (by stack)

Edit this section to match what you actually use. Everything else can be
deleted to keep the file lean.

### Web SaaS (Node + Postgres)
GitHub · Postgres · Sentry · Playwright · Context7

### E-commerce (Shopify + AWS)
GitHub · Shopify · AWS · Stripe · Klaviyo · Postgres (read-only on Redshift)

### Mobile + Backend
GitHub · Supabase or Firebase · Sentry · Linear · Context7

### Data / ML
GitHub · Postgres · Snowflake or BigQuery · HuggingFace · Sequential Thinking

### Infrastructure / DevOps
GitHub · AWS or Cloudflare · Kubernetes · Datadog · Terraform

---

## Discipline — read before installing more than 5 servers

- **Each server adds tool descriptions.** Even with Tool Search, more servers
  means slower tool selection. 30+ servers will visibly slow Claude Code's
  first response on every prompt.
- **Memory cost is real.** Each stdio server runs as a subprocess (~20–100MB).
  Ten servers = up to 1 GB of background processes when Claude Code is open.
- **Audit credentials quarterly.** A token you forgot you granted is a token
  you can't reason about. `claude mcp list` then prune.
- **Never commit `.mcp.json` with secrets.** Use `--env` references that
  read from your shell environment, and add `.claude/settings.local.json` to
  `.gitignore` (the init script does this already).
- **Watch for prompt injection.** Servers that ingest untrusted content
  (Fetch, browser tools, email readers, ticket trackers with public submission)
  can carry instructions an attacker wants Claude to execute. Treat their
  output as data, not commands.

---

## Debugging cheat sheet

```bash
claude mcp list                         # what's registered
claude mcp get <name>                   # full config + last error
claude mcp remove <name>                # clean up
claude mcp test <name>                  # verify a single server (v2.1+)

# Server hangs on first run? Run it manually to see auth prompts:
npx -y @scope/name                      # for stdio servers

# Server returns nothing? Check tool budget — Tool Search may have hidden it.
# Set alwaysLoad: true in the server config, or call /mcp from inside Claude
# Code to see what's loaded.

# Tool name collision? Two servers exporting `read_issue` etc.
# Use the tools field in `.mcp.json` to rename or filter.
```

If a server's tools should *always* be visible to Claude (no Tool Search
indirection), edit `.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "alwaysLoad": true
    }
  }
}
```

---

## Discovery

When you need a server not listed here:

- **Official registry:** https://github.com/modelcontextprotocol/servers
- **Anthropic-curated:** https://www.claudemcp.com/
- **Community lists:** `tolkonepiu/best-of-mcp-servers` (weekly-updated
  ranked list), `punkpeye/awesome-mcp-servers`, `mcp-awesome.com`,
  `popularaitools.ai`
- **Build your own:** the MCP TypeScript or Python SDK takes about an hour to
  go from zero to working server. Often the right answer when you have
  project-specific tools (run-smoke-test, get-feature-flag, query-our-warehouse).
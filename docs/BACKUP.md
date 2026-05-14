# Backup & Export

The `./data` directory (override with `DATA_DIR`) is the source of truth: it contains `pageguard.db` plus the `captures/` tree (screenshots + text content per URL). Everything else is reproducible from `config.yaml` and environment.

SQLite runs in WAL mode, so a naive `cp data/pageguard.db` while the app is running is **not** guaranteed consistent. Use one of the methods below.

## Online backup (SQLite, consistent)

While the app is running:

```bash
sqlite3 data/pageguard.db ".backup '/backup/path/pageguard.db'"
```

This uses SQLite's online backup API — safe with concurrent writers. It only covers the DB, not the captures on disk.

## Full backup via export endpoint

`GET /api/export` streams a tar.gz of the entire data directory (DB + captures) over HTTP. It's auth-protected (basic auth) and CSRF does **not** apply to GET requests, so a plain `curl` works:

```bash
curl -u admin:PASS -o backup.tar.gz https://your-host/api/export
```

The response streams; large data directories don't buffer in memory. Filename in the `Content-Disposition` header is `pageguard-backup-<ISO date>.tar.gz`.

For an externally-consistent snapshot, stop the container first.

## Recovery

```bash
docker compose down
# restore data/ from the backup (extract tar.gz or copy files into place)
tar -xzf backup.tar.gz -C ./data
docker compose up -d
```

The DB and captures must be restored together — capture rows reference on-disk paths.

## Retention

Disk usage grows unbounded by default. The cleanup job keeps, per monitored URL:

- The current reference capture
- The N most recent captures (`RETENTION_KEEP_PER_URL`, default 20)
- Any capture tied to an unacknowledged `change_event`

Everything else's screenshot + text file (and DB row) is deleted.

Trigger it manually via `POST /api/cleanup`. This endpoint is auth-protected **and** CSRF-protected — the global middleware requires the `x-csrf-token` header on state-changing requests. Fetch a token from any dashboard page (it's rendered into `res.locals.csrfToken` and embedded in forms), or pull it from the `pg.csrf` cookie pair via your browser's devtools, then:

```bash
curl -u admin:PASS \
  -H "x-csrf-token: $TOKEN" \
  --cookie "pg.csrf=$COOKIE" \
  -X POST https://your-host/api/cleanup
```

Response:

```json
{ "urls_processed": 6, "captures_deleted": 142, "bytes_freed": 38421120 }
```

Schedule via host cron or a sidecar — there's no built-in scheduler for cleanup yet.

# PageGuard REST API (v1)

The versioned REST API lives at `/api/v1/*`, parallel to the browser dashboard. It is authenticated with a static bearer token, separately from the dashboard's HTTP basic-auth. CSRF protection does not apply (bearer tokens are not auto-replayed by browsers).

## Authentication

Set `API_TOKEN` in `.env`:

```
API_TOKEN=a-long-random-string-please
```

If `API_TOKEN` is unset, every `/api/v1/*` request returns `503` with a message pointing at `.env.example`. There is **no** fallback to basic-auth.

Every request must include:

```
Authorization: Bearer <API_TOKEN>
```

Tokens are compared in constant time via `crypto.timingSafeEqual`.

## Status codes

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| 200  | Success                                                |
| 201  | Resource created                                       |
| 202  | Accepted (async-style, e.g. trigger-check)             |
| 400  | Bad input (returns `{ error, field? }`)                |
| 401  | Missing or wrong bearer token                          |
| 404  | Not found                                              |
| 500  | Internal error                                         |
| 503  | `API_TOKEN` not configured on the server               |

## Endpoints

| Method | Path                              | Description                                  |
| ------ | --------------------------------- | -------------------------------------------- |
| GET    | `/api/v1/health`                  | Always-200 health snapshot                   |
| GET    | `/api/v1/urls`                    | List URLs (`?limit=`, `?offset=`)            |
| POST   | `/api/v1/urls`                    | Add URL (SSRF-validated)                     |
| GET    | `/api/v1/urls/:id`                | URL + latest capture summary                 |
| DELETE | `/api/v1/urls/:id`                | Delete URL and its captures                  |
| POST   | `/api/v1/urls/:id/check`          | Trigger an immediate check                   |
| GET    | `/api/v1/events`                  | List change events (filters: `url_id`, `acknowledged`) |
| GET    | `/api/v1/events/:id`              | Single change event (incl. AI cost)          |
| POST   | `/api/v1/events/:id/acknowledge`  | Acknowledge an event                         |

See [openapi.yaml](./openapi.yaml) for full request/response schemas.

## Examples

List URLs:

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3000/api/v1/urls
```

Trigger an immediate check for URL `7`:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $API_TOKEN" \
  http://localhost:3000/api/v1/urls/7/check
```

Acknowledge change event `42`:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via":"api"}' \
  http://localhost:3000/api/v1/events/42/acknowledge
```

## Validation

Request bodies are validated strictly: unknown fields are rejected with `400 { error: "Unexpected field: X" }`. Missing or wrong-typed required fields return `400 { error: "...", field: "..." }`.

## Errors

All errors return JSON of the shape:

```json
{ "error": "human-readable message", "field": "optional-field-name" }
```

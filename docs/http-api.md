# HTTP API for assistants without MCP

Instinct, Fo, and anything else that can make web requests with a header can use this instead of MCP. It runs on the same Worker and is off until you set a token.

## Enable it

In Cloudflare, Worker, Settings, Runtime variables and secrets, Add variable. Key `API_TOKEN`, value a new random password of at least 24 characters, Secret checked, Add variable and deploy. Revoke access later by deleting or changing that secret.

## What to hand the assistant

Give the assistant three things:

1. The base address: `https://apple-calendar-mcp.<you>.workers.dev/api`
2. The token, to send as `Authorization: Bearer <API_TOKEN>` on every request.
3. This instruction: "Call GET /api first. It returns the list of routes and how to use them."

The assistant then holds a secret that can read and write your calendar. Give it only to assistants you trust with that.

## Routes

| Method | Path | What it does |
|---|---|---|
| GET | `/api` | Describes every route. |
| GET | `/api/profile` | Account email and default time zone. |
| GET | `/api/calendars` | Calendars and their ids. |
| GET | `/api/events?start=…&end=…` | Events in the window. Optional `calendarId` (repeatable), `query`, `limit`. |
| GET | `/api/availability?start=…&end=…&calendarId=…` | Busy windows for the given calendars. |
| POST | `/api/events` | Create an event. Body is JSON with `calendarId`, `title`, `start`, `end`, and the same optional fields as the MCP create tool. |
| GET | `/api/reminders` | Open reminders from the last iPhone sync, with `syncedAt` and `ageMinutes`. Optional `list`, `query`. |
| POST | `/api/reminders` | Queue a reminder: `{ "title", "list"?, "due"?, "notes"?, "priority"? }`. The iPhone creates it on its next sync. |

Times are ISO 8601 with an offset or `Z`. Errors come back as JSON with an `error` field: 400 for bad input (with `issues`), 401 for a bad token, 404 for an unknown route, 405 for a wrong method, 502 when iCloud or the sync layer fails.

## Example

```
curl -H "Authorization: Bearer $API_TOKEN" \
  "https://apple-calendar-mcp.<you>.workers.dev/api/events?start=2026-10-20T00:00:00-04:00&end=2026-10-21T00:00:00-04:00"
```

Updating or deleting events is MCP-only for now. Ask for it if an assistant needs it.

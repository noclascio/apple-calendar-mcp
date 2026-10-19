# Apple Calendar MCP

Give Claude, ChatGPT, and other compatible AI assistants remote read and write access to your iCloud calendars.

Apple Calendar MCP runs headlessly in your own Cloudflare account. You don't need a Mac or another computer hosting a local MCP server. Each deployment serves one Apple Account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nweii/apple-calendar-mcp)

## About this fork

This fork (`noclascio/apple-calendar-mcp`) was set up over one evening to give six personal AI agents (OpenAI Dots, Grok Bot, Fo, Hark, Instinct, plus Muse natively) read and write access to one person's Apple Calendar and Reminders with no Google account and no always-on Mac. It adds, on top of the upstream project:

- **Apple Reminders through the iPhone.** An iOS Shortcut posts open reminders to the Worker and creates reminders the agents queue. See [docs/reminders-shortcut.md](docs/reminders-shortcut.md), written step by step for iOS 27.
- **A plain HTTP API** for assistants that cannot speak MCP. See [docs/http-api.md](docs/http-api.md).
- **A fixed bearer token on the MCP endpoint** for clients that cannot finish OAuth.
- **Per-client connection notes** for ChatGPT and Dots, Grok Bot, Fo, Hark and Instinct, including the traps. See [docs/connect-agents.md](docs/connect-agents.md).
- **Three fixes found in live use:** the approval page's redirect was blocked by its own form-action policy for clients whose callback hops hosts (Grok Bot); long event searches failed with "Invalid time value" on some iCloud recurrence expansions; and events without an embedded time zone were read as UTC, shifting a noon appointment five hours. All fixed with tests.

Secrets live only in Cloudflare. Nothing account-specific is in this repository.

## Features

- **Remote calendar access from anywhere.** Connect compatible AI clients over HTTPS using a Cloudflare `workers.dev` address or your own custom domain.
- **Self-hosted and under your control.** Runs in your Cloudflare account. You control the server, credentials, and which clients can access your calendars.
- **Configurable permissions.** Give each client read-only access to search events and check availability, or write access to create, edit, and delete events and respond to invitations.
- **Locations with Apple Calendar map previews.** Events created or edited by an AI assistant can include a place name, address, and verified coordinates so Apple Calendar displays its map preview.
- **Time zones and recurring schedules.** Create one-off or recurring events with time zone support, notes, URLs, and alerts.

For guided setup, use the [agent setup prompt](docs/agent-setup-prompt.md).

## Before you deploy

You need:

- A Cloudflare account.
- An Apple Account with two-factor authentication.
- An MCP client that supports remote HTTPS servers and OAuth.
- Your [IANA time zone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), such as `America/New_York`.

An agent can guide you and verify setup without knowing your passwords. Sign in to Apple yourself and enter the app-specific password and approval password directly in Cloudflare.

## Create an Apple app-specific password

1. Open [account.apple.com](https://account.apple.com/) and sign in.
2. Select **Sign-In and Security > App-Specific Passwords**.
3. Select **Generate an app-specific password**.
4. Give it a clear label, such as `Apple Calendar MCP`.
5. Keep the generated value on the Apple page until Cloudflare asks for it.

Changing or resetting your main Apple Account password revokes all app-specific passwords. See [Apple's instructions](https://support.apple.com/102654) for generating and revoking them.

Apple doesn't let you restrict an app-specific password to Calendar. This server uses it only to access your calendars.

## Deploy to Cloudflare

1. Select **Deploy to Cloudflare** at the top of this page.
2. Sign in to Cloudflare and follow the deployment form.
3. Fill in the secret fields:
   - `ICLOUD_USERNAME`: the full email address used for your Apple Account and iCloud Calendar.
   - `ICLOUD_APP_PASSWORD`: the app-specific password that Apple generated.
   - `APPROVAL_PASSWORD`: a separate password for approving client connections. Choose one you don't use for Apple.
4. Change `CALENDAR_TIME_ZONE` from `UTC` to your IANA time zone name. Cloudflare cannot detect your time zone automatically.
5. Turn off **Protect with Cloudflare Access**. The built-in approval page handles client connections; that toggle can block them. To use Access instead, follow [Add Cloudflare Access](#add-cloudflare-access) after deployment.
6. Deploy the Worker and wait for the deployment to finish.
7. Copy the endpoint in this form: `https://<worker-name>.<account-subdomain>.workers.dev/mcp`.

Cloudflare stores these values as encrypted secrets, outside the generated repository.

If you skipped a secret or need to replace one, open **Workers & Pages**, select the Worker, select **Settings**, find **Variables and Secrets**, add or edit the value as a **Secret**, and select **Deploy**.

Cloudflare creates `OAUTH_KV` automatically to store client registrations and authorizations. It does not store calendar events.

## Connect an MCP client

1. Add the deployed `/mcp` endpoint as a custom remote MCP server or app.
2. Select **Connect**. Your client should discover OAuth and open the Apple Calendar MCP approval page.
3. Confirm the client name and requested permission.
4. Enter `APPROVAL_PASSWORD` and select **Allow and return**. Select **Cancel** if the page asks for more access than you want.
5. Wait for the client to report that the connection is complete. Close the browser tab if it remains open after completion.
6. Refresh or rescan the client's tools. Clients can cache tool catalogs after a connection or server update.

For Claude, see [Use custom connectors with remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). For ChatGPT, see [Developer mode and full MCP connectors](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

The approval page offers two permissions:

- **Read calendars and events** enables the seven read tools.
- **Read and edit calendars and events** also enables creation, editing, deletion, and invitation responses.

To change a client's permission, authorize it again and refresh its tools.

> [!WARNING]
> Write actions involving attendees or invitations can send email or notifications to other people.

## Verify the connection

Verify read access first:

1. Call `calendar_get_profile`. Confirm the Apple Account identity and time zone.
2. Call `calendar_list_calendars`. Confirm that the expected calendar names appear.
3. If you approved read-only access, confirm that the client does not show mutation tools.

A successful calendar read confirms that the Apple credential works. Connecting the client alone does not.

To test writes, create an empty temporary calendar in Apple Calendar and ask the agent to:

1. Create one future event with a unique title, no attendees, no recurrence, and no alerts.
2. Read the event and keep its current ETag.
3. Change only its title by using that ETag.
4. Read the event again and use the returned ETag to delete it.
5. Confirm that the event is absent.

Keep this test in the temporary calendar. If cleanup fails, have the agent give you the calendar, title, and time so you can remove the event yourself.

## Tools

| Tool | Scope | Purpose |
| --- | --- | --- |
| `calendar_get_profile` | `calendar:read` | Return the configured iCloud account identity and default time zone. |
| `calendar_list_calendars` | `calendar:read` | List visible calendars, effective time zones, and opaque IDs. |
| `calendar_search_events` | `calendar:read` | Search a bounded time range across calendars. |
| `calendar_list_events` | `calendar:read` | List a bounded time range from one calendar. |
| `calendar_get_event` | `calendar:read` | Read full event details and the current ETag. |
| `calendar_batch_get_events` | `calendar:read` | Read up to 20 events with per-event errors. |
| `calendar_get_availability` | `calendar:read` | Return merged busy windows without event details. |
| `calendar_create_event` | `calendar:write` | Create timed, all-day, recurring, invited, located, or alerted events. |
| `calendar_update_event` | `calendar:write` | Change one occurrence, this and later occurrences, or an entire series. |
| `calendar_delete_event` | `calendar:write` | Delete one occurrence, this and later occurrences, or an entire series. |
| `calendar_respond_to_invitation` | `calendar:write` | Accept, decline, or tentatively accept an invitation. |

Update, delete, and invitation-response tools require the latest ETag. Recurring occurrence changes also require the original `recurrenceId` returned by a search.

Timed inputs use RFC 3339 timestamps with `Z` or an explicit offset. Clients can omit `timeZone`; creation uses the calendar's published IANA time zone, then `CALENDAR_TIME_ZONE`. Timed outputs include UTC and local values.

`location` is the visible Calendar field. `structuredLocation` can add a title, address, latitude, longitude, and radius. Verified coordinates enable Apple Calendar's map preview. Do not guess coordinates.

`description` maps to Calendar Notes. `url` maps to the event URL field. The MCP preserves unsupported attachments and alarm types during unrelated changes, but it does not upload, download, or modify attachments. It does not import raw ICS.

## Use a custom domain

The default `workers.dev` address works without extra configuration. To use your own domain:

1. Open the Worker in Cloudflare.
2. Select **Settings > Domains & Routes > Add > Custom Domain** and add the hostname.
3. Under **Variables and Secrets**, add `MCP_HOSTNAME` as a plain-text variable. Enter only the hostname, such as `calendar.example.com`. Do not include `https://`, a path, a port, or credentials.
4. Deploy the setting.
5. Connect clients again at `https://<custom-host>/mcp` and complete authorization again.

Clients need to reconnect when you change the server's hostname.

## Add Cloudflare Access

Cloudflare Access can replace the approval password. Configure it after deployment: the form's **Previews only** option does not protect your live server, while **All traffic** can block client connections.

To replace the approval password with Access, deploy the Worker first. Then create a path-based Access application for `<hostname>/authorize`.

Leave `/mcp`, `/.well-known/*`, `/oauth/token`, and `/oauth/register` reachable by MCP clients. When Access protects `/authorize`, add `EXTERNAL_AUTHORIZATION=true` as a plain-text Worker variable.

To use Access without an approval password, delete `APPROVAL_PASSWORD` only after you deploy `EXTERNAL_AUTHORIZATION=true`. If both settings exist, users must pass both checks.

> [!WARNING]
> Set `EXTERNAL_AUTHORIZATION=true` only after Access protects `/authorize`. This setting disables the requirement for an approval password; it does not configure Access for you.

## Security

This is a self-hosted deployment in your Cloudflare account. You control its code, secrets, and connected clients, and you can update or disable it yourself. The project maintainer does not operate your server or receive your credentials or calendar data.

The Worker uses your Apple username and app-specific password to connect to iCloud. Cloudflare stores the credentials as encrypted secrets and runs the code that processes calendar requests. Calendar data passes through your Worker to the AI clients you authorize; those clients receive calendar results, not your Apple password.

`APPROVAL_PASSWORD` protects new client connections. Approval is unavailable unless a password is configured or you enable the Access configuration described above. Anyone who can pass this check can connect a client to the configured Apple Account.

> [!WARNING]
> Rotating `APPROVAL_PASSWORD` does not revoke OAuth tokens that were already issued.

OAuth credentials are stored as hashes in KV, with authorization properties encrypted. Client names and permission records remain readable. See the OAuth provider's [storage documentation](https://github.com/cloudflare/workers-oauth-provider#kv-storage-and-cleanup) for details.

The Worker sends Apple credentials only to approved iCloud Calendar hosts over HTTPS. Tool inputs cannot redirect those requests. Errors redact credentials, and the Worker does not log tool inputs or event contents.

Tool results can include titles, notes, locations, attendees, and URLs. MCP clients can retain this data under their own product and workspace policies.

Write access allows event creation, editing, deletion, and invitation responses. Updates check for newer edits before saving and preserve unsupported Apple properties when possible. Changes involving attendees can send notifications.

Review source changes before deploying updates, and connect only AI clients you trust.

### Revoke or rotate access

| Goal | Action | Result |
| --- | --- | --- |
| Stop one client | Disconnect or remove it in that client's settings. Use its revoke flow when available. | The client stops using its connection. |
| Stop new approvals | Rotate `APPROVAL_PASSWORD` or disable the Worker. | Existing OAuth tokens are unaffected. |
| Stop all Apple access immediately | Disable the Worker and revoke its app-specific password at [account.apple.com](https://account.apple.com/). | Calendar calls fail until you configure a new app-specific password. |
| Rotate normally | Create a new Apple app-specific password, replace `ICLOUD_APP_PASSWORD` in Cloudflare, verify a read call, then revoke the old password. | You verify the replacement before revocation and avoid downtime. |
| Recover after an Apple Account password reset | Create a new app-specific password and replace the Worker secret. | Apple already revoked the old app-specific password. |

If you suspect compromise, revoke the old Apple app-specific password first. Then replace it and verify access. This causes a short outage.

## Troubleshooting

- A `401` or iCloud password rejection usually means that the app-specific password is missing or revoked. Create or replace it in Apple and Cloudflare.
- Missing write tools usually mean that the client has a read-only grant or a cached tool catalog. Refresh tools, then disconnect and authorize again if needed.
- A custom domain that rejects `/mcp` usually has a missing or invalid `MCP_HOSTNAME`. Set the exact hostname and redeploy.
- An approval page that fails closed has neither `APPROVAL_PASSWORD` nor a declared external guard. Add the approval secret unless you have already verified Cloudflare Access on `/authorize`.

## Develop locally

```bash
bun install
cp .dev.vars.example .dev.vars
bun run test
bun run typecheck
bun run cloudflare:check
```

Keep `.dev.vars` local. Deploy with `bun run deploy`.

## License

[MIT](LICENSE)

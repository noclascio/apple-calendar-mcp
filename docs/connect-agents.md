# Connecting the agents (what actually worked, October 2026)

One Worker address serves every assistant. Replace `<you>` with your Cloudflare subdomain.

- MCP endpoint: `https://apple-calendar-mcp.<you>.workers.dev/mcp`
- HTTP API: `https://apple-calendar-mcp.<you>.workers.dev/api` (see `http-api.md`)

Two ways to authenticate on the MCP endpoint:

- **OAuth**: the client opens the Worker's approval page; you enter `APPROVAL_PASSWORD` and click Allow and return. Used by ChatGPT and Dots, Grok Bot, Fo.
- **Fixed token**: the client sends `Authorization: Bearer <API_TOKEN>`. Used by clients that cannot complete OAuth, such as Hark. Set `API_TOKEN` (24+ characters, Production) in the Worker's secrets first.

A note that applies to every MCP client: it reads the Worker's tool list once, when it connects, and caches it. After the Worker gains new tools, reconnect (remove and add again, or add again under a new name) and start a new conversation.

## ChatGPT and Dots

Do this on **chatgpt.com in a browser**, not in the ChatGPT Mac app. The Mac app has a settings page named MCPs (found by searching "mcp" in Settings) with fields for STDIO, command, arguments and working directory. That page configures Codex, the coding tool. Servers added there are invisible to Dots.

1. Left sidebar, **Plugins**, then **Browse directory**.
2. The add button at the top of the directory, then **Add custom MCP server** (also seen as Create MCP App).
3. Name `Apple Calendar`, Server URL the `/mcp` address, Authentication **OAuth**. Accept the risk notice.
4. The Worker's approval page opens. Enter `APPROVAL_PASSWORD`, Allow and return.
5. Start a **new** conversation with the dot. Ask it to call `calendar_get_profile`.

If a later Worker update adds tools and the old connector cannot be removed, add a second one named `Apple Calendar 2` with the same URL and tell the dot to use that.

## Grok Bot

The connector page at grok.com/connectors feeds Grok chat only. Grok Bot keeps its own list, and the way in is to ask the bot in chat:

```
Add a custom remote MCP server named "Apple Calendar" at https://apple-calendar-mcp.<you>.workers.dev/mcp. It uses OAuth. Register it, complete the sign-in, then call calendar_get_profile.
```

The sign-in card opens the Worker's approval page. Enter the password, Allow and return.

Two Grok Bot specifics:

- The original upstream approval page returned you with an HTTP redirect, and the page's own `form-action` security rule blocked it once Cursor's callback hopped from `www.cursor.com` to `cursor.com`, so the Allow button spun forever. This fork returns a small "Connected" page that navigates by script instead, which fixed it.
- Grok Bot's connector badge can keep saying "needs auth" after the connection works. Judge by whether `calendar_get_profile` returns your account.

## Fo (Wajo)

Give Fo the `/mcp` address and say it uses OAuth. It connects, opens the approval page, and pulls the tool list.

## Hark

Hark cannot complete an OAuth sign-in but accepts a fixed token. Give it the `/mcp` address and, through its secure form, the `API_TOKEN`. Same tools as everyone else.

## Folk

Folk stores credentials in its vault as a username and password pair and sends them as an HTTP Basic login. Open the secure link it gives you, enter any word as the username (for example `token`) and `API_TOKEN` as the password, and save. The Worker accepts the Basic form with any username when the password matches `API_TOKEN`.

## Instinct

Instinct does not speak MCP but can call a web API with a header. Give it:

1. The base address `https://apple-calendar-mcp.<you>.workers.dev/api`
2. `API_TOKEN`, to send as `Authorization: Bearer` on every request, through its secure link
3. The instruction "Call GET /api first; it lists the routes."

Instinct found two real bugs in the upstream parser within an hour of connecting (see the README's fork notes), so it is a useful tester as well as a client.

## Muse and the Claude iOS app

Neither needs this bridge. Muse reads Calendar, Reminders, Health and Home natively on iPhone and acts inside Calendar, Mail and Messages on the Mac. The Claude iOS app has native Calendar and Reminders access. Both are unaffected by anything here.

## Cloudflare deployment notes

The path that worked, as opposed to the Deploy button:

1. Cloudflare dashboard, Workers & Pages, Create, connect the GitHub repository (your fork), keep the defaults, Deploy.
2. The first build fails with "required secrets have not been set". That is expected: the form offers no place for them. Go to the Worker, Settings, **Runtime variables and secrets**, Add variable, and add `ICLOUD_USERNAME`, `ICLOUD_APP_PASSWORD`, `APPROVAL_PASSWORD` as Secrets under Production. Save with deploy.
3. If the next build fails with "a namespace with this account ID and title already exists", the first run already created the KV namespace. Delete it under Storage & databases, KV, and retry the build.
4. Every bearer secret (`API_TOKEN`, `SHORTCUT_TOKEN`) must be at least 24 characters, or the Worker reports the feature as disabled.
5. Turn **off** "Protect with Cloudflare Access" on the Worker. The approval page handles client access; Access blocks the clients.

Time zone: set `CALENDAR_TIME_ZONE` in `wrangler.jsonc` (this fork ships `America/New_York`). A dashboard variable of the same name is overwritten by the file on every deploy.

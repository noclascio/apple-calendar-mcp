// Renders the OAuth approval and error surfaces, then completes requests behind a built-in or external authorization guard.

import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";

type AuthorizeEnv = Pick<Env, "OAUTH_PROVIDER" | "EXTERNAL_AUTHORIZATION" | "APPROVAL_PASSWORD">;

export type AuthorizationGuard = "disabled" | "external" | "password" | "external-and-password";

const SUPPORTED_SCOPES = new Set(["calendar:read", "calendar:write"]);

interface PageOptions {
  content: string;
  formActionOrigins?: string[];
  status?: number | undefined;
  script?: string;
  title: string;
}

const pageStyles = `
:root{color-scheme:light;--canvas:#fafafa;--surface:#fff;--surface-muted:#f5f5f4;--ink:#282828;--muted:#777;--line:#dededc;--accent:#287cf0;--accent-hover:#1f70df;--danger:#b42318;--danger-soft:#fff2f0;--shadow:0 18px 46px rgba(0,0,0,.09),0 2px 6px rgba(0,0,0,.05);--ease-out:cubic-bezier(.23,1,.32,1)}
*{box-sizing:border-box}html{min-height:100%;background:var(--canvas)}body{min-height:100vh;margin:0;padding:1.25rem;display:grid;place-items:center;color:var(--ink);font:400 .9375rem/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.shell{width:min(100%,27rem)}.brand{display:flex;align-items:center;gap:.6rem;margin:0 0 .75rem .15rem;color:var(--muted);font-size:inherit;font-weight:600}.brand-mark{display:grid;place-items:center;width:1.75rem;height:1.75rem;border:1px solid var(--line);border-radius:.5rem;color:var(--ink);background:var(--surface)}
.card{padding:1.5rem;border:1px solid var(--line);border-radius:1rem;background:var(--surface);box-shadow:var(--shadow);animation:card-in 200ms var(--ease-out) both}.title{margin:0;font-size:inherit;line-height:1.5;font-weight:650}.lede{margin:.45rem 0 0;color:var(--muted);font-size:inherit}.permission{margin:1.25rem 0 0;padding:1rem;border-radius:.75rem;background:var(--surface-muted)}.permission-title{display:flex;align-items:center;gap:.55rem;font-weight:600}.permission-icon{display:grid;place-items:center;width:1.25rem;height:1.25rem;color:var(--accent)}.permission-copy{margin:.3rem 0 0 1.8rem;color:var(--muted)}
.field{margin-top:1.25rem}.field label{display:block;margin-bottom:.4rem;font-size:inherit;font-weight:600}.field input{width:100%;padding:.6rem .7rem;border:1px solid #aaa;border-radius:.55rem;color:var(--ink);background:var(--surface);font:inherit;outline:0;transition:border-color 130ms ease,box-shadow 130ms ease}.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 15%,transparent)}.error{margin:1rem 0 0;padding:.7rem .8rem;border-radius:.55rem;color:var(--danger);background:var(--danger-soft)}
.actions{display:flex;gap:.55rem;margin-top:1.25rem}.button{position:relative;display:inline-flex;min-height:2.35rem;align-items:center;justify-content:center;padding:.5rem .85rem;border:1px solid var(--line);border-radius:.55rem;font:inherit;font-weight:550;cursor:pointer;transition:transform 130ms var(--ease-out),background-color 130ms ease,border-color 130ms ease,box-shadow 130ms ease}.button:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 22%,transparent);outline-offset:2px}.button:active{transform:scale(.975)}.button--primary{min-width:8.5rem;border-color:var(--accent);color:#fff;background:var(--accent);box-shadow:0 2px 5px color-mix(in srgb,var(--accent) 22%,transparent)}.button--secondary{color:var(--ink);background:var(--surface)}.button-label,.button-progress{transition:opacity 140ms ease,transform 160ms var(--ease-out)}.button-progress{position:absolute;display:flex;align-items:center;gap:.45rem;opacity:0;transform:translateY(.2rem)}.spinner{width:.85rem;height:.85rem;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin 650ms linear infinite}.actions[data-submitting=true]{pointer-events:none}.actions[data-submitting=true] .button-label{opacity:0;transform:translateY(-.2rem)}.actions[data-submitting=true] .button-progress{opacity:1;transform:translateY(0)}
.fine-print{margin:1rem 0 0;color:var(--muted);font-size:inherit}.message-icon{display:grid;place-items:center;width:2rem;height:2rem;margin-bottom:1rem;border:1px solid var(--line);border-radius:.6rem;color:var(--ink);background:var(--surface-muted)}.message-code{margin-top:1rem;color:var(--muted);font:600 .9375rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.close-note{margin:1.15rem 0 0;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted)}
@media (hover:hover) and (pointer:fine){.button--primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}.button--secondary:hover{background:var(--surface-muted)}}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--canvas:#151515;--surface:#1e1e1e;--surface-muted:#282828;--ink:#f0f0ef;--muted:#aaa;--line:#3d3d3b;--accent:#5a9df8;--accent-hover:#71aaf8;--danger:#ff9187;--danger-soft:#392321;--shadow:0 20px 50px rgba(0,0,0,.32)}.field input{border-color:#555}.button--primary{color:#101820}}
@media (max-width:24rem){body{padding:1rem}.card{padding:1.25rem}.actions{display:grid}.button{width:100%}}
@media (prefers-reduced-motion:reduce){.card{animation:fade-in 140ms ease both}.button,.button-label,.button-progress{transition-duration:0ms}.button:active{transform:none}.spinner{animation-duration:1.2s}}
@keyframes card-in{from{opacity:0;transform:translateY(.35rem) scale(.99)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes fade-in{from{opacity:0}to{opacity:1}}@keyframes spin{to{transform:rotate(360deg)}}`;

export function authorizationGuard(env: Pick<AuthorizeEnv, "EXTERNAL_AUTHORIZATION" | "APPROVAL_PASSWORD">): AuthorizationGuard {
  const external = env.EXTERNAL_AUTHORIZATION === "true";
  const password = Boolean(env.APPROVAL_PASSWORD);
  if (external && password) return "external-and-password";
  if (password) return "password";
  if (external) return "external";
  return "disabled";
}

export async function secretsEqual(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [candidateDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const candidateBytes = new Uint8Array(candidateDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < candidateBytes.length; index += 1) difference |= candidateBytes[index]! ^ expectedBytes[index]!;
  return difference === 0;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function page(options: PageOptions): Response {
  const nonce = crypto.randomUUID();
  const script = options.script ? `<script nonce="${nonce}">${options.script}</script>` : "";
  const formAction = ["'self'", ...(options.formActionOrigins ?? [])].join(" ");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escape(options.title)}</title><style>${pageStyles}</style></head><body><div class="shell"><div class="brand"><span class="brand-mark" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg></span>Apple Calendar MCP</div>${options.content}</div>${script}</body></html>`,
    {
      status: options.status ?? 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; script-src 'nonce-${nonce}'`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export function approvalPage(options: {
  action: string;
  clientName: string;
  redirectOrigin?: string;
  passwordRequired: boolean;
  writeRequested?: boolean;
  error?: string;
  status?: number;
}): Response {
  const clientName = escape(options.clientName);
  const password = options.passwordRequired
    ? `<div class="field"><label for="password">Approval password</label><input id="password" name="password" type="password" autocomplete="current-password" required${options.error ? " autofocus" : ""}></div>`
    : "";
  const error = options.error ? `<p class="error" role="alert">${escape(options.error)}</p>` : "";
  const permissionTitle = options.writeRequested ? "Read and edit calendars, events, and reminders" : "Read calendars, events, and reminders";
  const permissionCopy = options.writeRequested
    ? `${clientName} can create, change, delete, and respond to events, and queue new reminders. Invitations and responses may notify other people.`
    : `${clientName} cannot create, edit, or delete anything.`;
  const content = `<main class="card"><h1 class="title">Share Apple Calendar with ${clientName}?</h1><p class="lede">Approve this connection to your iCloud calendars.</p><div class="permission"><div class="permission-title"><span class="permission-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><path d="m5 12 4 4L19 6"/></svg></span>${permissionTitle}</div><p class="permission-copy">${permissionCopy}</p></div>${error}<form method="post" action="${escape(options.action)}">${password}<div class="actions"><button class="button button--primary" type="submit" name="decision" value="allow"><span class="button-label">Allow and return</span><span class="button-progress" aria-live="polite"><span class="spinner" aria-hidden="true"></span>Returning…</span></button><button class="button button--secondary" type="submit" name="decision" value="deny" formnovalidate>Cancel</button></div></form><p class="fine-print">You can revoke access later from ${clientName}.</p></main>`;
  return page({
    content,
    formActionOrigins: options.redirectOrigin ? [options.redirectOrigin] : [],
    status: options.status,
    title: "Connect Apple Calendar",
    script: `document.querySelector("form")?.addEventListener("submit",event=>{if(event.submitter?.value!=="allow")return;const actions=document.querySelector(".actions");actions?.setAttribute("data-submitting","true");actions?.setAttribute("aria-busy","true")})`,
  });
}

export function supportedAuthorizationScopes(requested: readonly string[]): string[] {
  return requested.filter((scope) => SUPPORTED_SCOPES.has(scope));
}

function messagePage(title: string, message: string, status: number, code?: string): Response {
  const codeLine = code ? `<p class="message-code">${escape(code)}</p>` : "";
  const content = `<main class="card"><div class="message-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 17h.01"/></svg></div><h1 class="title">${escape(title)}</h1><p class="lede">${escape(message)}</p>${codeLine}<p class="close-note">Close this window and restart the connection from your MCP client.</p></main>`;
  return page({ content, status, title });
}

function authorizationError(error: AuthorizationError): Response {
  if (!error.redirectUri) return messagePage("Connection request rejected", error.description, 400, error.code);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 303);
}

function deniedAuthorization(oauthRequest: AuthRequest): Response {
  const redirect = new URL(oauthRequest.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", "The calendar owner denied the request.");
  if (oauthRequest.state) redirect.searchParams.set("state", oauthRequest.state);
  if (oauthRequest.issuer) redirect.searchParams.set("iss", oauthRequest.issuer);
  return Response.redirect(redirect, 303);
}

export const defaultHandler: ExportedHandler<AuthorizeEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const guard = authorizationGuard(env);
    if (url.pathname === "/") return Response.json({ service: "Apple Calendar MCP", mcp: "/mcp", authorization: guard });
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    if (guard === "disabled") {
      return messagePage("Authorization is unavailable", "This server needs an approval password or a verified external authorization guard.", 503, "authorization_guard_missing");
    }

    let oauthRequest: AuthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizationError(error);
      throw error;
    }

    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) return messagePage("Unknown client", "The requesting application is not registered with this calendar server.", 400, "unknown_oauth_client");
    const grantedScopes = supportedAuthorizationScopes(oauthRequest.scope);
    if (!grantedScopes.includes("calendar:read")) return messagePage("Permission unavailable", "This connection did not request the required calendar permission.", 400, "calendar_read_required");

    const clientName = client.clientName ?? "Unknown client";
    const action = `${url.pathname}?${url.searchParams.toString()}`;
    const redirectOrigin = new URL(oauthRequest.redirectUri).origin;
    const passwordRequired = Boolean(env.APPROVAL_PASSWORD);
    const writeRequested = grantedScopes.includes("calendar:write");
    if (request.method === "GET") return approvalPage({ action, clientName, redirectOrigin, passwordRequired, writeRequested });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });

    const form = await request.formData();
    if (form.get("decision") === "deny") return deniedAuthorization(oauthRequest);
    if (form.get("decision") !== "allow") return messagePage("Invalid response", "The approval form did not include a valid decision.", 400, "invalid_approval_decision");
    if (env.APPROVAL_PASSWORD && !(await secretsEqual(String(form.get("password") ?? ""), env.APPROVAL_PASSWORD))) {
      return approvalPage({ action, clientName, redirectOrigin, passwordRequired, writeRequested, error: "That approval password is incorrect.", status: 401 });
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: "calendar-owner",
      metadata: { clientName: client.clientName },
      scope: grantedScopes,
      props: { userId: "calendar-owner", scopes: grantedScopes },
    });
    const redirect = new URL(redirectTo);
    console.info("oauth_authorization_approved", { clientName, redirectHost: redirect.host, redirectPath: redirect.pathname });
    return returnPage(clientName, redirect);
  },
};

// Completes the approval with a script-driven navigation rather than a 303.
// A form POST's redirect chain is subject to the page's form-action policy, so a client callback
// that hops across hosts (for example www.cursor.com -> cursor.com) is blocked and the form spins.
// Navigating from script is not subject to form-action, and the link is a fallback without script.
export function returnPage(clientName: string, redirect: URL): Response {
  const href = redirect.href;
  const safeClient = escape(clientName);
  const content = `<main class="card"><div class="message-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><path d="m5 12 4 4L19 6"/></svg></div><h1 class="title">Connected</h1><p class="lede">Returning you to ${safeClient}.</p><p class="close-note">If nothing happens, <a href="${escape(href)}" rel="noreferrer">return to ${safeClient}</a>.</p></main>`;
  return page({
    content,
    title: "Apple Calendar connected",
    script: `location.replace(${JSON.stringify(href)})`,
  });
}

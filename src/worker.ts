// Composes Cloudflare OAuth with the stateless Apple Calendar MCP endpoint.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { defaultHandler, presentedSecret, secretsEqual } from "./authorize";
import { createCalendarMcpHandler } from "./mcp";
import { handleApi, isApiRoute } from "./api";
import { handleShortcut, isShortcutRoute } from "./shortcut";
import { publicError } from "./security";

interface AuthProps {
  userId: string;
  scopes: string[];
}

class McpApiHandler extends WorkerEntrypoint<Env, AuthProps> {
  fetch(request: Request): Promise<Response> {
    if (!this.ctx.props.scopes.includes("calendar:read")) {
      return Promise.resolve(new Response("Insufficient scope", { status: 403 }));
    }
    return createCalendarMcpHandler(this.env, this.ctx.props.scopes)(request, this.env, this.ctx);
  }
}

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["calendar:read", "calendar:write"],
  resourceMetadata: {
    scopes_supported: ["calendar:read", "calendar:write"],
    resource_name: "Apple Calendar",
  },
  clientIdMetadataDocumentEnabled: true,
  allowPlainPKCE: false,
  allowImplicitFlow: false,
  tokenExchangeCallback: ({ clientId, grantType }) => {
    const clientKind = URL.canParse(clientId) ? new URL(clientId).hostname : "dynamically-registered";
    console.info("oauth_token_exchange", { clientKind, grantType });
  },
  onError: ({ code, internal, status }) => {
    console.warn("oauth_provider_error", { code, internalCategory: internal?.category, status });
  },
});

// The iPhone Shortcut endpoint and the plain HTTP API authenticate with their own bearer secrets and never reach OAuth.
const FULL_SCOPES = ["calendar:read", "calendar:write"];
const MIN_TOKEN_LENGTH = 24;

// Clients that cannot complete OAuth may present API_TOKEN on /mcp instead, as a bearer token or as the
// password of a Basic login with any username.
// A match grants both scopes; anything else falls through to the OAuth provider untouched.
async function presentsApiToken(request: Request, env: Env): Promise<boolean> {
  const configured = env.API_TOKEN;
  if (!configured || configured.length < MIN_TOKEN_LENGTH) return false;
  const presented = presentedSecret(request);
  if (!presented) return false;
  return secretsEqual(presented, configured);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (isShortcutRoute(url)) return handleShortcut(request, env);
  if (isApiRoute(url)) return handleApi(request, env);
  if (url.pathname === "/mcp" && (await presentsApiToken(request, env))) {
    return createCalendarMcpHandler(env, FULL_SCOPES)(request, env, ctx);
  }
  return oauthProvider.fetch(request, env, ctx);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      // Never surface Cloudflare's generic 1101 page: log the reason by path and return a readable error.
      const reason = publicError(error);
      console.error("unhandled_exception", { path: new URL(request.url).pathname, method: request.method, reason });
      return Response.json({ error: "The calendar bridge hit an unexpected error.", reason }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  },
} satisfies ExportedHandler<Env>;

// Composes Cloudflare OAuth with the stateless Apple Calendar MCP endpoint.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { defaultHandler, secretsEqual } from "./authorize";
import { createCalendarMcpHandler } from "./mcp";
import { handleApi, isApiRoute } from "./api";
import { handleShortcut, isShortcutRoute } from "./shortcut";

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

// Clients that cannot complete OAuth may present API_TOKEN as a bearer token on /mcp instead.
// A match grants both scopes; anything else falls through to the OAuth provider untouched.
async function presentsApiToken(request: Request, env: Env): Promise<boolean> {
  const configured = env.API_TOKEN;
  if (!configured || configured.length < MIN_TOKEN_LENGTH) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  if (!match?.[1]) return false;
  return secretsEqual(match[1], configured);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isShortcutRoute(url)) return handleShortcut(request, env);
    if (isApiRoute(url)) return handleApi(request, env);
    if (url.pathname === "/mcp" && (await presentsApiToken(request, env))) {
      return createCalendarMcpHandler(env, FULL_SCOPES)(request, env, ctx);
    }
    return oauthProvider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

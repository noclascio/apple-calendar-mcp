// Composes Cloudflare OAuth with the stateless Apple Calendar MCP endpoint.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { defaultHandler } from "./authorize";
import { createCalendarMcpHandler } from "./mcp";
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

// The iPhone Shortcut endpoint authenticates with its own bearer secret and never reaches OAuth.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (isShortcutRoute(new URL(request.url))) return handleShortcut(request, env);
    return oauthProvider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

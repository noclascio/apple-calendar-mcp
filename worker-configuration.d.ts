// Declares the bindings available to the Worker and its workerd tests.
interface Env {
  OAUTH_KV: KVNamespace;
  REMINDERS_KV?: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  MCP_HOSTNAME?: string;
  CALENDAR_TIME_ZONE: string;
  EXTERNAL_AUTHORIZATION?: string;
  APPROVAL_PASSWORD?: string;
  SHORTCUT_TOKEN?: string;
  API_TOKEN?: string;
  ICLOUD_USERNAME: string;
  ICLOUD_APP_PASSWORD: string;
}

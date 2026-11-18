// Shopify Admin API client for ONE store: authentication and the single
// GraphQL call every tool goes through.
//
// Configuration:
//   SHOPIFY_STORE_DOMAIN     the store, "example" or "example.myshopify.com"
//   SHOPIFY_API_VERSION      optional, default below
// and one of two ways to authenticate (the client credentials win when both
// are set, because that is the only kind of app Shopify still lets you create):
//   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
//       an app from the Dev Dashboard, installed on the store. The server
//       trades them for a 24-hour access token and renews it before it expires.
//       Works only when the app and the store are in the same Shopify
//       organisation.
//   SHOPIFY_ACCESS_TOKEN
//       the Admin API token of a custom app created in the store admin
//       ("shpat_…"). It does not expire.
//
// Optional:
//   SHOPIFY_WRITE_TOOLS        "1" lets mutations through. Off when unset.
//   SHOPIFY_ALLOWED_MUTATIONS  which ones, comma-separated; a default list when unset.
//
// What the server may touch is decided by the access scopes the store granted
// the app. On top of that every document passes a gate in logic.ts: query()
// refuses anything that is not a pure read, and mutate() refuses anything
// while writing is off and anything outside the allowlist while it is on.

import {
  assertMutationAllowed, assertReadOnly, formatGraphqlErrors, normalizeStoreDomain, parseAllowedMutations, writeEnabled,
} from "./logic.js";

/** Shopify releases a version each quarter and supports it for at least a year. */
export const DEFAULT_API_VERSION = "2026-10";

const REQUEST_TIMEOUT_MS = 30_000;
/** Renew this long before the token runs out, so a call never starts with a token about to die. */
const RENEW_MARGIN_MS = 60_000;

/** Minimal HTTP signature: what tests inject. `body` is sent as given. */
export type RequestFn = (opts: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number; data: any }>;

export interface ShopifyClient {
  /** The store this client is bound to, "example.myshopify.com". */
  readonly storeDomain: string;
  /** Runs one read query against the Admin GraphQL API and returns its `data`. */
  query<T = any>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** Whether mutate() is switched on for this client. */
  readonly writeTools: boolean;
  /** The mutation names and prefixes mutate() lets through. */
  readonly allowedMutations: string[];
  /** Runs one allowed mutation and returns its `data` (which carries Shopify's userErrors). */
  mutate<T = any>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface ShopifyClientOptions {
  storeDomain?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  apiVersion?: string;
  /** Overrides SHOPIFY_WRITE_TOOLS. */
  writeTools?: boolean;
  /** Overrides SHOPIFY_ALLOWED_MUTATIONS. */
  allowedMutations?: string[];
  /** Injectable clock, for the token-renewal tests. */
  now?: () => number;
}

export const defaultRequestFn: RequestFn = async ({ url, method, headers, body }) => {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { status: res.status, data };
};

export function createShopifyClient(
  request: RequestFn = defaultRequestFn,
  options: ShopifyClientOptions = {},
): ShopifyClient {
  // Resolved on first use, not at construction: importing or building the
  // client must not demand configuration (the chassis puts secrets in the
  // environment just before the first request).
  const settings = () => {
    const domain = normalizeStoreDomain(options.storeDomain ?? process.env.SHOPIFY_STORE_DOMAIN ?? "");
    return {
      domain,
      version: options.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION,
      clientId: options.clientId ?? process.env.SHOPIFY_CLIENT_ID,
      clientSecret: options.clientSecret ?? process.env.SHOPIFY_CLIENT_SECRET,
      accessToken: options.accessToken ?? process.env.SHOPIFY_ACCESS_TOKEN,
    };
  };
  const now = options.now ?? Date.now;

  let cached: { token: string; expiresAt: number } | null = null;
  let renewing: Promise<string> | null = null;

  async function exchange(s: ReturnType<typeof settings>): Promise<string> {
    const { status, data } = await request({
      url: `https://${s.domain}/admin/oauth/access_token`,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: s.clientId!,
        client_secret: s.clientSecret!,
      }).toString(),
    });
    if (status !== 200 || !data?.access_token) {
      // Never echo the response body: on some failures it repeats the request.
      const reason = typeof data?.error === "string" ? `: ${data.error}` : "";
      throw new Error(
        `Shopify refused the app's credentials (HTTP ${status}${reason}). Check that the app is installed on ` +
        `${s.domain} and belongs to the same Shopify organisation as the store.`,
      );
    }
    const lifetimeMs = (Number(data.expires_in) || 86_399) * 1000;
    cached = { token: data.access_token, expiresAt: now() + lifetimeMs };
    return cached.token;
  }

  async function token(s: ReturnType<typeof settings>, forceNew = false): Promise<string> {
    if (!s.clientId || !s.clientSecret) {
      if (s.accessToken) return s.accessToken;
      throw new Error("Shopify credentials are not set: SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, or SHOPIFY_ACCESS_TOKEN");
    }
    if (!forceNew && cached && cached.expiresAt - now() > RENEW_MARGIN_MS) return cached.token;
    // One exchange at a time: concurrent tool calls share it.
    renewing ??= exchange(s).finally(() => { renewing = null; });
    return renewing;
  }

  async function send(s: ReturnType<typeof settings>, accessToken: string, body: string) {
    return request({
      url: `https://${s.domain}/admin/api/${s.version}/graphql.json`,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": accessToken },
      body,
    });
  }

  const writeTools = () => options.writeTools ?? writeEnabled(process.env.SHOPIFY_WRITE_TOOLS);
  const allowedMutations = () => options.allowedMutations ?? parseAllowedMutations(process.env.SHOPIFY_ALLOWED_MUTATIONS);

  return {
    get storeDomain() {
      return settings().domain;
    },
    get writeTools() {
      return writeTools();
    },
    get allowedMutations() {
      return allowedMutations();
    },

    async query(query, variables) {
      assertReadOnly(query);
      return execute(query, variables);
    },

    async mutate(query, variables) {
      if (!writeTools()) throw new Error("Writing is not enabled on this server.");
      assertMutationAllowed(query, allowedMutations());
      return execute(query, variables);
    },
  };

  /** Sends a document that has already passed its gate. Not reachable from outside. */
  async function execute(query: string, variables?: Record<string, unknown>) {
    const s = settings();
    const body = JSON.stringify(variables ? { query, variables } : { query });
    let res = await send(s, await token(s), body);
    // A token revoked or rotated early: get a new one once, then give up.
    if (res.status === 401 && s.clientId && s.clientSecret) {
      res = await send(s, await token(s, true), body);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Shopify rejected the access token (HTTP ${res.status}). The app may have been uninstalled from ${s.domain}.`);
    }
    if (res.status === 404) {
      throw new Error(`Shopify answered 404 for ${s.domain} with API version ${s.version}. Check the store domain and SHOPIFY_API_VERSION.`);
    }
    if (res.status === 429) throw new Error("Shopify is rate limiting this app. Wait a few seconds and try again.");
    if (res.status >= 400) throw new Error(`Shopify request failed (HTTP ${res.status})`);
    if (res.data?.errors) throw new Error(formatGraphqlErrors(res.data.errors));
    return res.data?.data;
  }
}

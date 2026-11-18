// Server tests: drive the real MCP wire (in-memory transport) against a mocked
// HTTP function. Proves tool registration, the URL, headers and body sent to
// Shopify, token exchange and renewal, the read-only gate, and the response
// mapping, without network or credentials.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createShopifyServer } from "../src/server.js";
import { createShopifyClient, type RequestFn, type ShopifyClientOptions } from "../src/shopify.js";

type Call = Parameters<RequestFn>[0];
type Reply = { status?: number; data: unknown };

const STATIC: ShopifyClientOptions = { storeDomain: "example", accessToken: "shpat_static", apiVersion: "2026-10" };
const APP: ShopifyClientOptions = { storeDomain: "example", clientId: "cid", clientSecret: "csecret", apiVersion: "2026-10" };
const TOKEN_URL = "https://example.myshopify.com/admin/oauth/access_token";
const GRAPHQL_URL = "https://example.myshopify.com/admin/api/2026-10/graphql.json";

function fixture(respond: (call: Call, n: number) => Reply, options: ShopifyClientOptions = STATIC) {
  const calls: Call[] = [];
  const request: RequestFn = async (call) => {
    calls.push(call);
    const r = respond(call, calls.length);
    return { status: r.status ?? 200, data: r.data };
  };
  return { client: createShopifyClient(request, options), calls };
}

async function connect(client: ReturnType<typeof createShopifyClient>) {
  const server = createShopifyServer(client);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), mcp.connect(clientT)]);
  return mcp;
}

const text = (r: any) => r.content[0].text as string;
const parse = (r: any) => JSON.parse(text(r));
const sent = (call: Call) => JSON.parse(call.body);

describe("shopify MCP server", () => {
  it("registers six tools, all marked read-only", async () => {
    const mcp = await connect(fixture(() => ({ data: {} })).client);
    const { tools } = await mcp.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      "get_shop", "graphql_introspect", "graphql_query", "list_orders", "list_products", "run_analytics_query",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("get_shop sends the static token and returns the store with its scopes", async () => {
    const { client, calls } = fixture(() => ({ data: { data: {
      shop: { name: "Example", myshopifyDomain: "example.myshopify.com", primaryDomain: { host: "example.com" }, currencyCode: "SEK", ianaTimezone: "Europe/Stockholm", weightUnit: "KILOGRAMS" },
      currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "read_orders" }] },
    } } }));
    const mcp = await connect(client);
    expect(parse(await mcp.callTool({ name: "get_shop", arguments: {} }))).toEqual({
      name: "Example", myshopify_domain: "example.myshopify.com", primary_domain: "example.com",
      currency: "SEK", timezone: "Europe/Stockholm", weight_unit: "KILOGRAMS",
      access_scopes: ["read_orders", "read_products"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GRAPHQL_URL);
    expect(calls[0]!.headers["x-shopify-access-token"]).toBe("shpat_static");
  });

  it("list_orders passes filter, sort and page size as variables", async () => {
    const { client, calls } = fixture(() => ({ data: { data: { orders: { nodes: [], pageInfo: { hasNextPage: false } } } } }));
    const mcp = await connect(client);
    const out = parse(await mcp.callTool({ name: "list_orders", arguments: {
      query: "financial_status:paid", sort_key: "CREATED_AT", reverse: true, first: 500, after: "cur",
    } }));
    expect(out).toEqual({ orders: [], has_next_page: false });
    expect(sent(calls[0]!).variables).toEqual({ first: 100, after: "cur", query: "financial_status:paid", sortKey: "CREATED_AT", reverse: true });
  });

  it("list_products defaults to 25 and maps the rows", async () => {
    const { client, calls } = fixture(() => ({ data: { data: { products: {
      nodes: [{ id: "gid://shopify/Product/1", title: "Ladder", priceRangeV2: { minVariantPrice: { amount: "10.0", currencyCode: "SEK" }, maxVariantPrice: { amount: "10.0", currencyCode: "SEK" } } }],
      pageInfo: { hasNextPage: true, endCursor: "next" },
    } } } }));
    const mcp = await connect(client);
    const out = parse(await mcp.callTool({ name: "list_products", arguments: {} }));
    expect(out).toMatchObject({ products: [{ title: "Ladder", price_min: { amount: 10, currency: "SEK" } }], has_next_page: true, next_cursor: "next" });
    expect(sent(calls[0]!).variables.first).toBe(25);
  });

  it("run_analytics_query returns the table, and a parse error as an error", async () => {
    const ok = fixture(() => ({ data: { data: { shopifyqlQuery: {
      tableData: { columns: [{ name: "total_sales", dataType: "MONEY", displayName: "Total sales" }], rows: [{ total_sales: "100.0" }] },
      parseErrors: [],
    } } } }));
    let mcp = await connect(ok.client);
    expect(parse(await mcp.callTool({ name: "run_analytics_query", arguments: { query: "FROM sales SHOW total_sales" } })))
      .toEqual({ columns: [{ name: "total_sales", type: "MONEY", label: "Total sales" }], rows: [{ total_sales: "100.0" }] });
    expect(sent(ok.calls[0]!).variables).toEqual({ query: "FROM sales SHOW total_sales" });

    const bad = fixture(() => ({ data: { data: { shopifyqlQuery: { tableData: null, parseErrors: ["Unknown dataset 'sale'"] } } } }));
    mcp = await connect(bad.client);
    const res: any = await mcp.callTool({ name: "run_analytics_query", arguments: { query: "FROM sale SHOW x" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Unknown dataset 'sale'/);
  });

  it("graphql_introspect describes a type and says when there is none", async () => {
    const { client } = fixture((call) => ({ data: { data: { __type: sent(call).variables.name === "Order"
      ? { kind: "OBJECT", name: "Order", description: "An order.", fields: [{ name: "name", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } }, args: [] }] }
      : null } } }));
    const mcp = await connect(client);
    expect(parse(await mcp.callTool({ name: "graphql_introspect", arguments: { type_name: "Order" } })))
      .toEqual({ kind: "OBJECT", name: "Order", description: "An order.", fields: [{ name: "name", type: "String!" }] });
    const res: any = await mcp.callTool({ name: "graphql_introspect", arguments: { type_name: "order" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/No type named "order"/);
  });

  it("graphql_query runs a query and returns its data", async () => {
    const { client, calls } = fixture(() => ({ data: { data: { shop: { name: "Example" } } } }));
    const mcp = await connect(client);
    expect(parse(await mcp.callTool({ name: "graphql_query", arguments: { query: "query($n: Int) { shop { name } }", variables: { n: 1 } } })))
      .toEqual({ shop: { name: "Example" } });
    expect(sent(calls[0]!)).toEqual({ query: "query($n: Int) { shop { name } }", variables: { n: 1 } });
  });

  it("graphql_query refuses a mutation without sending anything", async () => {
    const { client, calls } = fixture(() => ({ data: {} }));
    const mcp = await connect(client);
    const res: any = await mcp.callTool({ name: "graphql_query", arguments: {
      query: 'mutation { productDelete(input: { id: "gid://shopify/Product/1" }) { deletedProductId } }',
    } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/read-only: mutations are not allowed/);
    expect(calls).toHaveLength(0);
  });

  it("returns Shopify's GraphQL error text", async () => {
    const { client } = fixture(() => ({ data: { errors: [{ message: "Access denied for orders field.", extensions: { code: "ACCESS_DENIED", requiredAccess: "`read_orders` access scope." } }] } }));
    const mcp = await connect(client);
    const res: any = await mcp.callTool({ name: "list_orders", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Required access: `read_orders` access scope/);
  });
});

describe("client credentials", () => {
  const shopReply = { data: { data: { shop: { name: "Example" } } } };

  it("trades the app's credentials for a token once and reuses it", async () => {
    const { client, calls } = fixture((call) => call.url === TOKEN_URL
      ? { data: { access_token: "tok-1", scope: "read_products", expires_in: 86399 } }
      : shopReply, APP);
    await client.query("{ shop { name } }");
    await client.query("{ shop { name } }");
    expect(calls.map(c => c.url)).toEqual([TOKEN_URL, GRAPHQL_URL, GRAPHQL_URL]);
    expect(calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ grant_type: "client_credentials", client_id: "cid", client_secret: "csecret" });
    expect(calls[1]!.headers["x-shopify-access-token"]).toBe("tok-1");
  });

  it("renews the token a minute before it expires", async () => {
    let clock = 0;
    let issued = 0;
    const { client, calls } = fixture((call) => call.url === TOKEN_URL
      ? { data: { access_token: `tok-${++issued}`, expires_in: 86399 } }
      : shopReply, { ...APP, now: () => clock });
    await client.query("{ shop { name } }");
    clock = (86399 - 61) * 1000;
    await client.query("{ shop { name } }");
    expect(issued).toBe(1);
    clock = (86399 - 59) * 1000;
    await client.query("{ shop { name } }");
    expect(issued).toBe(2);
    expect(calls.at(-1)!.headers["x-shopify-access-token"]).toBe("tok-2");
  });

  it("shares one exchange between concurrent calls", async () => {
    const { client, calls } = fixture((call) => call.url === TOKEN_URL ? { data: { access_token: "tok", expires_in: 86399 } } : shopReply, APP);
    await Promise.all([client.query("{ shop { name } }"), client.query("{ shop { name } }"), client.query("{ shop { name } }")]);
    expect(calls.filter(c => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it("gets a new token once when Shopify answers 401, then retries the query", async () => {
    let issued = 0;
    const { client, calls } = fixture((call) => {
      if (call.url === TOKEN_URL) return { data: { access_token: `tok-${++issued}`, expires_in: 86399 } };
      return call.headers["x-shopify-access-token"] === "tok-1" ? { status: 401, data: { errors: "Invalid API key or access token" } } : shopReply;
    }, APP);
    expect(await client.query("{ shop { name } }")).toEqual({ shop: { name: "Example" } });
    expect(calls.map(c => c.url)).toEqual([TOKEN_URL, GRAPHQL_URL, TOKEN_URL, GRAPHQL_URL]);
  });

  it("explains a refused exchange without echoing the secret", async () => {
    const { client } = fixture(() => ({ status: 400, data: { error: "shop_not_permitted", error_description: "client_secret=csecret" } }), APP);
    const err = await client.query("{ shop { name } }").catch(e => e as Error);
    expect((err as Error).message).toMatch(/HTTP 400: shop_not_permitted/);
    expect((err as Error).message).toMatch(/same Shopify organisation/);
    expect((err as Error).message).not.toContain("csecret");
  });

  it("prefers the app's credentials over a static token when both are set", async () => {
    const { client, calls } = fixture((call) => call.url === TOKEN_URL ? { data: { access_token: "tok", expires_in: 86399 } } : shopReply,
      { ...APP, accessToken: "shpat_static" });
    await client.query("{ shop { name } }");
    expect(calls[1]!.headers["x-shopify-access-token"]).toBe("tok");
  });
});

describe("failures", () => {
  it("names what is missing", async () => {
    const saved = { ...process.env };
    for (const k of ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ACCESS_TOKEN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]) delete process.env[k];
    try {
      await expect(createShopifyClient(async () => ({ status: 200, data: {} })).query("{ shop { name } }"))
        .rejects.toThrow("SHOPIFY_STORE_DOMAIN is not set");
      await expect(createShopifyClient(async () => ({ status: 200, data: {} }), { storeDomain: "example" }).query("{ shop { name } }"))
        .rejects.toThrow(/Shopify credentials are not set/);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("turns HTTP failures into plain messages", async () => {
    const run = (status: number) => fixture(() => ({ status, data: {} })).client.query("{ shop { name } }").catch(e => (e as Error).message);
    expect(await run(401)).toMatch(/rejected the access token/);
    expect(await run(404)).toMatch(/Check the store domain and SHOPIFY_API_VERSION/);
    expect(await run(429)).toMatch(/rate limiting/);
    expect(await run(500)).toBe("Shopify request failed (HTTP 500)");
  });
});

describe("graphql_mutation", () => {
  const WRITE: ShopifyClientOptions = { ...STATIC, writeTools: true };
  const page = "mutation M($page: PageCreateInput!) { pageCreate(page: $page) { page { id title } userErrors { field message } } }";

  it("does not exist unless writing is switched on, and the client refuses too", async () => {
    const { client, calls } = fixture(() => ({ data: {} }));
    const mcp = await connect(client);
    expect((await mcp.listTools()).tools.map(t => t.name)).not.toContain("graphql_mutation");
    const res: any = await mcp.callTool({ name: "graphql_mutation", arguments: { query: page } });
    expect(res.isError).toBe(true);
    await expect(client.mutate(page)).rejects.toThrow(/not enabled/);
    expect(calls).toHaveLength(0);
  });

  it("follows SHOPIFY_WRITE_TOOLS and SHOPIFY_ALLOWED_MUTATIONS by default", async () => {
    const saved = { w: process.env.SHOPIFY_WRITE_TOOLS, a: process.env.SHOPIFY_ALLOWED_MUTATIONS };
    try {
      process.env.SHOPIFY_WRITE_TOOLS = "1";
      process.env.SHOPIFY_ALLOWED_MUTATIONS = "productUpdate";
      const mcp = await connect(fixture(() => ({ data: {} })).client);
      const tool = (await mcp.listTools()).tools.find(t => t.name === "graphql_mutation")!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(tool.description).toContain("Mutations enabled on this server: productUpdate ");
    } finally {
      for (const [k, v] of [["SHOPIFY_WRITE_TOOLS", saved.w], ["SHOPIFY_ALLOWED_MUTATIONS", saved.a]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it("sends an allowed mutation and returns what was created", async () => {
    const { client, calls } = fixture(() => ({ data: { data: { pageCreate: { page: { id: "gid://shopify/Page/1", title: "Kampanj" }, userErrors: [] } } } }), WRITE);
    const mcp = await connect(client);
    const out = parse(await mcp.callTool({ name: "graphql_mutation", arguments: { query: page, variables: { page: { title: "Kampanj", isPublished: false } } } }));
    expect(out).toEqual({ pageCreate: { page: { id: "gid://shopify/Page/1", title: "Kampanj" }, userErrors: [] } });
    expect(calls).toHaveLength(1);
    expect(sent(calls[0]!)).toEqual({ query: page, variables: { page: { title: "Kampanj", isPublished: false } } });
  });

  it("reports userErrors as an error, since nothing was changed", async () => {
    const { client } = fixture(() => ({ data: { data: { pageCreate: { page: null, userErrors: [{ field: ["page", "title"], message: "Title can't be blank" }] } } } }), WRITE);
    const mcp = await connect(client);
    const res: any = await mcp.callTool({ name: "graphql_mutation", arguments: { query: page, variables: { page: {} } } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Shopify refused the change:\n- pageCreate: Title can't be blank \(page.title\)/);
  });

  it("refuses a mutation outside the allowlist, a delete by wildcard and a hard-denied one, without sending", async () => {
    const { client, calls } = fixture(() => ({ data: {} }), { ...WRITE, allowedMutations: ["page*", "refundCreate"] });
    const mcp = await connect(client);
    const call = async (query: string) => text(await mcp.callTool({ name: "graphql_mutation", arguments: { query } }) as any);
    expect(await call('mutation { productUpdate(product: {id: "1"}) { product { id } } }')).toMatch(/productUpdate is not enabled/);
    expect(await call('mutation { pageDelete(id: "1") { deletedPageId } }')).toMatch(/pageDelete deletes data/);
    expect(await call('mutation { refundCreate(input: {orderId: "1"}) { refund { id } } }')).toMatch(/refundCreate is never allowed/);
    expect(calls).toHaveLength(0);
  });

  it("graphql_query still refuses mutations when writing is on", async () => {
    const { client, calls } = fixture(() => ({ data: {} }), WRITE);
    const mcp = await connect(client);
    const res: any = await mcp.callTool({ name: "graphql_query", arguments: { query: page } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/read-only: mutations are not allowed/);
    expect(calls).toHaveLength(0);
  });
});

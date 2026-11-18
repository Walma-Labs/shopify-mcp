// The MCP server factory: six read-only tools over ONE Shopify store's Admin
// GraphQL API. One implementation, three consumers: the stdio bin (local use),
// the standalone HTTP entrypoint, and the Walma MCP chassis (which imports
// createShopifyServer and mounts it on a path).
//
// Three tools answer the common questions directly (shop, products, orders),
// one runs ShopifyQL, and two cover everything else: look a type up, then send
// a query. Every query goes through assertReadOnly.
//
// Writing is a seventh tool, graphql_mutation, registered ONLY when the
// environment sets SHOPIFY_WRITE_TOOLS. Without it the tool does not exist.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createShopifyClient, type ShopifyClient } from "./shopify.js";
import {
  ANALYTICS_QUERY, INTROSPECT_QUERY, MAX_PAGE_SIZE, ORDERS_QUERY, PRODUCTS_QUERY, SHOP_QUERY,
  boundedJson, collectUserErrors, compactAnalytics, compactOrders, compactProducts, compactType, pageSize,
} from "./logic.js";

export const VERSION = "0.2.0";

export const INSTRUCTIONS =
  "One Shopify store's Admin data (read-only). get_shop shows the store, its " +
  "currency and which access scopes the app was granted. Use list_orders and " +
  "list_products for recent orders and the catalogue, run_analytics_query " +
  "(ShopifyQL) for totals over time, and graphql_query for anything else: " +
  "look the type up with graphql_introspect first instead of guessing fields. " +
  "Nothing here can change the store.";

const SEARCH_SYNTAX = "https://shopify.dev/docs/api/usage/search-syntax";

/** JSON tool result in the shape MCP clients expect. */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: boundedJson(value) }] };
}

function errorResult(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
}

const paging = {
  first: z.number().int().positive().optional()
    .describe(`How many to return, 1-${MAX_PAGE_SIZE}. Default 25.`),
  after: z.string().optional().describe("The next_cursor of the previous page, to continue from it."),
  reverse: z.boolean().optional().describe("Reverse the sort order (newest or largest first)."),
};

/**
 * A new server around a client. The chassis builds the client once (it caches
 * the store's access token) and calls this per request.
 */
export function createShopifyServer(client: ShopifyClient = createShopifyClient()): McpServer {
  const canWrite = client.writeTools;
  const server = new McpServer(
    { name: "shopify-mcp", version: VERSION },
    {
      instructions: canWrite
        ? INSTRUCTIONS.replace("(read-only)", "(read, and write through graphql_mutation)")
            .replace("Nothing here can change the store.",
              "graphql_mutation changes the live store at once: tell the user exactly what it will do before calling it.")
        : INSTRUCTIONS,
    },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: true };

  /** Runs a tool body, turning any failure into an MCP error result. */
  const guarded = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return jsonResult(await fn(args));
    } catch (e) {
      return errorResult(e);
    }
  };

  server.registerTool("get_shop", {
    title: "Get shop",
    description:
      "The store this server is connected to: name, domains, currency, time zone, and the access scopes the " +
      "app was granted. Check the scopes when another tool answers 'access denied'.",
    inputSchema: {},
    annotations: readOnly,
  }, guarded(async () => {
    const data = await client.query(SHOP_QUERY);
    return {
      name: data?.shop?.name,
      myshopify_domain: data?.shop?.myshopifyDomain,
      primary_domain: data?.shop?.primaryDomain?.host,
      currency: data?.shop?.currencyCode,
      timezone: data?.shop?.ianaTimezone,
      weight_unit: data?.shop?.weightUnit,
      access_scopes: (data?.currentAppInstallation?.accessScopes ?? []).map((s: any) => s.handle).sort(),
    };
  }));

  server.registerTool("list_products", {
    title: "List products",
    description:
      "Products in the catalogue: title, status, vendor, type, tags, total inventory and price range.\n\n" +
      `query uses Shopify's search syntax (${SEARCH_SYNTAX}), e.g. "status:active", "vendor:Acme", ` +
      "\"inventory_total:0\", \"title:ladder*\", \"updated_at:>2026-01-01\". Without it every product is listed.\n\n" +
      "For variants, SKUs, per-location inventory or metafields, use graphql_query.",
    inputSchema: {
      query: z.string().optional().describe("Search filter in Shopify's search syntax."),
      sort_key: z.enum(["TITLE", "CREATED_AT", "UPDATED_AT", "INVENTORY_TOTAL", "VENDOR", "PRODUCT_TYPE", "RELEVANCE"])
        .optional().describe("What to sort by. RELEVANCE only works together with query."),
      ...paging,
    },
    annotations: readOnly,
  }, guarded(async (args) => {
    const data = await client.query(PRODUCTS_QUERY, {
      first: pageSize(args.first), after: args.after, query: args.query, sortKey: args.sort_key, reverse: args.reverse,
    });
    return compactProducts(data?.products);
  }));

  server.registerTool("list_orders", {
    title: "List orders",
    description:
      "Orders: number, dates, payment and fulfilment status, totals and line items. No customer details.\n\n" +
      `query uses Shopify's search syntax (${SEARCH_SYNTAX}), e.g. "created_at:>=2026-01-01", ` +
      "\"financial_status:paid\", \"fulfillment_status:unfulfilled\", \"status:open\", \"sku:ABC123\".\n\n" +
      "Orders older than 60 days are only visible when the app has the read_all_orders scope. For sums over " +
      "a period (sales per month, top products), run_analytics_query is the better tool: this one lists " +
      "orders, it does not add them up.",
    inputSchema: {
      query: z.string().optional().describe("Search filter in Shopify's search syntax."),
      sort_key: z.enum(["CREATED_AT", "PROCESSED_AT", "UPDATED_AT", "TOTAL_PRICE", "ORDER_NUMBER"])
        .optional().describe("What to sort by. Default is the order's processed date."),
      ...paging,
    },
    annotations: readOnly,
  }, guarded(async (args) => {
    const data = await client.query(ORDERS_QUERY, {
      first: pageSize(args.first), after: args.after, query: args.query, sortKey: args.sort_key, reverse: args.reverse,
    });
    return compactOrders(data?.orders);
  }));

  server.registerTool("run_analytics_query", {
    title: "Run analytics query",
    description:
      "Runs a ShopifyQL query against the store's analytics, the same data as the reports in the Shopify admin.\n\n" +
      "A query names a dataset with FROM and what to show with SHOW, and may group, filter, order and limit:\n" +
      "  FROM sales SHOW total_sales, orders GROUP BY month SINCE -12m ORDER BY month\n" +
      "  FROM sales SHOW net_sales GROUP BY product_title SINCE -30d ORDER BY net_sales DESC LIMIT 10\n" +
      "  FROM sessions SHOW sessions, conversion_rate GROUP BY day SINCE -7d\n\n" +
      "Reference: https://shopify.dev/docs/api/shopifyql. Needs the read_reports scope. A query that " +
      "cannot be parsed comes back as an error with Shopify's explanation.",
    inputSchema: {
      query: z.string().describe("The ShopifyQL query."),
    },
    annotations: readOnly,
  }, guarded(async ({ query }) => {
    const data = await client.query(ANALYTICS_QUERY, { query });
    return compactAnalytics(data?.shopifyqlQuery);
  }));

  server.registerTool("graphql_introspect", {
    title: "Look up a GraphQL type",
    description:
      "Describes one type of the Admin GraphQL schema: its fields with their types and arguments, or its " +
      "enum values. Use it before graphql_query so fields are looked up, not guessed.\n\n" +
      "Start from \"QueryRoot\" to see every top-level query, then follow the type names, e.g. \"Order\", " +
      "\"ProductVariant\", \"InventoryLevel\", \"OrderSortKeys\".",
    inputSchema: {
      type_name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a GraphQL type name")
        .describe("Exact type name, case-sensitive, e.g. \"Order\"."),
    },
    annotations: readOnly,
  }, guarded(async ({ type_name }) => {
    const data = await client.query(INTROSPECT_QUERY, { name: type_name });
    const type = compactType(data?.__type);
    if (!type) throw new Error(`No type named "${type_name}" in the Admin GraphQL schema. Names are case-sensitive.`);
    return type;
  }));

  server.registerTool("graphql_query", {
    title: "Run a GraphQL query",
    description:
      "Runs one read query against the store's Admin GraphQL API, for anything the other tools do not " +
      "cover: variants and SKUs, inventory per location, customers, collections, discounts, fulfilments, " +
      "metafields.\n\n" +
      "Only queries are accepted: a mutation or subscription is refused before it is sent. What the query " +
      "may read is limited to the access scopes the store granted the app (see get_shop).\n\n" +
      `Ask for no more than you need: lists take first: N (keep it at ${MAX_PAGE_SIZE} or below) and ` +
      "Shopify bills a query by the items it requests. Page with pageInfo { hasNextPage endCursor } and after.",
    inputSchema: {
      query: z.string().describe("A GraphQL query document with exactly one query operation."),
      variables: z.record(z.string(), z.any()).optional().describe("Values for the query's variables."),
    },
    annotations: readOnly,
  }, guarded(async ({ query, variables }) => client.query(query, variables)));

  if (canWrite) {
    const allowed = client.allowedMutations;
    server.registerTool("graphql_mutation", {
      title: "Change the store",
      description:
        "Runs one mutation against the store's Admin GraphQL API. It takes effect on the LIVE store at once: " +
        "there is no dry run and no undo. Before calling it, tell the user exactly what will be created or " +
        "changed and wait for them to agree.\n\n" +
        `Mutations enabled on this server: ${allowed.join(", ")} (a name ending in * is a prefix). ` +
        "Anything that deletes is refused unless it is listed by its exact name. Refunds, payments, gift " +
        "cards, order cancellation, staff, access tokens, webhooks and publishing a theme are never allowed. " +
        "The app's access scopes limit it further (see get_shop).\n\n" +
        "Create things unpublished or as drafts when the mutation offers it (isPublished: false, status: " +
        "DRAFT), so a person reviews them in the Shopify admin before customers see them. A discount is " +
        "live from its startsAt.\n\n" +
        "Look the mutation and its input type up with graphql_introspect first (start from \"Mutation\"). " +
        "Always select userErrors { field message } and the id of what was created: a mutation Shopify " +
        "refuses comes back as userErrors, and this tool reports that as an error.",
      inputSchema: {
        query: z.string().describe("A GraphQL document with exactly one mutation operation."),
        variables: z.record(z.string(), z.any()).optional().describe("Values for the mutation's variables."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ query, variables }) => {
      try {
        const data = await client.mutate(query, variables);
        const userErrors = collectUserErrors(data);
        if (userErrors.length) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Shopify refused the change:\n- ${userErrors.join("\n- ")}\n\n${boundedJson(data)}` }],
          };
        }
        return jsonResult(data);
      } catch (e) {
        return errorResult(e);
      }
    });
  }

  return server;
}

// Pure logic, no I/O: the read-only gate, store-domain handling, the queries
// behind the convenience tools and the shaping of their results. Everything
// here is unit-tested without network.

import { Kind, parse, type DocumentNode } from "graphql";

/**
 * "example", "https://example.myshopify.com/" and "example.myshopify.com" all
 * mean the same store. Only *.myshopify.com is accepted: the access token is
 * sent to this host, so a custom storefront domain (or a typo that resolves
 * somewhere else) must not be able to receive it.
 */
export function normalizeStoreDomain(input: string): string {
  let d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!d) throw new Error("SHOPIFY_STORE_DOMAIN is not set");
  if (!d.includes(".")) d = `${d}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) {
    throw new Error(`Not a Shopify store domain: "${input}". Use the store's myshopify.com address, e.g. "example.myshopify.com".`);
  }
  return d;
}

/**
 * Refuses anything that is not a pure read. The document is parsed, not
 * pattern-matched, so a mutation cannot hide behind a comment, an alias or a
 * second operation. Subscriptions are refused too: nothing here can hold one.
 */
export function assertReadOnly(query: string): DocumentNode {
  let doc: DocumentNode;
  try {
    doc = parse(query);
  } catch (e) {
    throw new Error(`Not a valid GraphQL document: ${(e as Error).message}`);
  }
  const operations = doc.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION);
  if (!operations.length) throw new Error("The document contains no query");
  for (const op of operations) {
    if (op.kind === Kind.OPERATION_DEFINITION && op.operation !== "query") {
      throw new Error(`This server is read-only: ${op.operation}s are not allowed, only queries.`);
    }
  }
  if (operations.length > 1) {
    throw new Error("Send one query per call (the document holds several operations).");
  }
  return doc;
}

/** The message for a GraphQL `errors` answer: Shopify's own text, with the throttle case spelled out. */
export function formatGraphqlErrors(errors: unknown): string {
  if (typeof errors === "string") return `Shopify API error: ${errors}`;
  const list = Array.isArray(errors) ? errors : [errors];
  if (list.some((e: any) => e?.extensions?.code === "THROTTLED")) {
    return "Shopify throttled the query (it costs more than the app's remaining budget). Ask for fewer items or fields, or wait a few seconds.";
  }
  const messages = list.map((e: any) => {
    const code = e?.extensions?.code;
    if (code === "ACCESS_DENIED") {
      const needs = e?.extensions?.requiredAccess ? ` Required access: ${e.extensions.requiredAccess}` : "";
      return `Access denied: the app has not been granted the scope this needs.${needs}`.trim();
    }
    return e?.message ?? JSON.stringify(e);
  });
  return `Shopify API error: ${messages.join("; ")}`;
}

/** Page sizes are kept small: Admin GraphQL bills by requested items. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export function pageSize(first: number | undefined): number {
  if (first == null) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(first) || first < 1) throw new Error("first must be a whole number above 0");
  return Math.min(first, MAX_PAGE_SIZE);
}

export const SHOP_QUERY = `query Shop {
  shop {
    name
    myshopifyDomain
    primaryDomain { host }
    currencyCode
    ianaTimezone
    weightUnit
  }
  currentAppInstallation {
    accessScopes { handle }
  }
}`;

export const PRODUCTS_QUERY = `query Products($first: Int!, $after: String, $query: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
  products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    nodes {
      id
      title
      handle
      status
      vendor
      productType
      tags
      totalInventory
      createdAt
      updatedAt
      priceRangeV2 {
        minVariantPrice { amount currencyCode }
        maxVariantPrice { amount currencyCode }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// No customer, address or e-mail fields: an order list is for sales questions.
// Someone who needs the buyer can ask for it through graphql_query, and gets it
// only if the store granted the app the customer scopes.
export const ORDERS_QUERY = `query Orders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
  orders(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
    nodes {
      id
      name
      createdAt
      processedAt
      cancelledAt
      displayFinancialStatus
      displayFulfillmentStatus
      currentSubtotalLineItemsQuantity
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      lineItems(first: 20) {
        nodes { title quantity sku }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const ANALYTICS_QUERY = `query Analytics($query: String!) {
  shopifyqlQuery(query: $query) {
    tableData {
      columns { name dataType displayName }
      rows
    }
    parseErrors
  }
}`;

// Three levels of ofType cover every shape in the Admin schema ([Type!]!).
const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";

export const INTROSPECT_QUERY = `query Introspect($name: String!) {
  __type(name: $name) {
    kind
    name
    description
    fields(includeDeprecated: false) {
      name
      description
      args { name type { ${TYPE_REF} } }
      type { ${TYPE_REF} }
    }
    inputFields { name description type { ${TYPE_REF} } }
    enumValues(includeDeprecated: false) { name description }
    possibleTypes { name }
  }
}`;

/** "[Order!]!" from an introspection type reference. */
export function typeRefToString(ref: any): string {
  if (!ref) return "";
  if (ref.kind === "NON_NULL") return `${typeRefToString(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${typeRefToString(ref.ofType)}]`;
  return ref.name ?? "";
}

const firstLine = (s: unknown) => (typeof s === "string" ? s.split("\n")[0]!.trim() : undefined);

/** An introspected type as compact text-like JSON: what to select and with which arguments. */
export function compactType(t: any): Record<string, unknown> | null {
  if (!t) return null;
  const out: Record<string, unknown> = { kind: t.kind, name: t.name, description: firstLine(t.description) };
  if (t.fields?.length) {
    out.fields = t.fields.map((f: any) => ({
      name: f.name,
      type: typeRefToString(f.type),
      ...(f.args?.length ? { args: f.args.map((a: any) => `${a.name}: ${typeRefToString(a.type)}`) } : {}),
      ...(firstLine(f.description) ? { description: firstLine(f.description) } : {}),
    }));
  }
  if (t.inputFields?.length) {
    out.inputFields = t.inputFields.map((f: any) => ({ name: f.name, type: typeRefToString(f.type) }));
  }
  if (t.enumValues?.length) out.enumValues = t.enumValues.map((v: any) => v.name);
  if (t.possibleTypes?.length) out.possibleTypes = t.possibleTypes.map((p: any) => p.name);
  return out;
}

const money = (set: any) => {
  const m = set?.shopMoney ?? set;
  return m?.amount == null ? null : { amount: Number(m.amount), currency: m.currencyCode };
};

export function compactProducts(connection: any) {
  return {
    products: (connection?.nodes ?? []).map((p: any) => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      status: p.status,
      vendor: p.vendor,
      product_type: p.productType,
      tags: p.tags,
      total_inventory: p.totalInventory,
      price_min: money(p.priceRangeV2?.minVariantPrice),
      price_max: money(p.priceRangeV2?.maxVariantPrice),
      created_at: p.createdAt,
      updated_at: p.updatedAt,
    })),
    ...nextPage(connection),
  };
}

export function compactOrders(connection: any) {
  return {
    orders: (connection?.nodes ?? []).map((o: any) => ({
      id: o.id,
      name: o.name,
      created_at: o.createdAt,
      processed_at: o.processedAt,
      cancelled_at: o.cancelledAt,
      financial_status: o.displayFinancialStatus,
      fulfillment_status: o.displayFulfillmentStatus,
      item_count: o.currentSubtotalLineItemsQuantity,
      total: money(o.currentTotalPriceSet),
      discounts: money(o.totalDiscountsSet),
      line_items: (o.lineItems?.nodes ?? []).map((l: any) => ({ title: l.title, quantity: l.quantity, sku: l.sku })),
    })),
    ...nextPage(connection),
  };
}

function nextPage(connection: any) {
  return connection?.pageInfo?.hasNextPage
    ? { has_next_page: true, next_cursor: connection.pageInfo.endCursor }
    : { has_next_page: false };
}

/** A ShopifyQL answer as rows keyed by column name. Parse errors are the answer when there are any. */
export function compactAnalytics(result: any) {
  if (!result) throw new Error("Shopify returned no analytics result");
  if (result.parseErrors?.length) {
    throw new Error(`ShopifyQL could not be parsed: ${result.parseErrors.join("; ")}`);
  }
  const columns = result.tableData?.columns ?? [];
  return {
    columns: columns.map((c: any) => ({ name: c.name, type: c.dataType, label: c.displayName })),
    rows: result.tableData?.rows ?? [],
  };
}

/** Free-form query results can be large; past this the text is cut and says so. */
export const MAX_RESULT_CHARS = 200_000;

export function boundedJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… cut at ${MAX_RESULT_CHARS} characters of ${text.length}. Ask for fewer items or fields.`;
}

// ─── Writing ────────────────────────────────────────────────────────────────
// Off unless the environment turns it on (SHOPIFY_WRITE_TOOLS). When it is on,
// a mutation still has to pass three checks before it is sent:
//   1. it is on the allowlist (the default below, or SHOPIFY_ALLOWED_MUTATIONS);
//   2. it is not on the hard-deny list, which no configuration can lift;
//   3. if it deletes something, it is listed by its exact name. A wildcard
//      never grants a delete.
// The app's access scopes are the outer limit on top of this.

export function writeEnabled(raw: string | undefined): boolean {
  return ["1", "true", "on"].includes((raw ?? "").trim().toLowerCase());
}

/**
 * What a store's campaign work needs: landing pages and blog posts, redirects,
 * discounts, the content model behind them, files and navigation. Not products,
 * prices, inventory, orders or customers: an environment that wants those lists
 * them in SHOPIFY_ALLOWED_MUTATIONS.
 */
export const DEFAULT_ALLOWED_MUTATIONS: readonly string[] = [
  "page*", "article*", "blog*", "urlRedirect*",
  "discountCode*", "discountAutomatic*",
  "metaobject*", "metafieldsSet", "metafieldDefinition*",
  "fileCreate", "fileUpdate", "stagedUploadsCreate",
  "menu*", "marketingActivity*",
];

/** Exact mutation names, or a prefix followed by "*". */
export function parseAllowedMutations(raw: string | undefined): string[] {
  const list = (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);
  for (const p of list) {
    if (!/^[A-Za-z][A-Za-z0-9]*\*?$/.test(p)) {
      throw new Error(`SHOPIFY_ALLOWED_MUTATIONS: "${p}" is not a mutation name or a prefix ending in *`);
    }
  }
  return list.length ? list : [...DEFAULT_ALLOWED_MUTATIONS];
}

// Money leaving or entering, credentials, who has access, personal-data
// erasure, what the storefront shows, and the one mutation that can run any
// other in bulk. Refused whatever the allowlist says.
const HARD_DENIED: readonly RegExp[] = [
  /refund/i, /giftCard/i, /payment/i, /payout/i, /capture/i, /dispute/i, /transaction/i,
  /^order(Cancel|MarkAsPaid|Create|Delete|Open|Close)/, /^draftOrder(Complete|InvoiceSend)/,
  /staffMember/i, /^app(Subscription|Purchase|Usage|Revoke|Uninstall)/,
  /AccessToken/, /webhook/i, /eventBridge/i, /pubSub/i,
  /^customer(Delete|RequestDataErasure|CancelDataErasure|Merge)/,
  /^bulkOperationRunMutation$/, /^theme(Publish|Delete)$/, /^shopPolic/,
];

export const isHardDenied = (name: string) => HARD_DENIED.some(re => re.test(name));

const isDelete = (name: string) => /Delete|Remove/.test(name);

export function mutationAllowed(name: string, patterns: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (isHardDenied(name)) {
    return { ok: false, reason: `${name} is never allowed through this server.` };
  }
  if (patterns.includes(name)) return { ok: true };
  const byWildcard = patterns.some(p => p.endsWith("*") && name.startsWith(p.slice(0, -1)));
  if (byWildcard && isDelete(name)) {
    return { ok: false, reason: `${name} deletes data and is not enabled on this server (a delete has to be allowed by its exact name).` };
  }
  if (byWildcard) return { ok: true };
  return { ok: false, reason: `${name} is not enabled on this server. Allowed: ${patterns.join(", ")}` };
}

/**
 * The gate every mutation passes. Returns the mutation names in the document.
 * The root selections must be plain fields: a fragment there could hide which
 * mutations run.
 */
export function assertMutationAllowed(query: string, patterns: readonly string[]): string[] {
  let doc: DocumentNode;
  try {
    doc = parse(query);
  } catch (e) {
    throw new Error(`Not a valid GraphQL document: ${(e as Error).message}`);
  }
  const operations = doc.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION);
  if (operations.length !== 1) throw new Error("Send exactly one mutation operation per call.");
  const op = operations[0]!;
  if (op.kind !== Kind.OPERATION_DEFINITION || op.operation !== "mutation") {
    throw new Error("graphql_mutation takes a mutation. Use graphql_query for a query.");
  }
  const names: string[] = [];
  const problems: string[] = [];
  for (const selection of op.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      throw new Error("Name each mutation directly at the top level of the document (no fragments there).");
    }
    const name = selection.name.value;
    names.push(name);
    const verdict = mutationAllowed(name, patterns);
    if (!verdict.ok) problems.push(verdict.reason);
  }
  if (problems.length) throw new Error(`The mutation was not sent:\n- ${problems.join("\n- ")}`);
  return names;
}

/**
 * Shopify reports a refused mutation inside the payload, as userErrors, with
 * HTTP 200. Collected here so a call that changed nothing is not read as a
 * success.
 */
export function collectUserErrors(data: any): string[] {
  const out: string[] = [];
  for (const [name, payload] of Object.entries(data ?? {})) {
    const errors = (payload as any)?.userErrors;
    if (!Array.isArray(errors)) continue;
    for (const e of errors) {
      const field = Array.isArray(e?.field) ? ` (${e.field.join(".")})` : "";
      out.push(`${name}: ${e?.message ?? JSON.stringify(e)}${field}`);
    }
  }
  return out;
}

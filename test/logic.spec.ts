import { describe, it, expect } from "vitest";
import { parse, validate, buildSchema } from "graphql";
import {
  ANALYTICS_QUERY, INTROSPECT_QUERY, MAX_RESULT_CHARS, ORDERS_QUERY, PRODUCTS_QUERY, SHOP_QUERY,
  DEFAULT_ALLOWED_MUTATIONS, assertMutationAllowed, assertReadOnly, boundedJson, collectUserErrors, isHardDenied,
  mutationAllowed, parseAllowedMutations, writeEnabled, compactAnalytics, compactOrders, compactProducts, compactType,
  formatGraphqlErrors, normalizeStoreDomain, pageSize, typeRefToString,
} from "../src/logic.js";

describe("normalizeStoreDomain", () => {
  it("accepts the handle, the domain and a pasted URL", () => {
    expect(normalizeStoreDomain("example")).toBe("example.myshopify.com");
    expect(normalizeStoreDomain("Example.myshopify.com")).toBe("example.myshopify.com");
    expect(normalizeStoreDomain("https://example.myshopify.com/admin")).toBe("example.myshopify.com");
  });

  it("refuses anything that is not a myshopify.com host, so the token cannot go elsewhere", () => {
    expect(() => normalizeStoreDomain("shop.example.com")).toThrow(/Not a Shopify store domain/);
    expect(() => normalizeStoreDomain("example.myshopify.com.evil.io")).toThrow(/Not a Shopify store domain/);
    expect(() => normalizeStoreDomain("evil.io/x.myshopify.com")).toThrow(/Not a Shopify store domain/);
    expect(() => normalizeStoreDomain("  ")).toThrow(/SHOPIFY_STORE_DOMAIN is not set/);
  });
});

describe("assertReadOnly", () => {
  it("lets a query through, named or anonymous", () => {
    expect(() => assertReadOnly("{ shop { name } }")).not.toThrow();
    expect(() => assertReadOnly("query Q($n: Int!) { products(first: $n) { nodes { id } } }")).not.toThrow();
    expect(() => assertReadOnly("query Q { ...F } fragment F on QueryRoot { shop { name } }")).not.toThrow();
  });

  it("refuses a mutation however it is dressed up", () => {
    const m = 'mutation { productDelete(input: { id: "gid://shopify/Product/1" }) { deletedProductId } }';
    expect(() => assertReadOnly(m)).toThrow(/read-only/);
    expect(() => assertReadOnly(`# query\n${m}`)).toThrow(/read-only/);
    expect(() => assertReadOnly(`query A { shop { name } } ${m.replace("mutation", "mutation B")}`)).toThrow(/read-only/);
    expect(() => assertReadOnly("subscription { x }")).toThrow(/read-only/);
  });

  it("refuses several operations, an empty document and a broken one", () => {
    expect(() => assertReadOnly("query A { shop { name } } query B { shop { name } }")).toThrow(/one query per call/);
    expect(() => assertReadOnly("fragment F on Shop { name }")).toThrow(/no query/);
    expect(() => assertReadOnly("query {")).toThrow(/Not a valid GraphQL document/);
  });

  it("passes every query this package ships", () => {
    for (const q of [SHOP_QUERY, PRODUCTS_QUERY, ORDERS_QUERY, ANALYTICS_QUERY, INTROSPECT_QUERY]) {
      expect(() => assertReadOnly(q)).not.toThrow();
    }
  });
});

// The built-in queries, checked against the slice of the Admin schema they
// touch. The field names and types below were read from Shopify's Admin
// GraphQL schema (2026-10); if Shopify renames one, update both together.
describe("built-in queries", () => {
  const schema = buildSchema(`
    scalar DateTime scalar JSON scalar Decimal
    enum ProductSortKeys { TITLE CREATED_AT UPDATED_AT INVENTORY_TOTAL VENDOR PRODUCT_TYPE RELEVANCE }
    enum OrderSortKeys { CREATED_AT PROCESSED_AT UPDATED_AT TOTAL_PRICE ORDER_NUMBER }
    type PageInfo { hasNextPage: Boolean! endCursor: String }
    type MoneyV2 { amount: Decimal! currencyCode: String! }
    type MoneyBag { shopMoney: MoneyV2! }
    type Domain { host: String! }
    type Shop { name: String! myshopifyDomain: String! primaryDomain: Domain! currencyCode: String! ianaTimezone: String! weightUnit: String! }
    type AccessScope { handle: String! }
    type AppInstallation { accessScopes: [AccessScope!]! }
    type ProductPriceRangeV2 { minVariantPrice: MoneyV2! maxVariantPrice: MoneyV2! }
    type Product { id: ID! title: String! handle: String! status: String! vendor: String! productType: String! tags: [String!]! totalInventory: Int! createdAt: DateTime! updatedAt: DateTime! priceRangeV2: ProductPriceRangeV2! }
    type ProductConnection { nodes: [Product!]! pageInfo: PageInfo! }
    type LineItem { title: String! quantity: Int! sku: String }
    type LineItemConnection { nodes: [LineItem!]! }
    type Order { id: ID! name: String! createdAt: DateTime! processedAt: DateTime! cancelledAt: DateTime displayFinancialStatus: String displayFulfillmentStatus: String! currentSubtotalLineItemsQuantity: Int! currentTotalPriceSet: MoneyBag! totalDiscountsSet: MoneyBag lineItems(first: Int): LineItemConnection! }
    type OrderConnection { nodes: [Order!]! pageInfo: PageInfo! }
    type ShopifyqlTableDataColumn { name: String! dataType: String! displayName: String! }
    type ShopifyqlTableData { columns: [ShopifyqlTableDataColumn!]! rows: JSON! }
    type ShopifyqlQueryResponse { tableData: ShopifyqlTableData parseErrors: [String!]! }
    type Query {
      shop: Shop!
      currentAppInstallation: AppInstallation!
      products(first: Int, after: String, query: String, sortKey: ProductSortKeys, reverse: Boolean): ProductConnection!
      orders(first: Int, after: String, query: String, sortKey: OrderSortKeys, reverse: Boolean): OrderConnection!
      shopifyqlQuery(query: String!): ShopifyqlQueryResponse
    }
  `);
  for (const [name, q] of Object.entries({ SHOP_QUERY, PRODUCTS_QUERY, ORDERS_QUERY, ANALYTICS_QUERY, INTROSPECT_QUERY })) {
    it(`${name} is valid`, () => {
      expect(validate(schema, parse(q)).map(e => e.message)).toEqual([]);
    });
  }
});

describe("formatGraphqlErrors", () => {
  it("passes Shopify's message on", () => {
    expect(formatGraphqlErrors([{ message: "Field 'nope' doesn't exist on type 'Shop'" }]))
      .toBe("Shopify API error: Field 'nope' doesn't exist on type 'Shop'");
  });
  it("explains a throttle and a missing scope", () => {
    expect(formatGraphqlErrors([{ message: "Throttled", extensions: { code: "THROTTLED" } }])).toMatch(/throttled the query/);
    expect(formatGraphqlErrors([{ message: "Access denied for orders field.", extensions: { code: "ACCESS_DENIED", requiredAccess: "`read_orders` access scope." } }]))
      .toBe("Shopify API error: Access denied: the app has not been granted the scope this needs. Required access: `read_orders` access scope.");
  });
  it("copes with the string form some failures use", () => {
    expect(formatGraphqlErrors("Not Found")).toBe("Shopify API error: Not Found");
  });
});

describe("pageSize", () => {
  it("defaults, caps and refuses nonsense", () => {
    expect(pageSize(undefined)).toBe(25);
    expect(pageSize(10)).toBe(10);
    expect(pageSize(5000)).toBe(100);
    expect(() => pageSize(0)).toThrow(/whole number/);
  });
});

describe("result shaping", () => {
  it("products: flat rows, prices as numbers, cursor only when there is a next page", () => {
    expect(compactProducts({
      nodes: [{ id: "gid://shopify/Product/1", title: "Ladder", handle: "ladder", status: "ACTIVE", vendor: "Acme", productType: "Roof",
        tags: ["a"], totalInventory: 4, createdAt: "c", updatedAt: "u",
        priceRangeV2: { minVariantPrice: { amount: "199.00", currencyCode: "SEK" }, maxVariantPrice: { amount: "249.50", currencyCode: "SEK" } } }],
      pageInfo: { hasNextPage: true, endCursor: "abc" },
    })).toEqual({
      products: [{ id: "gid://shopify/Product/1", title: "Ladder", handle: "ladder", status: "ACTIVE", vendor: "Acme", product_type: "Roof",
        tags: ["a"], total_inventory: 4, price_min: { amount: 199, currency: "SEK" }, price_max: { amount: 249.5, currency: "SEK" },
        created_at: "c", updated_at: "u" }],
      has_next_page: true, next_cursor: "abc",
    });
    expect(compactProducts({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } })).toEqual({ products: [], has_next_page: false });
  });

  it("orders: totals in shop currency and line items, no customer fields", () => {
    const out = compactOrders({
      nodes: [{ id: "gid://shopify/Order/1", name: "#1001", createdAt: "c", processedAt: "p", cancelledAt: null,
        displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", currentSubtotalLineItemsQuantity: 3,
        currentTotalPriceSet: { shopMoney: { amount: "1200.00", currencyCode: "SEK" } }, totalDiscountsSet: null,
        lineItems: { nodes: [{ title: "Ladder", quantity: 3, sku: "L-1" }] } }],
      pageInfo: { hasNextPage: false },
    });
    expect(out.orders[0]).toEqual({
      id: "gid://shopify/Order/1", name: "#1001", created_at: "c", processed_at: "p", cancelled_at: null,
      financial_status: "PAID", fulfillment_status: "FULFILLED", item_count: 3,
      total: { amount: 1200, currency: "SEK" }, discounts: null,
      line_items: [{ title: "Ladder", quantity: 3, sku: "L-1" }],
    });
    expect(ORDERS_QUERY).not.toMatch(/customer|email|address|phone/i);
  });

  it("analytics: rows as Shopify gives them, parse errors as the error", () => {
    expect(compactAnalytics({
      tableData: { columns: [{ name: "month", dataType: "MONTH_TIMESTAMP", displayName: "Month" }], rows: [{ month: "2026-01-01" }] },
      parseErrors: [],
    })).toEqual({ columns: [{ name: "month", type: "MONTH_TIMESTAMP", label: "Month" }], rows: [{ month: "2026-01-01" }] });
    expect(() => compactAnalytics({ tableData: null, parseErrors: ["Unknown dataset 'sale'"] })).toThrow(/Unknown dataset 'sale'/);
    expect(() => compactAnalytics(null)).toThrow(/no analytics result/);
  });

  it("types: readable type references and one-line descriptions", () => {
    const listOfNonNull = { kind: "NON_NULL", ofType: { kind: "LIST", ofType: { kind: "NON_NULL", ofType: { kind: "OBJECT", name: "Order" } } } };
    expect(typeRefToString(listOfNonNull)).toBe("[Order!]!");
    expect(compactType({
      kind: "OBJECT", name: "Shop", description: "The shop.\nMore text.",
      fields: [{ name: "orders", description: null, type: listOfNonNull, args: [{ name: "first", type: { kind: "SCALAR", name: "Int" } }] }],
    })).toEqual({ kind: "OBJECT", name: "Shop", description: "The shop.", fields: [{ name: "orders", type: "[Order!]!", args: ["first: Int"] }] });
    expect(compactType({ kind: "ENUM", name: "E", enumValues: [{ name: "A" }, { name: "B" }] })).toMatchObject({ enumValues: ["A", "B"] });
    expect(compactType(null)).toBeNull();
  });

  it("cuts an oversized result and says so", () => {
    const text = boundedJson({ big: "x".repeat(MAX_RESULT_CHARS) });
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS + 200);
    expect(text).toMatch(/cut at 200000 characters/);
    expect(boundedJson({ ok: 1 })).toBe('{\n  "ok": 1\n}');
  });
});

describe("writing: the switch and the allowlist", () => {
  it("is off unless switched on", () => {
    for (const v of [undefined, "", "0", "false", "draft", "yes"]) expect(writeEnabled(v)).toBe(false);
    for (const v of ["1", "true", " ON "]) expect(writeEnabled(v)).toBe(true);
  });

  it("uses the default list when none is configured, and rejects a malformed one", () => {
    expect(parseAllowedMutations(undefined)).toEqual([...DEFAULT_ALLOWED_MUTATIONS]);
    expect(parseAllowedMutations(" ")).toEqual([...DEFAULT_ALLOWED_MUTATIONS]);
    expect(parseAllowedMutations("productUpdate, page*")).toEqual(["productUpdate", "page*"]);
    expect(() => parseAllowedMutations("*")).toThrow(/not a mutation name/);
    expect(() => parseAllowedMutations("page*,product Update")).toThrow(/not a mutation name/);
  });

  it("the default covers campaign content and discounts, not products, orders or customers", () => {
    const ok = (n: string) => mutationAllowed(n, DEFAULT_ALLOWED_MUTATIONS).ok;
    for (const n of ["pageCreate", "pageUpdate", "articleCreate", "urlRedirectCreate", "discountCodeBasicCreate",
      "discountAutomaticBasicUpdate", "metaobjectUpsert", "metafieldsSet", "fileCreate", "menuUpdate"]) {
      expect(ok(n), n).toBe(true);
    }
    for (const n of ["productCreate", "productUpdate", "productVariantsBulkUpdate", "inventorySetQuantities",
      "orderUpdate", "customerUpdate", "collectionCreate", "themeFilesUpsert", "shopLocaleEnable"]) {
      expect(ok(n), n).toBe(false);
    }
  });

  it("a wildcard never grants a delete; the exact name does", () => {
    expect(mutationAllowed("pageDelete", ["page*"])).toMatchObject({ ok: false, reason: expect.stringMatching(/exact name/) });
    expect(mutationAllowed("discountCodeBulkDelete", ["discountCode*"]).ok).toBe(false);
    expect(mutationAllowed("discountCodeRedeemCodeBulkDelete", ["discountCode*"]).ok).toBe(false);
    expect(mutationAllowed("collectionRemoveProducts", ["collection*"]).ok).toBe(false);
    expect(mutationAllowed("pageDelete", ["page*", "pageDelete"]).ok).toBe(true);
  });

  it("no configuration lifts the hard-deny list", () => {
    const denied = ["refundCreate", "giftCardCreate", "orderCancel", "orderMarkAsPaid", "orderCapture", "orderCreate",
      "orderCreateMandatePayment", "draftOrderComplete", "customerDelete", "customerRequestDataErasure",
      "customerPaymentMethodRevoke", "storefrontAccessTokenCreate", "delegateAccessTokenCreate",
      "webhookSubscriptionCreate", "eventBridgeWebhookSubscriptionCreate", "appSubscriptionCreate",
      "bulkOperationRunMutation", "themePublish", "themeDelete", "shopPolicyUpdate", "paymentTermsCreate",
      "disputeEvidenceUpdate", "transactionVoid"];
    for (const n of denied) {
      expect(isHardDenied(n), n).toBe(true);
      expect(mutationAllowed(n, [n, "order*", "customer*", "theme*", "app*"]).ok, n).toBe(false);
    }
    for (const n of ["pageCreate", "productUpdate", "orderUpdate", "themeFilesUpsert", "customerUpdate", "discountCodeBasicCreate"]) {
      expect(isHardDenied(n), n).toBe(false);
    }
  });
});

describe("assertMutationAllowed", () => {
  const allow = [...DEFAULT_ALLOWED_MUTATIONS];
  const page = "mutation M($page: PageCreateInput!) { pageCreate(page: $page) { page { id } userErrors { field message } } }";

  it("returns the mutation names of an allowed document", () => {
    expect(assertMutationAllowed(page, allow)).toEqual(["pageCreate"]);
    expect(assertMutationAllowed("mutation { a: pageCreate(page: {title: \"x\"}) { page { id } } urlRedirectCreate(urlRedirect: {path: \"/a\", target: \"/b\"}) { urlRedirect { id } } }", allow))
      .toEqual(["pageCreate", "urlRedirectCreate"]);
  });

  it("judges by the real field name, not an alias", () => {
    expect(() => assertMutationAllowed("mutation { pageCreate: refundCreate(input: {}) { refund { id } } }", allow)).toThrow(/refundCreate is never allowed/);
  });

  it("refuses the whole document when one mutation in it is not allowed", () => {
    expect(() => assertMutationAllowed("mutation { pageCreate(page: {title: \"x\"}) { page { id } } productDelete(input: {id: \"1\"}) { deletedProductId } }", allow))
      .toThrow(/productDelete is not enabled/);
  });

  it("refuses a query, several operations, a fragment at the root and a broken document", () => {
    expect(() => assertMutationAllowed("{ shop { name } }", allow)).toThrow(/takes a mutation/);
    expect(() => assertMutationAllowed(`${page} mutation N { pageUpdate(id: "1", page: {}) { page { id } } }`, allow)).toThrow(/exactly one mutation operation/);
    expect(() => assertMutationAllowed("mutation { ...F } fragment F on Mutation { refundCreate(input: {}) { refund { id } } }", allow)).toThrow(/no fragments there/);
    expect(() => assertMutationAllowed("mutation {", allow)).toThrow(/Not a valid GraphQL document/);
  });
});

describe("collectUserErrors", () => {
  it("lifts userErrors out of each mutation payload", () => {
    expect(collectUserErrors({
      pageCreate: { page: null, userErrors: [{ field: ["page", "title"], message: "Title can't be blank" }] },
      urlRedirectCreate: { urlRedirect: { id: "1" }, userErrors: [] },
    })).toEqual(["pageCreate: Title can't be blank (page.title)"]);
    expect(collectUserErrors({ pageCreate: { page: { id: "1" } } })).toEqual([]);
    expect(collectUserErrors(null)).toEqual([]);
  });
});

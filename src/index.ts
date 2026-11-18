// Public package surface: the factory (what the Walma MCP chassis imports),
// the thin Shopify client pieces, and the pure logic for anyone who wants it.

export { createShopifyServer, INSTRUCTIONS, VERSION } from "./server.js";
export {
  createShopifyClient, defaultRequestFn, DEFAULT_API_VERSION,
  type ShopifyClient, type ShopifyClientOptions, type RequestFn,
} from "./shopify.js";
export * as logic from "./logic.js";

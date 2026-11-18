# shopify-mcp — Shopify Admin MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude, Cursor, Claude Code and any other MCP client access to **one Shopify store**: its products, orders and analytics, and any other read query of the Admin GraphQL API. It is read-only by default and can be allowed to make chosen changes.

- **Read-only unless you switch writing on.** Every query is parsed before it is sent, and anything that is not a pure query is refused. Writing is one extra tool that exists only when `SHOPIFY_WRITE_TOOLS` is set, limited to an allowlist of mutations (see [Writing](#writing)). On top of that, the store decides what the app may touch through its access scopes.
- **One store, one credential.** The server is bound to a single store and uses that store's own app. It never holds a user's login.
- **Streamable HTTP as well as stdio.** It can run centrally. This is how [Walma](https://walma.ai) serves it to whole organisations through its AI gateway.
- **Three runtime dependencies.** It calls the Admin GraphQL API directly.

Built and used by [Walma AI](https://walma.ai).

## Tools

| Tool | What it does |
|---|---|
| `get_shop` | The store, its currency and time zone, and the access scopes the app was granted |
| `list_products` | Products with status, vendor, type, tags, total inventory and price range; search filter, sorting, paging |
| `list_orders` | Orders with dates, payment and fulfilment status, totals and line items; search filter, sorting, paging |
| `run_analytics_query` | A ShopifyQL query (`FROM sales SHOW total_sales GROUP BY month SINCE -12m`) |
| `graphql_introspect` | One type of the Admin schema: fields, arguments, enum values |
| `graphql_query` | Any single read query, for what the other tools do not cover |

`list_orders` returns no customer, address or e-mail fields. A caller who needs them can ask through `graphql_query`, and gets them only if the store granted the app the customer scopes.

## Writing

Set `SHOPIFY_WRITE_TOOLS=1` and the server gains a seventh tool, `graphql_mutation`, which runs one mutation. **It changes the live store at once**: Shopify has no dry run and no undo, so have your MCP client ask before each call.

A mutation is sent only if it passes all of this, checked in the server whatever the model is asked to do:

1. **It is on the allowlist.** By default: pages, blog posts, redirects, discounts, metaobjects and metafields, files, menus and marketing activities, which is what campaign work needs. Not products, prices, inventory, orders or customers.
2. **A delete is allowed only by its exact name.** `page*` lets `pageCreate` and `pageUpdate` through, never `pageDelete`.
3. **It is not on the hard-deny list.** Refunds, payments, gift cards, cancelling or creating orders, staff, access tokens, webhooks, customer deletion and data erasure, bulk mutations, and publishing or deleting a theme are refused whatever the allowlist says.

Change the allowlist with `SHOPIFY_ALLOWED_MUTATIONS`, a comma-separated list of mutation names or prefixes ending in `*`. It replaces the default:

```sh
SHOPIFY_ALLOWED_MUTATIONS="page*,discountCode*,productUpdate,pageDelete"
```

The app also needs the matching `write_` scopes (`write_content` or `write_online_store_pages` for pages, `write_discounts` for discounts, and so on). Grant only those.

Shopify reports a refused mutation as `userErrors` in an otherwise successful answer. The tool returns that as an error, so a change that did not happen is not read as done.

Every caller writes as the same app, so the store's activity log shows the app, not the person.

## Setup

### 1. Create the app

Shopify has two kinds of app that fit. Use the first unless the store already has the second.

**An app in the Dev Dashboard (current).** In the [Dev Dashboard](https://dev.shopify.com/dashboard) of the organisation that owns the store: create an app, give it the access scopes below, release a version and install it on the store. Copy its **Client ID** and **Client secret**. The server trades them for an access token that lasts 24 hours and renews it by itself. This works only when the app and the store are in the **same Shopify organisation**.

**A custom app created in the store admin (legacy).** Settings → Apps and sales channels → Develop apps → the app → API credentials. Its **Admin API access token** (`shpat_…`) does not expire.

### 2. Access scopes

Grant only what you want the model to be able to read:

| Scope | Needed for |
|---|---|
| `read_products` | `list_products`, product and collection queries |
| `read_orders` | `list_orders` (the last 60 days) |
| `read_all_orders` | orders older than 60 days |
| `read_reports` | `run_analytics_query` |
| `read_inventory`, `read_locations` | inventory per location |
| `read_customers` | customer queries. Leave it out to keep personal data out of reach |

Grant a `write_` scope only for what you have switched on under [Writing](#writing). The scopes are the second lock.

### 3. Add it to your MCP client

**Claude Code:**

```sh
claude mcp add shopify --scope user \
  -e SHOPIFY_STORE_DOMAIN=example.myshopify.com \
  -e SHOPIFY_CLIENT_ID=your-client-id \
  -e SHOPIFY_CLIENT_SECRET=your-client-secret \
  -- npx -y github:Walma-Labs/shopify-mcp
```

**Claude Desktop, Cursor and others** (`mcpServers` in the client's config):

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "github:Walma-Labs/shopify-mcp"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "example.myshopify.com",
        "SHOPIFY_CLIENT_ID": "your-client-id",
        "SHOPIFY_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

## Configuration

| Variable | |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | Required. `example` or `example.myshopify.com`. Only `*.myshopify.com` is accepted, so the token cannot be sent to another host |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | A Dev Dashboard app. Wins when the static token is also set |
| `SHOPIFY_ACCESS_TOKEN` | A legacy custom app's Admin API token |
| `SHOPIFY_WRITE_TOOLS` | Optional: `1` registers `graphql_mutation`. See [Writing](#writing) |
| `SHOPIFY_ALLOWED_MUTATIONS` | Optional: which mutations, replacing the default list |
| `SHOPIFY_API_VERSION` | Optional, default `2026-10`. Shopify supports a version for at least a year |

## Running over HTTP

```sh
npm run build
PORT=8080 npm run start:http
```

`POST /` is the MCP endpoint (streamable HTTP, stateless) and `GET /healthz` answers `ok`. There is **no authentication** in this process: put it behind something that authenticates callers. Everyone who can reach it reads the store with the app's scopes.

## Using it as a library

```ts
import { createShopifyClient, createShopifyServer } from "@walma-labs/shopify-mcp";

const client = createShopifyClient();          // built once; caches the store's access token
const server = createShopifyServer(client);    // a fresh McpServer per request
```

## Development

```sh
npm install
npm test
```

The tests drive the real MCP wire against a mocked HTTP function, so they need neither network nor a store. The built-in queries are validated against a copy of the parts of the Admin schema they use (`test/logic.spec.ts`); update both together when Shopify renames a field.

## Licence

Apache-2.0.

#!/usr/bin/env node
// stdio entrypoint — what `npx github:Walma-Labs/shopify-mcp` runs, for Claude Code,
// Claude Desktop (local dev servers), Cursor and any stdio MCP client.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createShopifyServer } from "./server.js";

const server = createShopifyServer();
await server.connect(new StdioServerTransport());

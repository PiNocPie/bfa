#!/usr/bin/env node
// BFA MCP server: discover, quote and pay for APIs per call over x402.
// Payments are signed by the agent's NEAR account via Chain Signatures. There is no private EVM key in config.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv } from "./config.js";
import { registerTools } from "./register.js";
import { tools } from "./tools.js";

const server = new McpServer({ name: "bfa", version: "0.1.0" });
registerTools(server, tools(configFromEnv(process.env)));

await server.connect(new StdioServerTransport());

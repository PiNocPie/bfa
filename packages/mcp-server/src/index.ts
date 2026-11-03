#!/usr/bin/env node
// BFA MCP server: discover, quote and pay for APIs per call over x402.
// Payments are signed by the agent's NEAR account via Chain Signatures. There is no private EVM key in config.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { tools, type BfaConfig } from "./tools.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const env = process.env;

const config: BfaConfig = {
  registryDir: resolve(env.BFA_REGISTRY_DIR ?? join(here, "../../../registry")),
  ...(env.BFA_DEV_REGISTRY_DIR && { devRegistryDir: resolve(env.BFA_DEV_REGISTRY_DIR) }),
  stateDir: resolve(env.BFA_STATE_DIR ?? join(homedir(), ".bfa")),
  network: env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet",
  ...(env.NEAR_ACCOUNT_ID && { nearAccountId: env.NEAR_ACCOUNT_ID }),
  ...(env.NEAR_PRIVATE_KEY && { nearPrivateKey: env.NEAR_PRIVATE_KEY }),
  ...(env.NEAR_RPC_URLS && { nearRpcUrls: env.NEAR_RPC_URLS.split(",").map((u) => u.trim()).filter(Boolean) }),
  agentPath: env.BFA_AGENT_PATH ?? "nen/agent-1",
  dailyCapUsd: env.BFA_DAILY_CAP_USD ?? "1",
  maxDepositUsd: env.BFA_MAX_DEPOSIT_USD ?? "0.50",
};

const t = tools(config);
const server = new McpServer({ name: "bfa", version: "0.1.0" });

const json = (v: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
  ...(isError && { isError: true }),
});
const wrap =
  <A>(fn: (a: A) => Promise<unknown>) =>
  async (a: A) => {
    try {
      return json(await fn(a));
    } catch (e) {
      return json(t.errorShape(e), true);
    }
  };

server.registerTool(
  "discover",
  {
    title: "Find APIs",
    description:
      "Search the BFA registry for pay-per-call APIs. Free. Returns only reviewed (routable) listings unless include_not_routable is true. Each hit shows price per call and accepted networks.",
    inputSchema: {
      query: z.string().describe("What you need, e.g. 'near account balance' or 'smart money holdings'"),
      category: z
        .enum(["onchain-data", "market-data", "social", "web", "company", "ai-inference", "near-native", "other"])
        .optional(),
      include_not_routable: z.boolean().optional().describe("Also show pending or suspended listings"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  wrap((a) => t.discover(a)),
);

server.registerTool(
  "inspect",
  {
    title: "Inspect an API listing",
    description:
      "Full details for one listing before paying: input/output JSON Schemas, example input, exact price, empty-result billing policy, accepted schemes and networks, review status (with the approved manifest hash) and observed health. Free.",
    inputSchema: { listing_id: z.string().describe("e.g. nansen/smart-money-holdings") },
    annotations: { readOnlyHint: true },
  },
  wrap((a) => t.inspect(a)),
);

server.registerTool(
  "quote",
  {
    title: "Pick the best provider",
    description:
      "Rank interchangeable listings by reliability, price, latency and honest billing, and return the best one with ordered fallbacks. Free. Pass listing_ids, or a query to rank its discover hits.",
    inputSchema: {
      query: z.string().optional(),
      listing_ids: z.array(z.string()).optional(),
      max_price_usd: z.string().optional().describe("Per-call ceiling as a decimal string, e.g. '0.01'"),
    },
    annotations: { readOnlyHint: true },
  },
  wrap((a) => t.quote(a)),
);

server.registerTool(
  "run",
  {
    title: "Call an API and pay per call",
    description:
      "Call a listing and pay its exact listed price over x402 (never more). Validates input against the listing's input_schema first. On provider failure, tries fallbacks if a query was given. Every call returns a JSON receipt (status, price, scheme, payment tx, latency). Reuse idempotency_key to avoid paying twice for the same task.",
    inputSchema: {
      listing_id: z.string().optional().describe("Call this listing. Either listing_id or query is required."),
      query: z.string().optional().describe("Or: let BFA pick the best listing for this query, with fallbacks"),
      input: z.record(z.string(), z.unknown()).describe("Request body (POST) or query params (GET) per the listing's input_schema"),
      max_price_usd: z.string().optional(),
      idempotency_key: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  wrap((a) => t.run(a)),
);

server.registerTool(
  "receipts",
  {
    title: "Spending and receipts",
    description: "Recent receipts from this agent plus today's total spend against the daily cap. Free.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  },
  wrap((a) => t.receipts(a)),
);

server.registerTool(
  "wallet",
  {
    title: "Agent wallet",
    description:
      "The agent's NEAR account, the Base address derived from it via Chain Signatures (nobody holds its private key), the session key that signs per-call vouchers, USDC balances, and spend limits. Free.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  wrap(() => t.wallet()),
);

server.registerTool(
  "submit_listing",
  {
    title: "Check a listing before submitting it",
    description:
      "Dry run for sellers: validates a bfa.json manifest against the schema and probes the endpoint's unpaid 402 challenge (reachable, x402 V2, price and networks match). Never pays and never publishes. If it passes, open a PR adding the manifest at registry/listings/<id>.json; the BFA team reviews it before it becomes routable.",
    inputSchema: { manifest: z.record(z.string(), z.unknown()).describe("The bfa.json listing manifest") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  wrap((a) => t.submitListing(a)),
);

await server.connect(new StdioServerTransport());

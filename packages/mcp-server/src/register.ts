import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BfaTools, CallContext } from "./tools.js";

export type ToolName = "discover" | "inspect" | "quote" | "run" | "receipts" | "wallet" | "submit_listing";

/**
 * Optional per-connection policy. The stdio server passes none.
 * `around` wraps every tool call: it may throw a BfaError to refuse (the agent gets the error JSON), pass a
 * CallContext to `next` (receipt tagging, listing access, pre-payment guard), and change the result it returns.
 */
export interface ToolPolicy {
  around?: (tool: ToolName, next: (ctx?: CallContext) => Promise<unknown>) => Promise<unknown>;
}

/** Register the 7 BFA tools on an MCP server, backed by one `tools(cfg)` instance. */
export function registerTools(server: McpServer, t: BfaTools, policy: ToolPolicy = {}): void {
  const json = (v: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
    ...(isError && { isError: true }),
  });
  const wrap =
    <A>(tool: ToolName, fn: (a: A, ctx?: CallContext) => Promise<unknown>) =>
    async (a: A) => {
      try {
        const next = (ctx?: CallContext) => fn(a, ctx);
        return json(await (policy.around ? policy.around(tool, next) : next()));
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
    wrap("discover", (a) => t.discover(a)),
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
    wrap("inspect", (a) => t.inspect(a)),
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
    wrap("quote", (a) => t.quote(a)),
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
    wrap("run", (a, ctx) => t.run(a, ctx)),
  );

  server.registerTool(
    "receipts",
    {
      title: "Spending and receipts",
      description: "Recent receipts from this agent plus today's total spend against the daily cap. Free.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    wrap("receipts", (a, ctx) => t.receipts(a, ctx)),
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
    wrap("wallet", (_a, ctx) => t.wallet(ctx)),
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
    wrap("submit_listing", (a) => t.submitListing(a)),
  );
}

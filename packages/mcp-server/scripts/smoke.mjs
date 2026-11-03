#!/usr/bin/env node
// Drives the Nen MCP server over stdio with the official MCP client, the way Claude Code would.
// Uses the dev registry (localhost demo seller) and the testnet account in the environment.
//
//   NEAR_ACCOUNT_ID=nen-testnet.testnet NEAR_PRIVATE_KEY=ed25519:... node scripts/smoke.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(here, "../../..");
const accountId = process.env.NEAR_ACCOUNT_ID ?? "nen-testnet.testnet";
const privateKey =
  process.env.NEAR_PRIVATE_KEY ??
  JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${accountId}.json`), "utf8")).private_key;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repo, "packages/mcp-server/dist/index.js")],
  env: {
    ...process.env,
    NODE_USE_ENV_PROXY: "1",
    NEAR_ACCOUNT_ID: accountId,
    NEAR_PRIVATE_KEY: privateKey,
    NEAR_NETWORK: "testnet",
    NEN_DEV_REGISTRY_DIR: join(repo, "examples/dev-registry"),
    NEN_STATE_DIR: process.env.NEN_STATE_DIR ?? join(repo, ".nen"),
    NEN_DAILY_CAP_USD: "0.10",
  },
  stderr: "ignore",
});
const client = new Client({ name: "nen-smoke", version: "0.1.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const body = JSON.parse(r.content[0].text);
  return { ms: Date.now() - t0, isError: !!r.isError, body };
};

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const d = await call("discover", { query: "near account balance" });
console.log("discover:", JSON.stringify(d.body.hits.map((h) => ({ id: h.id, price: h.price_usd, payable: h.payable_from_this_wallet }))));

const i = await call("inspect", { listing_id: "nen/near-account" });
console.log("inspect:", JSON.stringify({ price: i.body.price, review: i.body.review.status, unchanged: i.body.review.unchanged_since_review, schemes: i.body.schemes }));

const q = await call("quote", { query: "near account balance", max_price_usd: "0.01" });
console.log("quote:", JSON.stringify({ listing: q.body.listing_id, rationale: q.body.rationale }));

const bad = await call("run", { listing_id: "nen/near-account", input: { account: "oops" } });
console.log("run (bad input):", JSON.stringify({ isError: bad.isError, code: bad.body.code, next_action: bad.body.next_action }));

const nansen = await call("run", { listing_id: "nansen/smart-money-holdings", input: { chains: ["ethereum"] } });
console.log("run (unreviewed listing):", JSON.stringify({ isError: nansen.isError, code: nansen.body.code }));

for (let n = 1; n <= 3; n++) {
  const r = await call("run", { query: "near account balance", input: { account_id: "nen-testnet.testnet" }, max_price_usd: "0.01" });
  const rc = r.body.receipt;
  console.log(`run #${n}:`, JSON.stringify({ ms: r.ms, status: rc?.status, scheme: rc?.scheme, price: rc?.price_usd, sign_ms: rc?.sign_ms, exists: r.body.data?.exists }));
}

const rep = await call("run", { listing_id: "nen/near-account", input: { account_id: "nen-testnet.testnet" }, idempotency_key: "smoke-task-1" });
const rep2 = await call("run", { listing_id: "nen/near-account", input: { account_id: "nen-testnet.testnet" }, idempotency_key: "smoke-task-1" });
console.log("idempotency:", JSON.stringify({ same_receipt: rep.body.receipt.receipt_id === rep2.body.receipt.receipt_id, replayed: rep2.body.replayed }));

const w = await call("wallet");
console.log("wallet:", JSON.stringify({ near: w.body.near_account, payer: w.body.payer_address, controlled_by: w.body.payer_address_controlled_by, usdc: w.body.usdc_balance, spent_today: w.body.spent_today_usd }));

const manifest = JSON.parse(readFileSync(join(repo, "examples/dev-registry/listings/nen/near-account.json"), "utf8"));
const s = await call("submit_listing", { manifest });
console.log("submit_listing:", JSON.stringify({ schema_valid: s.body.schema_valid, passed: s.body.passed, failed: s.body.bot_report?.checks.filter((c) => !c.ok).map((c) => c.id) }));

const rc = await call("receipts", { limit: 3 });
console.log("receipts:", JSON.stringify({ spent_today: rc.body.spent_today_usd, cap: rc.body.daily_cap_usd, last: rc.body.receipts.map((x) => x.status) }));

await client.close();

#!/usr/bin/env node
// Live check of the hosted gateway: connects over Streamable HTTP with a BFA API key and makes paid
// calls until the key's daily limit refuses one. Read the key from BFA_API_KEY; it is never printed.
//
//   BFA_API_KEY=bfa_sk_test_... GATEWAY_URL=http://127.0.0.1:8787/v1 node packages/gateway/scripts/smoke-http.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const key = process.env.BFA_API_KEY;
if (!key) throw new Error("set BFA_API_KEY");
const url = new URL(process.env.GATEWAY_URL ?? "http://127.0.0.1:8787/v1");
const calls = Number(process.env.CALLS ?? 3);

const unauth = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
console.log("no key:", unauth.status);

const client = new Client({ name: "bfa-gateway-smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  return { ms: Date.now() - t0, isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};

for (let n = 1; n <= calls; n++) {
  const r = await call("run", { listing_id: "bfa/near-account", input: { account_id: "nen-testnet.testnet" } });
  const b = r.body;
  console.log(`run #${n}:`, JSON.stringify(r.isError ? { ms: r.ms, code: b.code, next_action: b.next_action, resets_at: b.resets_at } : { ms: r.ms, status: b.receipt?.status, price: b.receipt?.price_usd, key_id: b.receipt?.key_id }));
}
const w = await call("wallet");
console.log("wallet:", JSON.stringify({ payer: w.body.payer_address, key: w.body.key }));
await client.close();

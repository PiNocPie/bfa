#!/usr/bin/env node
// A scripted agent session against a BFA gateway, for demos: discover → inspect → paid runs until the key's daily
// limit refuses one. Every tool call and its real response is written as JSON lines to OUT (default stdout), so a
// recording can replay exactly what happened. The API key is read from BFA_API_KEY and never printed.
//
//   BFA_API_KEY=bfa_sk_test_... GATEWAY_URL=http://127.0.0.1:8787/v1 OUT=session.jsonl node packages/gateway/scripts/agent-demo.mjs
import { appendFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const key = process.env.BFA_API_KEY;
if (!key) throw new Error("set BFA_API_KEY");
const url = new URL(process.env.GATEWAY_URL ?? "http://127.0.0.1:8787/v1");
const runs = Number(process.env.RUNS ?? 4);
const out = process.env.OUT;
if (out) writeFileSync(out, "");
const emit = (o) => (out ? appendFileSync(out, JSON.stringify(o) + "\n") : console.log(JSON.stringify(o)));

const client = new Client({ name: "bfa-demo-agent", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
async function call(name, args = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const body = JSON.parse(r.content[0].text);
  emit({ tool: name, args, ms: Date.now() - t0, error: !!r.isError, body });
  return body;
}

await call("discover", { query: "near account" });
await call("inspect", { listing_id: "bfa/near-account" });
for (let n = 1; n <= runs; n++) {
  const b = await call("run", { listing_id: "bfa/near-account", input: { account_id: "nen-testnet.testnet" }, max_price_usd: "0.01" });
  if (b.code === "limit_reached") break;
}
await client.close();

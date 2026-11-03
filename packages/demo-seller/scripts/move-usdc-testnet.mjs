#!/usr/bin/env node
// Testnet helper: move USDC from the agent's Chain Signatures address to another address on Base
// Sepolia without anyone holding ETH for gas. It starts a one-route x402 seller whose payTo is the
// destination, then pays it once with `exact` from the agent wallet; the public facilitator settles.
//
//   NEAR_ACCOUNT_ID=nen-testnet.testnet TO=0x... AMOUNT=5 node packages/demo-seller/scripts/move-usdc-testnet.mjs
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { Hono } from "hono";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const client = await import(join(repo, "packages/x402-client/dist/index.js"));
const { ReceiptLog } = await import(join(repo, "packages/core/dist/index.js"));

const to = process.env.TO;
const amount = process.env.AMOUNT ?? "5";
if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? "")) throw new Error("set TO=0x… destination");
const accountId = process.env.NEAR_ACCOUNT_ID ?? "nen-testnet.testnet";
const privateKey =
  process.env.NEAR_PRIVATE_KEY ??
  JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${accountId}.json`), "utf8")).private_key;
const NETWORK = "eip155:84532";
const PORT = Number(process.env.PORT ?? 8411);

const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" })).register(
  NETWORK,
  new ExactEvmScheme(),
);
const app = new Hono();
app.use(
  paymentMiddleware(
    {
      "POST /move": {
        accepts: [{ scheme: "exact", price: `$${amount}`, network: NETWORK, payTo: to }],
        description: "testnet USDC move",
        mimeType: "application/json",
      },
    },
    rs,
  ),
);
app.post("/move", (c) => c.json({ moved_usd: amount, to }));
const server = serve({ fetch: app.fetch, port: PORT });

const signer = await client.chainSignaturesSigner({
  mpc: client.nearMpc({ networkId: "testnet", caller: client.nearAccount({ accountId, privateKey, networkId: "testnet" }) }),
  predecessor: accountId,
  path: process.env.BFA_AGENT_PATH ?? "nen/agent-1",
});
const listing = {
  manifest_version: 1,
  id: "dev/move-usdc",
  provider: { name: "dev" },
  name: "move",
  description: "move",
  categories: ["other"],
  endpoint: {
    url: `http://localhost:${PORT}/move`,
    method: "POST",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    example_input: {},
  },
  pricing: { model: "per_call", amount_usd: amount, charges_empty_results: true },
  payment: { protocol: "x402", schemes: ["exact"], networks: [NETWORK], payout: { via: "direct" } },
  data: { sources: "dev", license_statement: "dev" },
};
const { receipt } = await client.callListing({
  listing,
  input: {},
  signer,
  log: new ReceiptLog(join(tmpdir(), "bfa-move-receipts.jsonl")),
  dailyCapUsd: process.env.DAILY_CAP_USD ?? "100",
});
console.log(
  JSON.stringify({ from: signer.address, to, status: receipt.status, price_usd: receipt.price_usd, payment_tx: receipt.payment_tx ?? null, error: receipt.error ?? null }),
);
server.close();

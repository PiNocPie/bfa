#!/usr/bin/env node
// End-to-end on testnets: a NEAR testnet account pays the BFA demo seller per call over x402 on Base Sepolia.
// Call 1 opens a batch-settlement channel: its deposit is signed by NEAR Chain Signatures (~25s, once).
// Calls 2..N are vouchers signed by the local session key (no MPC round-trip).
//
// Prereqs: demo seller running (packages/demo-seller), and test USDC on the agent's derived Base Sepolia
// address (scripts/chainsig-testnet.mjs prints it; fund it at https://faucet.circle.com -> Base Sepolia).
//
//   NODE_USE_ENV_PROXY=1 NEAR_ACCOUNT_ID=nen-testnet.testnet node scripts/e2e-testnet.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReceiptLog } from "@bfa/core";
import { callListing, chainSignaturesSigner, loadOrCreateSessionSigner, nearAccount, nearMpc, NETWORKS } from "../dist/index.js";

const accountId = process.env.NEAR_ACCOUNT_ID;
if (!accountId) throw new Error("set NEAR_ACCOUNT_ID");
const privateKey =
  process.env.NEAR_PRIVATE_KEY ??
  JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${accountId}.json`), "utf8")).private_key;
const state = process.env.BFA_STATE_DIR ?? join(homedir(), ".bfa");
const calls = Number(process.env.CALLS ?? 5);
const sellerUrl = process.env.SELLER_URL ?? "http://localhost:8402/near/account";

const rpcUrls = process.env.NEAR_RPC_URLS?.split(",").map((u) => u.trim()).filter(Boolean);
const account = nearAccount({ accountId, privateKey, networkId: "testnet", ...(rpcUrls && { rpcUrls }) });
const signer = await chainSignaturesSigner({
  mpc: nearMpc({ networkId: "testnet", caller: account }),
  predecessor: accountId,
  path: process.env.BFA_AGENT_PATH ?? "nen/agent-1",
});
const session = {
  signer: await loadOrCreateSessionSigner(join(state, "session.key")),
  channelDir: join(state, "channels"),
  maxDepositUsd: process.env.MAX_DEPOSIT_USD ?? "0.05",
};
const log = new ReceiptLog(join(state, "receipts.jsonl"));

const listing = {
  manifest_version: 1,
  id: "bfa/near-account",
  provider: { name: "BFA demo seller", url: "https://github.com/PiNocPie/bfa", contact: "github:PiNocPie" },
  name: "NEAR testnet account state",
  description: "Balance, storage and contract flag for one NEAR testnet account, sold per call.",
  categories: ["near-native"],
  endpoint: {
    url: sellerUrl,
    method: "POST",
    input_schema: { type: "object", required: ["account_id"] },
    output_schema: { type: "object", required: ["account_id", "exists"] },
    example_input: { account_id: accountId },
  },
  pricing: { model: "per_call", amount_usd: "0.001" },
  payment: { protocol: "x402", schemes: ["batch-settlement", "exact"], networks: [NETWORKS.baseSepolia], payout: { via: "direct" } },
  data: { sources: "NEAR testnet RPC", license_statement: "Public chain data served by the BFA demo seller." },
};

console.log(JSON.stringify({ agent_near: accountId, agent_base: signer.address, session_key: session.signer.address, calls }));
for (let i = 1; i <= calls; i++) {
  const { receipt, data } = await callListing({ listing, input: { account_id: accountId }, signer, log, session, dailyCapUsd: "0.10" });
  console.log(
    JSON.stringify({
      call: i,
      status: receipt.status,
      scheme: receipt.scheme,
      price_usd: receipt.price_usd,
      latency_ms: receipt.latency_ms,
      sign_ms: receipt.sign_ms,
      payment_tx: receipt.payment_tx,
      error: receipt.error?.message,
      exists: data?.exists,
    }),
  );
}

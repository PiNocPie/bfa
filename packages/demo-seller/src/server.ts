// BFA demo seller: a real NEAR-native endpoint sold per call over x402 V2 on Base Sepolia.
// Accepts both `exact` (one transfer per call) and `batch-settlement` (vouchers against a channel deposit).
//
//   SELLER_PAY_TO=0x... node dist/server.js
//   curl -i -X POST localhost:8402/near/account -H 'content-type: application/json' -d '{"account_id":"nen-testnet.testnet"}'
//   -> 402 with PAYMENT-REQUIRED; pay with @bfa/x402-client.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { FileChannelStorage } from "@x402/evm/batch-settlement/server/file-storage";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { Hono } from "hono";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const NETWORK = "eip155:84532"; // Base Sepolia
const PRICE = "$0.001";
const PORT = Number(process.env.PORT ?? 8402);
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
// Fastest first; NEAR's own free RPC is slow and returns HTML error pages when rate-limited.
const NEAR_RPCS = (process.env.NEAR_RPC_URLS ?? "https://test.rpc.fastnear.com,https://rpc.testnet.near.org")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

/** view_account against each RPC in turn (15s timeout each by default), rejecting non-JSON bodies. */
async function viewAccount(accountId: string): Promise<{ result?: Record<string, unknown> } | undefined> {
  for (const url of NEAR_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(Number(process.env.NEAR_RPC_TIMEOUT_MS ?? 15000)),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bfa",
          method: "query",
          params: { request_type: "view_account", finality: "final", account_id: accountId },
        }),
      });
      if (!(res.headers.get("content-type") ?? "").includes("json")) continue;
      return (await res.json()) as { result?: Record<string, unknown> };
    } catch {
      // try the next RPC
    }
  }
  return undefined;
}
const payTo = process.env.SELLER_PAY_TO as `0x${string}` | undefined;
if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
  throw new Error("set SELLER_PAY_TO to the 0x address that receives USDC on Base Sepolia");
}

// State dir (gitignored): the receiver-authorizer key and batch-settlement channel state.
// The authorizer key only co-signs voucher claims/refunds; settled USDC always goes to `payTo`.
const STATE_DIR = process.env.BFA_SELLER_STATE_DIR ?? ".bfa-seller";
async function loadOrCreateKey(file: string): Promise<`0x${string}`> {
  try {
    return (await readFile(file, "utf8")).trim() as `0x${string}`;
  } catch {
    const key = generatePrivateKey();
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(file, key + "\n", { mode: 0o600 });
    await chmod(file, 0o600);
    return key;
  }
}
const receiverAuthorizer = privateKeyToAccount(await loadOrCreateKey(join(STATE_DIR, "receiver-authorizer.key")));

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitator)
  .register(NETWORK, new ExactEvmScheme())
  .register(
    NETWORK,
    new BatchSettlementEvmScheme(payTo, {
      receiverAuthorizerSigner: receiverAuthorizer,
      storage: new FileChannelStorage({ directory: join(STATE_DIR, "channels") }),
    }),
  );

const app = new Hono();

app.get("/", (c) =>
  c.json({
    name: "BFA demo seller",
    endpoints: [{ method: "POST", path: "/near/account", price_usd: "0.001", network: NETWORK, schemes: ["batch-settlement", "exact"] }],
  }),
);

app.use(
  paymentMiddleware(
    {
      "POST /near/account": {
        accepts: [
          { scheme: "batch-settlement", price: PRICE, network: NETWORK, payTo },
          { scheme: "exact", price: PRICE, network: NETWORK, payTo },
        ],
        description: "NEAR testnet account state (balance, storage, code hash) for one account id.",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.post("/near/account", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { account_id?: unknown };
  const accountId = typeof body.account_id === "string" ? body.account_id : "";
  if (!/^[a-z0-9._-]{2,64}$/.test(accountId)) return c.json({ error: "account_id required" }, 400);
  const json = await viewAccount(accountId);
  // A non-2xx response means the x402 middleware does not settle: the agent is not charged.
  if (!json) {
    c.header("Retry-After", "5");
    return c.json({ error: "upstream NEAR RPC unavailable", next_action: "retry_after", retry_after_s: 5 }, 503);
  }
  if (!json.result) return c.json({ account_id: accountId, exists: false });
  const r = json.result as { amount: string; locked: string; storage_usage: number; code_hash: string; block_height: number };
  return c.json({
    account_id: accountId,
    exists: true,
    balance_yocto: r.amount,
    locked_yocto: r.locked,
    storage_bytes: r.storage_usage,
    has_contract: r.code_hash !== "11111111111111111111111111111111",
    block_height: r.block_height,
  });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(JSON.stringify({ msg: "bfa demo seller listening", port: info.port, network: NETWORK, payTo }));
});

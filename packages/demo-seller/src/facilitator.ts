// BFA's own x402 facilitator for testnet: verifies and settles exact and batch-settlement USDC payments on Base
// Sepolia, so paid calls don't depend on a public facilitator having gas. It speaks the standard facilitator HTTP
// API (GET /supported, POST /verify, POST /settle) that HTTPFacilitatorClient expects.
//
// Its EVM key only pays gas: every payment it submits is an EIP-3009 authorization the payer signed for a fixed
// recipient and amount, so this key cannot move anyone's USDC. The key is generated on first start and kept in
// BFA_FACILITATOR_STATE_DIR (mode 0600); fund its address with a little Base Sepolia ETH.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { Hono } from "hono";
import { createWalletClient, formatEther, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const PORT = Number(process.env.FACILITATOR_PORT ?? 8403);
const HOST = process.env.FACILITATOR_HOST ?? "127.0.0.1";
const STATE_DIR = process.env.BFA_FACILITATOR_STATE_DIR ?? ".bfa-facilitator";
const NETWORK = "eip155:84532" as const;

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

const account = privateKeyToAccount(await loadOrCreateKey(join(STATE_DIR, "facilitator.key")));
const client = createWalletClient({ account, chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) }).extend(publicActions);

const signer = toFacilitatorEvmSigner({
  address: account.address,
  readContract: (a) => client.readContract({ ...a, args: a.args ?? [] } as never),
  verifyTypedData: (a) => client.verifyTypedData(a as never),
  writeContract: (a) => client.writeContract({ ...a, args: a.args ?? [], account, chain: baseSepolia } as never),
  sendTransaction: (a) => client.sendTransaction({ ...a, account, chain: baseSepolia }),
  waitForTransactionReceipt: (a) => client.waitForTransactionReceipt(a),
  getCode: (a) => client.getCode(a),
});

const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmScheme(signer)).register(NETWORK, new BatchSettlementEvmScheme(signer));

const app = new Hono();
const fail = (e: unknown) => ({ error: (e as Error)?.message?.slice(0, 300) ?? String(e) });

app.get("/supported", (c) => c.json(facilitator.getSupported()));
app.post("/verify", async (c) => {
  try {
    const b = await c.req.json();
    return c.json(await facilitator.verify(b.paymentPayload, b.paymentRequirements));
  } catch (e) {
    return c.json(fail(e), 500);
  }
});
app.post("/settle", async (c) => {
  try {
    const b = await c.req.json();
    const r = await facilitator.settle(b.paymentPayload, b.paymentRequirements);
    if (!r.success) console.error(JSON.stringify({ msg: "settle failed", reason: r.errorReason, network: r.network }));
    return c.json(r);
  } catch (e) {
    return c.json(fail(e), 500);
  }
});
app.get("/healthz", (c) => c.json({ ok: true, address: account.address }));

serve({ fetch: app.fetch, port: PORT, hostname: HOST });
const gas = await client.getBalance({ address: account.address }).catch(() => undefined);
console.log(JSON.stringify({ msg: "bfa facilitator listening", port: PORT, network: NETWORK, gas_payer: account.address, gas_eth: gas === undefined ? null : formatEther(gas) }));

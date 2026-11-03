#!/usr/bin/env node
// Bridge Sepolia ETH to Base Sepolia from a keyless address controlled by a NEAR account.
// The transaction is signed by NEAR Chain Signatures (nobody holds the EVM key) and sent to Base's
// L1StandardBridge on Sepolia; plain ETH sent to it is credited to the same address on Base Sepolia
// after a few minutes.
//
//   NEAR_ACCOUNT_ID=nen-testnet.testnet DERIVATION_PATH=bfa/deployer AMOUNT_ETH=0.04 \
//     NODE_USE_ENV_PROXY=1 node packages/x402-client/scripts/bridge-sepolia-to-base.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, formatEther, http, keccak256, parseEther, serializeTransaction } from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import { nearAccount, nearMpc } from "../dist/index.js";

// Base Sepolia's L1StandardBridge proxy on Ethereum Sepolia (from Base's contract address docs).
const L1_STANDARD_BRIDGE = process.env.L1_STANDARD_BRIDGE ?? "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";
const L1_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const accountId = process.env.NEAR_ACCOUNT_ID ?? "nen-testnet.testnet";
const path = process.env.DERIVATION_PATH ?? "bfa/deployer";
const privateKey =
  process.env.NEAR_PRIVATE_KEY ??
  JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${accountId}.json`), "utf8")).private_key;

const l1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
const l2 = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const mpc = nearMpc({ networkId: "testnet", caller: nearAccount({ accountId, privateKey, networkId: "testnet" }) });
const from = await mpc.deriveEvmAddress(accountId, path);

const [l1Bal, l2Bal] = await Promise.all([l1.getBalance({ address: from }), l2.getBalance({ address: from })]);
console.log(`address ${from} (path ${path}): Sepolia ${formatEther(l1Bal)} ETH, Base Sepolia ${formatEther(l2Bal)} ETH`);

// Sanity check: the bridge must be a contract whose OTHER_BRIDGE is the L2 standard bridge predeploy.
const code = await l1.getCode({ address: L1_STANDARD_BRIDGE });
if (!code || code === "0x") throw new Error(`no contract at ${L1_STANDARD_BRIDGE} on Sepolia`);
const other = await l1.readContract({
  address: L1_STANDARD_BRIDGE,
  abi: [{ type: "function", name: "OTHER_BRIDGE", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
  functionName: "OTHER_BRIDGE",
});
if (other.toLowerCase() !== "0x4200000000000000000000000000000000000010") throw new Error(`unexpected OTHER_BRIDGE ${other}`);
console.log("bridge check ok:", L1_STANDARD_BRIDGE, "→", other);

if (process.env.DRY_RUN) process.exit(0);

const fees = await l1.estimateFeesPerGas();
const gas = (await l1.estimateGas({ account: from, to: L1_STANDARD_BRIDGE, value: 1n })) * 2n; // headroom for the L2 gas burn
const budget = gas * fees.maxFeePerGas;
const value = process.env.AMOUNT_ETH ? parseEther(process.env.AMOUNT_ETH) : l1Bal - budget;
if (value <= 0n || value + budget > l1Bal) throw new Error(`not enough Sepolia ETH: have ${formatEther(l1Bal)}, need ${formatEther(value + budget)}`);

const tx = {
  type: "eip1559",
  chainId: sepolia.id,
  nonce: await l1.getTransactionCount({ address: from }),
  to: L1_STANDARD_BRIDGE,
  value,
  gas,
  maxFeePerGas: fees.maxFeePerGas,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
};
const t0 = Date.now();
const rsv = await mpc.signHash(accountId, path, keccak256(serializeTransaction(tx)));
const yParity = (rsv.v >= 27 ? rsv.v - 27 : rsv.v);
const raw = serializeTransaction(tx, { r: `0x${rsv.r.padStart(64, "0")}`, s: `0x${rsv.s.padStart(64, "0")}`, yParity });
const hash = await l1.sendRawTransaction({ serializedTransaction: raw });
console.log(`signed by NEAR MPC in ${Date.now() - t0} ms; sent ${formatEther(value)} ETH: https://sepolia.etherscan.io/tx/${hash}`);
const rcpt = await l1.waitForTransactionReceipt({ hash, timeout: 180_000 });
console.log("L1 status:", rcpt.status, "block", rcpt.blockNumber);

for (let i = 0; i < 40; i++) {
  const b = await l2.getBalance({ address: from });
  if (b > l2Bal) { console.log(`arrived on Base Sepolia: ${formatEther(b)} ETH`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 15_000));
}
console.log("not on Base Sepolia yet; deposits usually land within a few minutes. Check again with DRY_RUN=1.");

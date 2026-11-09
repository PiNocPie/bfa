#!/usr/bin/env node
// Sends Base Sepolia ETH for gas from BFA's NEAR-controlled address (Chain Signatures, path bfa/deployer) to TO,
// e.g. to fund the facilitator's gas payer. Testnet only.
//
//   NEAR_ACCOUNT_ID=nen-testnet.testnet NEAR_PRIVATE_KEY=ed25519:... TO=0x... ETH=0.005 node packages/gateway/scripts/fund-gas.mjs
import { nearAccount, nearMpc } from "@bfa/x402-client";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, serializeTransaction } from "viem";
import { toAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const accountId = process.env.NEAR_ACCOUNT_ID ?? "nen-testnet.testnet";
const privateKey = process.env.NEAR_PRIVATE_KEY;
const to = process.env.TO;
const eth = process.env.ETH ?? "0.005";
const path = process.env.DERIVATION_PATH ?? "bfa/deployer";
if (!privateKey) throw new Error("set NEAR_PRIVATE_KEY");
if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? "")) throw new Error("set TO=0x… address");
if (Number(eth) > 0.02) throw new Error("refusing to send more than 0.02 ETH in one go");

const mpc = nearMpc({ networkId: "testnet", caller: nearAccount({ accountId, privateKey, networkId: "testnet" }) });
const from = await mpc.deriveEvmAddress(accountId, path);
const account = toAccount({
  address: from,
  async signTransaction(tx, opts) {
    const ser = opts?.serializer ?? serializeTransaction;
    const rsv = await mpc.signHash(accountId, path, keccak256(ser(tx)));
    return ser(tx, { r: `0x${rsv.r.padStart(64, "0")}`, s: `0x${rsv.s.padStart(64, "0")}`, yParity: rsv.v >= 27 ? rsv.v - 27 : rsv.v });
  },
  async signMessage() { throw new Error("not supported"); },
  async signTypedData() { throw new Error("not supported"); },
});
const pub = createPublicClient({ chain: baseSepolia, transport: http() });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });
console.log(`from ${from} (${formatEther(await pub.getBalance({ address: from }))} ETH) → ${to}: ${eth} ETH`);
const hash = await wallet.sendTransaction({ to, value: parseEther(eth) });
await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
console.log(`sent: ${hash}; ${to} now has ${formatEther(await pub.getBalance({ address: to }))} ETH`);

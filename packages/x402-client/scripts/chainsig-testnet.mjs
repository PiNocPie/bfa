#!/usr/bin/env node
// Live check: sign an x402 (EIP-3009) payment authorization with NEAR Chain Signatures on testnet,
// then verify the signature locally against the derived Base address. No Base RPC or funds needed.
//
//   NEAR_ACCOUNT_ID=nen-testnet.testnet NEAR_PRIVATE_KEY=ed25519:... node scripts/chainsig-testnet.mjs
// or, with a near-cli legacy keychain file:
//   NEAR_ACCOUNT_ID=nen-testnet.testnet node scripts/chainsig-testnet.mjs
//
// Cost: one testnet transaction (~0.03 testnet NEAR in gas + 1 yoctoNEAR deposit).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account } from "near-api-js";
import { verifyTypedData } from "viem";
import { chainSignaturesSigner, nearMpc } from "../dist/index.js";

const accountId = process.env.NEAR_ACCOUNT_ID;
if (!accountId) throw new Error("set NEAR_ACCOUNT_ID");
const privateKey =
  process.env.NEAR_PRIVATE_KEY ??
  JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${accountId}.json`), "utf8")).private_key;
const rpc = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const path = process.env.NEN_AGENT_PATH ?? "nen/agent-1";

const account = new Account(accountId, rpc, privateKey);
const mpc = nearMpc({ networkId: "testnet", caller: account });
const signer = await chainSignaturesSigner({ mpc, predecessor: accountId, path });
console.log(JSON.stringify({ step: "derived", near_account: accountId, path, base_address: signer.address }));

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const typed = {
  domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: signer.address,
    to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    value: 10000n, // $0.01 USDC
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
    nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`,
  },
};

const t0 = Date.now();
const signature = await signer.signTypedData(typed);
const ms = Date.now() - t0;
const valid = await verifyTypedData({ ...typed, address: signer.address, signature });
console.log(JSON.stringify({ step: "signed", mpc_latency_ms: ms, signature, valid_for_derived_address: valid }));
if (!valid) process.exit(1);

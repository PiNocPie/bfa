#!/usr/bin/env node
// Deploy the BFA treasury to NEAR testnet, create a vault for the parent account, and prove one
// signature end to end: the treasury checks the policy, asks the MPC network to sign, and the
// signature recovers to the vault's derived Base address.
//
//   NEAR_ACCOUNT_ID=nen-testnet.testnet node contracts/treasury/scripts/deploy-testnet.mjs
//
// The parent account's key is read from NEAR_PRIVATE_KEY or ~/.near-credentials (never printed).
// The treasury account's new key is written to ~/.near-credentials/testnet/<id>.json (mode 0600).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const req = createRequire(join(repo, "packages/x402-client/package.json"));
const { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair } = req("near-api-js");
const { contracts, utils } = req("chainsig.js");
const { recoverAddress } = req("viem");
const { publicKeyToAddress } = req("viem/accounts");

const parentId = process.env.NEAR_ACCOUNT_ID ?? "nen-testnet.testnet";
const treasuryId = process.env.TREASURY_ID ?? `treasury.${parentId}`;
const MPC = "v1.signer-prod.testnet";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const credDir = join(homedir(), ".near-credentials", "testnet");
const keyOf = (id) => process.env.NEAR_PRIVATE_KEY && id === parentId
  ? process.env.NEAR_PRIVATE_KEY
  : JSON.parse(readFileSync(join(credDir, `${id}.json`), "utf8")).private_key;

const provider = new FailoverRpcProvider(
  ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"].map(
    (url) => new JsonRpcProvider({ url }, { retries: 3, wait: 500, backoff: 1.5 }),
  ),
);
const parent = new Account(parentId, provider, keyOf(parentId));
const TGAS = 1_000_000_000_000n;
const NEAR = 10n ** 24n;

async function exists(id) {
  try { await provider.query({ request_type: "view_account", account_id: id, finality: "final" }); return true; }
  catch { return false; }
}

// 1. Treasury account
if (!(await exists(treasuryId))) {
  const kp = KeyPair.fromRandom("ed25519");
  mkdirSync(credDir, { recursive: true });
  const file = join(credDir, `${treasuryId}.json`);
  writeFileSync(file, JSON.stringify({ account_id: treasuryId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  chmodSync(file, 0o600);
  await parent.createAccount({ newAccountId: treasuryId, publicKey: kp.getPublicKey(), nearToTransfer: 3n * NEAR });
  console.log("created", treasuryId);
} else console.log("exists ", treasuryId);
const treasury = new Account(treasuryId, provider, keyOf(treasuryId));

// 2. Code + init
const wasm = readFileSync(join(here, "../target/wasm32-unknown-unknown/release/bfa_treasury.wasm"));
if (process.env.REDEPLOY || !(await provider.query({ request_type: "view_code", account_id: treasuryId, finality: "final" }).then(() => true, () => false))) {
  const deployTx = await treasury.deployContract(new Uint8Array(wasm));
  console.log("deployed", wasm.length, "bytes", deployTx?.transaction?.hash ?? "");
} else console.log("code already deployed");
const view = async (method, args = {}) => {
  const r = await provider.query({ request_type: "call_function", account_id: treasuryId, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), finality: "optimistic" });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};
let inited = true;
try { await view("tokens"); } catch { inited = false; }
if (!inited) {
  await treasury.callFunction({ contractId: treasuryId, methodName: "new", args: { mpc: MPC, tokens: [[84532, USDC_BASE_SEPOLIA]] }, gas: 30n * TGAS, deposit: 0n });
  console.log("initialized");
}
console.log("tokens", JSON.stringify(await view("tokens")));

// 3. Vault for the parent account: $1.00/day, any recipient
let vault = await view("get_vault", { account_id: parentId });
if (!vault) {
  vault = await parent.callFunction({ contractId: treasuryId, methodName: "create_vault", args: { daily_limit: "1000000", allowed_to: [] }, gas: 30n * TGAS, deposit: 20n * 10n ** 21n });
  console.log("vault created");
}
console.log("vault", JSON.stringify(await view("get_vault", { account_id: parentId })));

// 4. Derived address for this vault
const path = await view("derivation_path", { account_id: parentId });
const mpc = new contracts.ChainSignatureContract({ networkId: "testnet", contractId: MPC });
const pub = await mpc.getDerivedPublicKey({ path, predecessor: treasuryId });
const vaultAddress = publicKeyToAddress(`0x${pub}`);
console.log("vault address", vaultAddress, "path", path);

// 5. One signature end to end
const request = {
  kind: "transfer", chain_id: 84532, token: USDC_BASE_SEPOLIA, domain_name: "USDC", domain_version: "2",
  from: vaultAddress, to: "0x11F4555ABdaa2BC5b39A172E39b69E8293ad4aA3", value: "1000",
  valid_after: "0", valid_before: String(Math.floor(Date.now() / 1000) + 600),
  nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`,
};
const { hashTypedData } = req("viem");
const t = [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }];
const digest = hashTypedData({
  domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC_BASE_SEPOLIA },
  types: { TransferWithAuthorization: t }, primaryType: "TransferWithAuthorization",
  message: { from: vaultAddress, to: request.to, value: 1000n, validAfter: 0n, validBefore: BigInt(request.valid_before), nonce: request.nonce },
});
const t0 = Date.now();
const sig = await parent.callFunction({ contractId: treasuryId, methodName: "sign_eip3009", args: { request }, gas: 300n * TGAS, deposit: 0n });
const ms = Date.now() - t0;
if (!sig) throw new Error("treasury returned no signature");
const rsv = utils.cryptography.toRSV(sig);
const v = BigInt(rsv.v < 27 ? rsv.v + 27 : rsv.v);
const recovered = await recoverAddress({ hash: digest, signature: { r: `0x${rsv.r}`, s: `0x${rsv.s}`, v } });
console.log("signed in", ms, "ms; recovered", recovered, recovered.toLowerCase() === vaultAddress.toLowerCase() ? "= vault address ✓" : "≠ vault address ✗");
console.log("vault after", JSON.stringify(await view("get_vault", { account_id: parentId })));

// 6. Over the limit must be refused by the contract
try {
  await parent.callFunction({ contractId: treasuryId, methodName: "sign_eip3009", args: { request: { ...request, value: "2000000" } }, gas: 300n * TGAS, deposit: 0n });
  console.log("over-limit request was NOT refused ✗");
} catch (e) {
  console.log("over-limit refused ✓", String(e.message ?? e).match(/limit_reached/) ? "(limit_reached)" : String(e.message ?? e).slice(0, 160));
}

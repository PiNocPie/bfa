// The user's NEAR key lives only in this browser. It owns the user's implicit account, which owns their treasury
// vault. The gateway gets a function-call key that can call nothing but sign_eip3009.
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";

const STORE = (email: string) => `bfa.nearKey.${email}`;
const TGAS = 1_000_000_000_000n;
const NEAR = 10n ** 24n;

export interface StoredKey {
  account_id?: string;
  public_key: string;
  secret_key: string;
}

export function loadKey(email: string): StoredKey | null {
  try {
    const raw = localStorage.getItem(STORE(email));
    return raw ? (JSON.parse(raw) as StoredKey) : null;
  } catch {
    return null;
  }
}

export function saveKey(email: string, k: StoredKey): void {
  try {
    localStorage.setItem(STORE(email), JSON.stringify(k));
  } catch {
    /* private mode: the recovery file is the only copy */
  }
}

export function newKey(): StoredKey {
  const kp = KeyPair.fromRandom("ed25519");
  return { public_key: kp.getPublicKey().toString(), secret_key: kp.toString() };
}

export function parseRecovery(text: string): StoredKey {
  const k = JSON.parse(text) as StoredKey;
  if (!k.secret_key?.startsWith("ed25519:") || !k.public_key?.startsWith("ed25519:")) throw new Error("this is not a BFA recovery file");
  if (KeyPair.fromString(k.secret_key as `ed25519:${string}`).getPublicKey().toString() !== k.public_key) throw new Error("the recovery file is damaged");
  return k;
}

export function recoveryBlob(email: string, k: StoredKey): Blob {
  const doc = {
    what: "BFA wallet recovery key. Whoever has this file controls your BFA wallet. Keep it offline.",
    email,
    network: "testnet",
    ...k,
    created_at: new Date().toISOString(),
  };
  return new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
}

function account(k: StoredKey): Account {
  if (!k.account_id) throw new Error("wallet has no account yet");
  const provider = new JsonRpcProvider({ url: `${location.origin}/api/near/rpc` });
  return new Account(k.account_id, provider, k.secret_key as `ed25519:${string}`);
}

export async function waitForAccount(k: StoredKey, tries = 20): Promise<void> {
  const a = account(k);
  for (let i = 0; i < tries; i++) {
    try {
      await a.getState();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error("your NEAR account did not appear yet; try again in a minute");
}

/** Gives the gateway a key that may call only the treasury's sign_eip3009, with a small gas allowance. */
export async function addAgentKey(k: StoredKey, agentPublicKey: string, treasuryId: string, allowanceYocto: string): Promise<unknown> {
  return account(k).addFunctionCallAccessKey({
    publicKey: agentPublicKey,
    contractId: treasuryId,
    methodNames: ["sign_eip3009"],
    allowance: BigInt(allowanceYocto),
  });
}

/** Creates the vault with the user's own daily limit (USDC atomic units). */
export async function createVault(k: StoredKey, treasuryId: string, dailyLimitAtomic: string): Promise<unknown> {
  return account(k).callFunction({
    contractId: treasuryId,
    methodName: "create_vault",
    args: { daily_limit: dailyLimitAtomic, allowed_to: [] },
    deposit: (2n * NEAR) / 100n,
    gas: 30n * TGAS,
  });
}

/** Changes the on-chain daily limit. Needs 1 yoctoNEAR, which only this full-access key can attach. */
export async function setDailyLimit(k: StoredKey, treasuryId: string, dailyLimitAtomic: string, allowedTo: string[]): Promise<unknown> {
  return account(k).callFunction({
    contractId: treasuryId,
    methodName: "set_limits",
    args: { daily_limit: dailyLimitAtomic, allowed_to: allowedTo },
    deposit: 1n,
    gas: 30n * TGAS,
  });
}

export async function pauseVault(k: StoredKey, treasuryId: string, paused: boolean): Promise<unknown> {
  return account(k).callFunction({ contractId: treasuryId, methodName: paused ? "pause" : "unpause", args: {}, deposit: 1n, gas: 30n * TGAS });
}

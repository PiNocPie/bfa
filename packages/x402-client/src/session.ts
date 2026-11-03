import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { localKeySigner, type BfaSigner } from "./signers.js";

/**
 * A session key signs per-call batch-settlement vouchers so the agent does not wait ~25s for NEAR MPC on every call.
 *
 * Why this is safe enough: the session key never holds funds. It can only authorize claims against a channel
 * whose deposit was signed by the agent's Chain Signatures key and capped by BFA (`maxDepositUsd`). If the
 * session key leaks, the worst case is the remaining balance of open channels, and unclaimed deposits are refundable.
 */
export interface SessionConfig {
  /** Signs vouchers. Create with `loadOrCreateSessionSigner`. */
  signer: BfaSigner;
  /** Where channel state is stored between calls (one JSON file per channel). */
  channelDir: string;
  /** Upper bound for any single channel deposit, in USD. Default "0.50". */
  maxDepositUsd?: string;
}

export async function loadOrCreateSessionSigner(file: string): Promise<BfaSigner> {
  let key: Hex;
  try {
    key = (await readFile(file, "utf8")).trim() as Hex;
    if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error(`session key file ${file} is malformed`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    key = generatePrivateKey();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, key + "\n", { mode: 0o600 });
  }
  await chmod(file, 0o600);
  return localKeySigner(key);
}

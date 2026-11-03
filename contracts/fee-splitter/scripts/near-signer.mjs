// A viem account whose key nobody holds: the address is derived from a NEAR account and every
// transaction is signed by NEAR Chain Signatures.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keccak256, serializeTransaction } from "viem";
import { toAccount } from "viem/accounts";

export async function nearDeployer(accountId, path) {
  const client = await import(new URL("../../../packages/x402-client/dist/index.js", import.meta.url));
  const privateKey =
    process.env.NEAR_PRIVATE_KEY ??
    JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${accountId}.json`), "utf8")).private_key;
  const mpc = client.nearMpc({ networkId: "testnet", caller: client.nearAccount({ accountId, privateKey, networkId: "testnet" }) });
  const address = await mpc.deriveEvmAddress(accountId, path);
  const signHash = async (hash) => {
    const rsv = await mpc.signHash(accountId, path, hash);
    return { r: `0x${rsv.r.padStart(64, "0")}`, s: `0x${rsv.s.padStart(64, "0")}`, yParity: rsv.v >= 27 ? rsv.v - 27 : rsv.v };
  };
  return toAccount({
    address,
    async signTransaction(tx, opts) {
      const serializer = opts?.serializer ?? serializeTransaction;
      return serializer(tx, await signHash(keccak256(serializer(tx))));
    },
    async signMessage() { throw new Error("not supported"); },
    async signTypedData() { throw new Error("not supported"); },
  });
}


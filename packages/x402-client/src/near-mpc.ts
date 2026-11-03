import { contracts, utils, type MPCSignature } from "chainsig.js";
import { publicKeyToAddress } from "viem/accounts";
import type { Hex } from "viem";
import type { MpcBackend, RsvSignature } from "./signers.js";

/** NEAR MPC signer contracts (Chain Signatures). */
export const MPC_CONTRACTS = { mainnet: "v1.signer", testnet: "v1.signer-prod.testnet" } as const;

/** 300 Tgas and 1 yoctoNEAR: what the MPC contract's `sign` method expects (same values chainsig.js sends). */
const SIGN_GAS = 300_000_000_000_000n;
const SIGN_DEPOSIT = 1n;

/**
 * The one NEAR capability Nen needs: call a contract method as `accountId`.
 * A near-api-js `Account` satisfies this directly.
 */
export interface NearCaller {
  readonly accountId: string;
  callFunction(args: {
    contractId: string;
    methodName: string;
    args: Record<string, unknown>;
    deposit: bigint;
    gas: bigint;
  }): Promise<unknown>;
}

export interface NearMpcOptions {
  networkId: "mainnet" | "testnet";
  /** Signs and sends the `sign` call. Its accountId is the predecessor the agent's EVM key is derived from. */
  caller: NearCaller;
  contractId?: string;
}

/** Production MPC backend: NEAR Chain Signatures. Address derivation is local math; signing is one NEAR transaction. */
export function nearMpc(opts: NearMpcOptions): MpcBackend {
  const contractId = opts.contractId ?? MPC_CONTRACTS[opts.networkId];
  const contract = new contracts.ChainSignatureContract({ networkId: opts.networkId, contractId });
  return {
    async deriveEvmAddress(predecessor, path) {
      const pub = (await contract.getDerivedPublicKey({ path, predecessor })) as string;
      return publicKeyToAddress(`0x${pub}` as Hex);
    },
    async signHash(predecessor, path, hash): Promise<RsvSignature> {
      if (predecessor !== opts.caller.accountId) {
        throw new Error(`predecessor ${predecessor} must be the calling account ${opts.caller.accountId}`);
      }
      const result = await opts.caller.callFunction({
        contractId,
        methodName: "sign",
        args: { request: { payload_v2: { Ecdsa: hash.slice(2) }, path, domain_id: 0 } },
        deposit: SIGN_DEPOSIT,
        gas: SIGN_GAS,
      });
      if (!result) throw new Error("MPC sign returned no result");
      return utils.cryptography.toRSV(result as MPCSignature);
    },
  };
}

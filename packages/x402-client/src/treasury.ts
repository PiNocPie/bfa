import type { Hex } from "viem";
import { MPC_CONTRACTS, nearMpc, type NearCaller } from "./near-mpc.js";
import { rsvToHex, type BfaSigner, type MpcBackend } from "./signers.js";
import { utils, type MPCSignature } from "chainsig.js";

const TGAS = 1_000_000_000_000n;
const EIP3009 = { TransferWithAuthorization: "transfer", ReceiveWithAuthorization: "receive" } as const;

/** Policy refusals the treasury contract can return. The agent should stop, not retry. */
export const TREASURY_REFUSALS = ["limit_reached", "recipient_not_allowed", "token_not_allowed", "vault_paused", "no_vault"] as const;
export type TreasuryRefusal = (typeof TREASURY_REFUSALS)[number];

export class TreasuryRefusedError extends Error {
  constructor(readonly reason: TreasuryRefusal, detail: string) {
    super(`treasury refused: ${reason} (${detail})`);
    this.name = "TreasuryRefusedError";
  }
}

export interface TreasurySignerOptions {
  /** The vault owner's NEAR account. A function-call key limited to `sign_eip3009` is enough. */
  caller: NearCaller;
  /** The BFA treasury contract, e.g. treasury.nen-testnet.testnet. */
  treasuryId: string;
  networkId: "mainnet" | "testnet";
  mpcContractId?: string;
  /** Address derivation backend; injected in tests. */
  mpc?: Pick<MpcBackend, "deriveEvmAddress">;
}

/** The Base address of `owner`'s vault: derived from the treasury account and path `vault/<owner>`. */
export function vaultPath(owner: string): string {
  return `vault/${owner}`;
}

/**
 * An x402 signer backed by the BFA treasury contract. The contract signs only USDC EIP-3009
 * authorizations, and only within the owner's on-chain policy (daily limit, allowed recipients,
 * allowed tokens, not paused). Nobody holds the vault's EVM key, and the agent cannot raise its limits.
 */
export async function treasurySigner(opts: TreasurySignerOptions): Promise<BfaSigner> {
  const mpc = opts.mpc ?? nearMpc({ networkId: opts.networkId, caller: opts.caller, ...(opts.mpcContractId && { contractId: opts.mpcContractId }) });
  const address = await mpc.deriveEvmAddress(opts.treasuryId, vaultPath(opts.caller.accountId));
  return {
    kind: "near-treasury",
    address,
    async signTypedData(td) {
      const kind = EIP3009[td.primaryType as keyof typeof EIP3009];
      if (!kind) throw new Error(`the BFA treasury signs only USDC EIP-3009 authorizations, not ${td.primaryType}`);
      const d = td.domain as { name?: string; version?: string; chainId?: number | bigint; verifyingContract?: string };
      const m = td.message as Record<string, unknown>;
      if (!d.name || !d.version || d.chainId === undefined || !d.verifyingContract) throw new Error("EIP-712 domain is incomplete");
      if (String(m.from).toLowerCase() !== address.toLowerCase()) throw new Error(`authorization is from ${String(m.from)}, not this vault ${address}`);
      const request = {
        kind,
        chain_id: Number(d.chainId),
        token: d.verifyingContract,
        domain_name: d.name,
        domain_version: d.version,
        from: String(m.from),
        to: String(m.to),
        value: String(m.value),
        valid_after: String(m.validAfter),
        valid_before: String(m.validBefore),
        nonce: String(m.nonce),
      };
      let result: unknown;
      try {
        result = await opts.caller.callFunction({
          contractId: opts.treasuryId,
          methodName: "sign_eip3009",
          args: { request },
          deposit: 0n,
          gas: 300n * TGAS,
        });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        const reason = TREASURY_REFUSALS.find((r) => msg.includes(r));
        if (reason) throw new TreasuryRefusedError(reason, msg.slice(0, 200));
        throw e;
      }
      if (!result) throw new Error("treasury returned no signature: the MPC sign failed and the amount was released");
      return rsvToHex(utils.cryptography.toRSV(result as MPCSignature)) as Hex;
    },
  };
}

export { MPC_CONTRACTS };

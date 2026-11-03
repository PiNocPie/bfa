import type { ClientEvmSigner } from "@x402/evm";
import { hashTypedData, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type NenSigner = ClientEvmSigner & {
  /** Human-readable description for receipts and logs, never a secret. */
  readonly kind: "local-key" | "near-chain-signatures";
};

/** Dev/test only: a plain EVM private key held by the process. Production agents should use Chain Signatures. */
export function localKeySigner(privateKey: Hex): NenSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    kind: "local-key",
    address: account.address,
    signTypedData: (td) => account.signTypedData(td as unknown as TypedDataDefinition),
  };
}

/** r/s/v as returned by NEAR's MPC signer (via chainsig.js toRSV). */
export interface RsvSignature {
  r: string;
  s: string;
  v: number;
}

/**
 * The two MPC operations Nen needs. Implemented with chainsig.js in `nearMpc()`; swappable in tests.
 * `predecessor` is the NEAR account that calls the MPC contract: today the agent's own account,
 * later the Nen treasury contract (so spend policy is enforced onchain before any signature exists).
 */
export interface MpcBackend {
  deriveEvmAddress(predecessor: string, path: string): Promise<Hex>;
  signHash(predecessor: string, path: string, hash: Hex): Promise<RsvSignature>;
}

function to32(hex: string): string {
  const h = hex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(h)) throw new Error(`invalid signature component "${hex}"`);
  return h.padStart(64, "0");
}

/** Assemble an Ethereum 65-byte signature (r || s || v) from MPC output. */
export function rsvToHex(sig: RsvSignature): Hex {
  const v = sig.v < 27 ? sig.v + 27 : sig.v;
  if (v !== 27 && v !== 28) throw new Error(`unexpected recovery value v=${sig.v}`);
  return `0x${to32(sig.r)}${to32(sig.s)}${v.toString(16)}`;
}

export interface ChainSignaturesSignerOptions {
  mpc: MpcBackend;
  /** NEAR account that requests signatures (agent account or Nen treasury contract). */
  predecessor: string;
  /** Derivation path; one path per agent wallet, e.g. "nen/agent-1". */
  path: string;
}

/**
 * An x402 signer whose EVM key is never held by anyone: the address is derived from a NEAR account
 * via Chain Signatures, and each EIP-3009 authorization is signed by NEAR's MPC network.
 */
export async function chainSignaturesSigner(opts: ChainSignaturesSignerOptions): Promise<NenSigner> {
  const address = await opts.mpc.deriveEvmAddress(opts.predecessor, opts.path);
  return {
    kind: "near-chain-signatures",
    address,
    async signTypedData(td) {
      const hash = hashTypedData(td as unknown as TypedDataDefinition);
      const rsv = await opts.mpc.signHash(opts.predecessor, opts.path, hash);
      return rsvToHex(rsv);
    },
  };
}

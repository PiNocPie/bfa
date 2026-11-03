import { chainAdapters, contracts } from "chainsig.js";
import { createPublicClient, http, type Hex } from "viem";
import { base } from "viem/chains";
import type { MpcBackend, RsvSignature } from "./signers.js";

type SignAndSend = Parameters<
  InstanceType<typeof contracts.ChainSignatureContract>["sign"]
>[0]["signerAccount"]["signAndSendTransactions"];

export interface NearMpcOptions {
  networkId: "mainnet" | "testnet";
  /** Sends the NEAR transaction that calls the MPC contract's `sign` method (e.g. from near-api-js Account). */
  signAndSendTransactions: SignAndSend;
  /** Defaults to chainsig.js's built-in address for the network (v1.signer on mainnet). */
  contractId?: string;
  /** Base RPC used only for address derivation helpers. */
  baseRpcUrl?: string;
}

/** Production MPC backend: NEAR Chain Signatures through chainsig.js. */
export function nearMpc(opts: NearMpcOptions): MpcBackend {
  const contract = new contracts.ChainSignatureContract({
    networkId: opts.networkId,
    ...(opts.contractId && { contractId: opts.contractId }),
  });
  const evm = new chainAdapters.evm.EVM({
    publicClient: createPublicClient({ chain: base, transport: http(opts.baseRpcUrl) }) as never,
    contract,
  });
  return {
    async deriveEvmAddress(predecessor, path) {
      const { address } = await evm.deriveAddressAndPublicKey(predecessor, path);
      return address as Hex;
    },
    async signHash(predecessor, path, hash): Promise<RsvSignature> {
      const bytes = Array.from(Buffer.from(hash.slice(2), "hex"));
      const [sig] = await contract.sign({
        payloads: [bytes],
        path,
        keyType: "Ecdsa",
        signerAccount: { accountId: predecessor, signAndSendTransactions: opts.signAndSendTransactions },
      });
      if (!sig) throw new Error("MPC returned no signature");
      return sig;
    },
  };
}

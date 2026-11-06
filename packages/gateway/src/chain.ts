import { Account, FailoverRpcProvider, JsonRpcProvider, PublicKey } from "near-api-js";
import { nearMpc, vaultPath, NEAR_RPC_DEFAULTS } from "@bfa/x402-client";
import { createPublicClient, erc20Abi, http, parseAbi, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

const USDC = {
  testnet: { chain: baseSepolia, address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex },
  mainnet: { chain: base, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex },
} as const;
const FACTORY_ABI = parseAbi(["function topUpAddressOf(address) view returns (address)"]);

/** JSON-RPC methods the browser may send through /api/near/rpc (reads, plus broadcasting its own signed transactions). */
export const NEAR_RPC_ALLOWED = new Set([
  "query", "block", "chunk", "status", "gas_price", "validators", "send_tx", "broadcast_tx_commit", "broadcast_tx_async", "tx",
  "EXPERIMENTAL_tx_status", "EXPERIMENTAL_protocol_config", "EXPERIMENTAL_receipt", "EXPERIMENTAL_changes", "EXPERIMENTAL_changes_in_block",
]);

export interface ChainOptions {
  network: "testnet" | "mainnet";
  rpcUrls?: readonly string[];
  /** NEAR account that pays to create users' accounts (testnet sponsor). */
  sponsorAccountId?: string;
  sponsorPrivateKey?: string;
  treasuryId: string;
  /** BfaTopUpFactory address on Base (Sepolia on testnet). */
  topUpFactory?: Hex;
}

export interface Vault {
  daily_limit: string;
  spent_today: string;
  day: number;
  allowed_to: string[];
  paused: boolean;
}

/** Implicit NEAR account id for an ed25519 public key: the key's 32 bytes in lowercase hex. */
export function implicitAccountId(publicKey: string): string {
  const pk = PublicKey.fromString(publicKey);
  if (pk.keyType !== 0) throw new Error("only ed25519 keys can own an implicit account");
  return Buffer.from(pk.data).toString("hex");
}

export function chain(o: ChainOptions) {
  const urls = o.rpcUrls?.length ? o.rpcUrls : NEAR_RPC_DEFAULTS[o.network];
  const provider = new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url }, { retries: 3, wait: 500, backoff: 1.5 })));
  const usdc = USDC[o.network];
  const evm = createPublicClient({ chain: usdc.chain, transport: http() });
  const mpc = nearMpc({ networkId: o.network, caller: { accountId: o.treasuryId, callFunction: async () => null } });

  async function view<T>(contract: string, method: string, args: object): Promise<T> {
    const r = (await provider.query({
      request_type: "call_function",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      finality: "optimistic",
    } as never)) as unknown as { result: number[] };
    return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
  }

  return {
    treasuryId: o.treasuryId,
    topUpFactory: o.topUpFactory,
    usdcAddress: usdc.address as Hex,

    async accountExists(id: string): Promise<boolean> {
      try {
        await provider.query({ request_type: "view_account", account_id: id, finality: "final" } as never);
        return true;
      } catch {
        return false;
      }
    },

    async hasAccessKey(id: string, publicKey: string): Promise<boolean> {
      try {
        await provider.query({ request_type: "view_access_key", account_id: id, public_key: publicKey, finality: "final" } as never);
        return true;
      } catch {
        return false;
      }
    },

    /** Sends `yocto` NEAR to a new implicit account so it exists and can pay for its setup transactions. */
    async sponsor(accountId: string, yocto: bigint): Promise<string> {
      if (!o.sponsorAccountId || !o.sponsorPrivateKey) throw new Error("no sponsor account configured (NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY)");
      const sponsor = new Account(o.sponsorAccountId, provider, o.sponsorPrivateKey as `ed25519:${string}`);
      const out = (await sponsor.transfer({ receiverId: accountId, amount: yocto })) as { transaction?: { hash?: string } };
      return out?.transaction?.hash ?? "";
    },

    async vault(accountId: string): Promise<Vault | null> {
      return view<Vault | null>(o.treasuryId, "get_vault", { account_id: accountId });
    },

    async vaultAddress(accountId: string): Promise<Hex> {
      return mpc.deriveEvmAddress(o.treasuryId, vaultPath(accountId));
    },

    async usdcBalance(address: Hex): Promise<bigint> {
      return evm.readContract({ address: usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    },

    async topUpAddress(wallet: Hex): Promise<Hex | null> {
      if (!o.topUpFactory) return null;
      return evm.readContract({ address: o.topUpFactory, abi: FACTORY_ABI, functionName: "topUpAddressOf", args: [wallet] });
    },

    /** Forwards one JSON-RPC request from the browser, for the allowed methods only. */
    async rpc(method: string, params: unknown, id: unknown = "bfa"): Promise<unknown> {
      if (!NEAR_RPC_ALLOWED.has(method)) throw new Error(`method ${method} is not allowed`);
      const res = await fetch(urls[0]!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      return res.json();
    },
  };
}

export type Chain = ReturnType<typeof chain>;

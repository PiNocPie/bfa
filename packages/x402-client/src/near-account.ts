import { Account, FailoverRpcProvider, JsonRpcProvider } from "near-api-js";

/**
 * Default NEAR RPC endpoints, fastest first. NEAR's own free RPC is slow (3–12s seen on testnet) and
 * rate-limited (returns HTML error pages under load), so it is only the last fallback.
 */
export const NEAR_RPC_DEFAULTS = {
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
} as const;

export interface NearAccountOptions {
  accountId: string;
  /** "ed25519:..." secret key. Read it from an environment variable; never hard-code or commit it. */
  privateKey: string;
  networkId: "mainnet" | "testnet";
  /** Overrides the defaults. Also read from NEAR_RPC_URLS (comma-separated) by the scripts. */
  rpcUrls?: readonly string[];
}

/** A near-api-js Account on a failover RPC provider with retries; satisfies `NearCaller`. */
export function nearAccount(opts: NearAccountOptions): Account {
  const urls = opts.rpcUrls?.length ? opts.rpcUrls : NEAR_RPC_DEFAULTS[opts.networkId];
  const provider = new FailoverRpcProvider(
    urls.map((url) => new JsonRpcProvider({ url }, { retries: 3, wait: 500, backoff: 1.5 })),
  );
  return new Account(opts.accountId, provider, opts.privateKey as `ed25519:${string}`);
}

import { nearAccount, nearMpc } from "@bfa/x402-client";
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, serializeTransaction, type Hex } from "viem";
import { toAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import type { Chain } from "./chain.js";
import type { UserStore } from "./users.js";

const FACTORY_ABI = parseAbi(["function sweep(address wallet)"]);

export interface SweeperOptions {
  network: "testnet" | "mainnet";
  chain: Chain;
  users: UserStore;
  /** NEAR account whose Chain Signatures address pays the sweep gas (no EVM key anywhere). */
  nearAccountId: string;
  nearPrivateKey: string;
  rpcUrls?: readonly string[];
  /** Derivation path of the gas-paying address. Default bfa/deployer. */
  path?: string;
  intervalMs?: number;
  log?: (msg: string) => void;
}

/**
 * Moves USDC that arrived at users' top-up addresses into their vaults (minus BFA's 1.5% on-top fee) by calling the
 * public BfaTopUpFactory.sweep. Anyone may call sweep; this just does it promptly so users don't have to.
 */
export function sweeper(o: SweeperOptions) {
  const evmChain = o.network === "mainnet" ? base : baseSepolia;
  const path = o.path ?? "bfa/deployer";
  const log = o.log ?? ((m: string) => console.error(m));
  const mpc = nearMpc({
    networkId: o.network,
    caller: nearAccount({ accountId: o.nearAccountId, privateKey: o.nearPrivateKey, networkId: o.network, ...(o.rpcUrls && { rpcUrls: o.rpcUrls }) }),
  });
  const pub = createPublicClient({ chain: evmChain, transport: http() });
  let wallet: ReturnType<typeof createWalletClient> | undefined;
  let busy = false;

  async function walletClient() {
    if (wallet) return wallet;
    const address = await mpc.deriveEvmAddress(o.nearAccountId, path);
    const account = toAccount({
      address,
      async signTransaction(tx, opts) {
        const serializer = (opts?.serializer ?? serializeTransaction) as typeof serializeTransaction;
        const rsv = await mpc.signHash(o.nearAccountId, path, keccak256(serializer(tx as never)));
        return serializer(tx as never, {
          r: `0x${rsv.r.padStart(64, "0")}` as Hex,
          s: `0x${rsv.s.padStart(64, "0")}` as Hex,
          yParity: rsv.v >= 27 ? rsv.v - 27 : rsv.v,
        });
      },
      async signMessage() {
        throw new Error("not supported");
      },
      async signTypedData() {
        throw new Error("not supported");
      },
    });
    wallet = createWalletClient({ account, chain: evmChain, transport: http() });
    return wallet;
  }

  /** Sweeps one vault's top-up address if it holds USDC. Returns the sweep tx, or null if there was nothing to move. */
  async function sweepFor(vault: Hex): Promise<{ tx: Hex; received_atomic: string } | null> {
    if (!o.chain.topUpFactory) throw new Error("no top-up factory configured");
    const topUp = await o.chain.topUpAddress(vault);
    if (!topUp) return null;
    const held = await o.chain.usdcBalance(topUp);
    if (held === 0n) return null;
    const w = await walletClient();
    const tx = await w.writeContract({ address: o.chain.topUpFactory, abi: FACTORY_ABI, functionName: "sweep", args: [vault], chain: evmChain, account: w.account! });
    await pub.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
    return { tx, received_atomic: held.toString() };
  }

  async function sweepAll(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      for (const u of await o.users.list()) {
        if (u.wallet_status !== "ready" || !u.near_account_id) continue;
        try {
          const vault = await o.chain.vaultAddress(u.near_account_id);
          const r = await sweepFor(vault);
          if (r) log(`swept ${r.received_atomic} atomic USDC into vault ${vault}: ${r.tx}`);
        } catch (e) {
          log(`sweep for one user failed: ${(e as Error).message.slice(0, 200)}`);
        }
      }
    } finally {
      busy = false;
    }
  }

  let timer: NodeJS.Timeout | undefined;
  return {
    sweepFor,
    sweepAll,
    start() {
      timer ??= setInterval(() => void sweepAll(), o.intervalMs ?? 60_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type Sweeper = ReturnType<typeof sweeper>;

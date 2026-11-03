import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BfaConfig } from "./tools.js";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The server's configuration from its environment (NEAR_*, BFA_*). Shared by the stdio server and the gateway. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BfaConfig {
  return {
    registryDir: resolve(env.BFA_REGISTRY_DIR ?? join(here, "../../../registry")),
    ...(env.BFA_DEV_REGISTRY_DIR && { devRegistryDir: resolve(env.BFA_DEV_REGISTRY_DIR) }),
    stateDir: resolve(env.BFA_STATE_DIR ?? join(homedir(), ".bfa")),
    network: env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet",
    ...(env.NEAR_ACCOUNT_ID && { nearAccountId: env.NEAR_ACCOUNT_ID }),
    ...(env.NEAR_PRIVATE_KEY && { nearPrivateKey: env.NEAR_PRIVATE_KEY }),
    ...(env.NEAR_RPC_URLS && { nearRpcUrls: env.NEAR_RPC_URLS.split(",").map((u) => u.trim()).filter(Boolean) }),
    agentPath: env.BFA_AGENT_PATH ?? "nen/agent-1",
    ...(env.BFA_TREASURY_ID && { treasuryId: env.BFA_TREASURY_ID }),
    dailyCapUsd: env.BFA_DAILY_CAP_USD ?? "1",
    maxDepositUsd: env.BFA_MAX_DEPOSIT_USD ?? "0.50",
  };
}

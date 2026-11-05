#!/usr/bin/env node
// BFA hosted MCP gateway. Agents connect to http://<host>:<port>/v1 with `Authorization: Bearer bfa_sk_...`.
// Payment config mirrors the stdio server (NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY, NEAR_NETWORK, BFA_*), so every key
// spends from the operator's NEAR-controlled wallet in this version.
import { resolve } from "node:path";
import { configFromEnv } from "@bfa/mcp/lib";
import { chain } from "./chain.js";
import { consoleApi } from "./console.js";
import { sweeper as makeSweeper } from "./sweeper.js";
import { createGateway, listen } from "./server.js";
import { storesFromEnv } from "./stores.js";
import { secretKeyFromEnv } from "./users.js";

const env = process.env;
const stateDir = resolve(env.BFA_GATEWAY_STATE_DIR ?? ".bfa-gateway");
const config = { ...configFromEnv(env), stateDir };
const stores = storesFromEnv(env, stateDir);
const secret = secretKeyFromEnv(env.BFA_SECRET_KEY);
const ch = config.treasuryId
  ? chain({
      network: config.network,
      ...(config.nearRpcUrls && { rpcUrls: config.nearRpcUrls }),
      ...(config.nearAccountId && { sponsorAccountId: config.nearAccountId }),
      ...(config.nearPrivateKey && { sponsorPrivateKey: config.nearPrivateKey }),
      treasuryId: config.treasuryId,
      ...(env.BFA_TOPUP_FACTORY && { topUpFactory: env.BFA_TOPUP_FACTORY as `0x${string}` }),
    })
  : undefined;
const sw =
  ch && ch.topUpFactory && config.nearAccountId && config.nearPrivateKey && env.BFA_SWEEPER !== "0"
    ? makeSweeper({
        network: config.network,
        chain: ch,
        users: stores.users,
        nearAccountId: config.nearAccountId,
        nearPrivateKey: config.nearPrivateKey,
        ...(config.nearRpcUrls && { rpcUrls: config.nearRpcUrls }),
      })
    : undefined;
sw?.start();
const api = consoleApi({
  network: config.network,
  keys: stores.keys,
  receipts: stores.receipts,
  users: stores.users,
  ...(ch && { chain: ch }),
  secret,
  ...(env.BFA_GOOGLE_CLIENT_ID && { googleClientId: env.BFA_GOOGLE_CLIENT_ID }),
  devLogin: env.BFA_DEV_LOGIN === "1",
  secureCookies: env.BFA_SECURE_COOKIES === "1",
  registryDir: config.registryDir,
  ...(config.devRegistryDir && { devRegistryDir: config.devRegistryDir }),
  ...(sw && { sweeper: sw }),
});
const gw = createGateway({
  config,
  keys: stores.keys,
  receipts: stores.receipts,
  users: stores.users,
  secret,
  consoleApi: api,
  ...(env.BFA_WEB_DIR && { webDir: resolve(env.BFA_WEB_DIR) }),
});

const port = Number(env.PORT ?? env.BFA_GATEWAY_PORT ?? 8787);
const host = env.BFA_GATEWAY_HOST ?? "127.0.0.1";
const { server, url } = await listen(gw, port, host);
console.error(`BFA gateway: ${url} (network ${config.network}, ${stores.kind} store, state ${stateDir})`);

const stop = async () => {
  await gw.close();
  server.close(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

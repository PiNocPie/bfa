#!/usr/bin/env node
// BFA hosted MCP gateway. Agents connect to http://<host>:<port>/v1 with `Authorization: Bearer bfa_sk_...`.
// Payment config mirrors the stdio server (NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY, NEAR_NETWORK, BFA_*), so every key
// spends from the operator's NEAR-controlled wallet in this version.
import { resolve } from "node:path";
import { configFromEnv } from "@bfa/mcp/lib";
import { createGateway, listen } from "./server.js";
import { storesFromEnv } from "./stores.js";

const env = process.env;
const stateDir = resolve(env.BFA_GATEWAY_STATE_DIR ?? ".bfa-gateway");
const config = { ...configFromEnv(env), stateDir };
const stores = storesFromEnv(env, stateDir);
const gw = createGateway({ config, keys: stores.keys, receipts: stores.receipts });

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

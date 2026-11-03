#!/usr/bin/env node
// Manage BFA gateway API keys. Uses the same store as the gateway: Supabase when SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are set, otherwise $BFA_GATEWAY_STATE_DIR/keys.json (default ./.bfa-gateway).
//
//   node scripts/keys.mjs create --name my-agent --expires-days 30 --daily-usd 1 \
//     [--limit bfa/near-account:usd:0.50] [--limit bfa/near-account:calls:200] \
//     [--scope run --scope receipts] [--allow <listing_id> ... | --block <listing_id> ...] [--network testnet|mainnet]
//   node scripts/keys.mjs list
//   node scripts/keys.mjs revoke <key_id>
//
// Build first (pnpm build). `create` prints the secret once; only its sha256 is stored.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createKey, parseLimit, storesFromEnv } from "../dist/index.js";

const env = process.env;
const stateDir = resolve(env.BFA_GATEWAY_STATE_DIR ?? ".bfa-gateway");

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      "usage:",
      "  keys.mjs create --name <name> --expires-days <n> --daily-usd <amount>",
      "                  [--limit <listing_id>:usd:<amount>]... [--limit <listing_id>:calls:<n>]...",
      "                  [--scope run|receipts|topups]... [--allow <listing_id>]... | [--block <listing_id>]...",
      "                  [--network testnet|mainnet]   (default: $NEAR_NETWORK or testnet)",
      "  keys.mjs list",
      "  keys.mjs revoke <key_id>",
    ].join("\n"),
  );
  process.exit(msg ? 2 : 0);
}

function status(k, now = Date.now()) {
  if (k.revoked_at) return "revoked";
  if (Date.parse(k.expires_at) <= now) return "expired";
  return "active";
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help") usage();

let stores;
try {
  stores = storesFromEnv(env, stateDir);
} catch (e) {
  usage(e.message);
}

if (cmd === "create") {
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        "expires-days": { type: "string" },
        "daily-usd": { type: "string" },
        limit: { type: "string", multiple: true },
        scope: { type: "string", multiple: true },
        allow: { type: "string", multiple: true },
        block: { type: "string", multiple: true },
        network: { type: "string" },
      },
      strict: true,
    }));
  } catch (e) {
    usage(e.message);
  }
  if (!values.name) usage("--name is required");
  if (!values["expires-days"]) usage("--expires-days is required");
  if (!values["daily-usd"]) usage("--daily-usd is required");
  const days = Number(values["expires-days"]);
  if (!(days > 0)) usage("--expires-days must be a positive number");
  if (values.allow?.length && values.block?.length) usage("--allow and --block are mutually exclusive");
  const network = values.network ?? (env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet");
  if (network !== "testnet" && network !== "mainnet") usage("--network must be testnet or mainnet");

  try {
    const { secret, record } = await createKey(stores.keys, {
      name: values.name,
      expiresAt: new Date(Date.now() + days * 86_400_000),
      dailyLimitUsd: values["daily-usd"],
      perApiLimits: (values.limit ?? []).map(parseLimit),
      ...(values.scope?.length && { scopes: values.scope }),
      ...(values.allow?.length && { listingAccess: { mode: "allow", listing_ids: values.allow } }),
      ...(values.block?.length && { listingAccess: { mode: "block", listing_ids: values.block } }),
      network,
    });
    const { sha256: _hash, ...shown } = record;
    console.log(JSON.stringify(shown, null, 2));
    console.log(`\nSecret (shown once, store it now; only its sha256 is kept, in the ${stores.kind} store):\n${secret}`);
  } catch (e) {
    usage(e.message);
  }
} else if (cmd === "list") {
  const keys = await stores.keys.list();
  if (!keys.length) console.log("no keys");
  for (const k of keys) {
    const { sha256: _hash, ...shown } = k;
    console.log(JSON.stringify({ status: status(k), ...shown }));
  }
} else if (cmd === "revoke") {
  const id = rest[0];
  if (!id) usage("revoke needs a key id (see `list`)");
  const k = await stores.keys.revoke(id, new Date());
  if (!k) usage(`no key ${id}`);
  console.log(`revoked ${k.id} (${k.prefix}…) at ${k.revoked_at}`);
} else {
  usage(`unknown command ${cmd}`);
}

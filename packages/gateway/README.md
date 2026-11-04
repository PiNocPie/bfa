# @bfa/gateway

Hosted BFA MCP gateway. Agents connect over HTTP with a BFA API key instead of running the stdio server on their own machine. The gateway serves the same 7 tools as `packages/mcp-server` (it reuses that package's tool code) and enforces each key's limits **before any payment is signed**.

> **Whose money is spent: in this version, every API key spends from the gateway operator's wallet.** The gateway pays with the operator's NEAR account through Chain Signatures, using the same signer, session key and channel settings as the stdio server. Key limits cap how much of the operator's money each key can spend. They do not give a user a wallet of their own. Per-user wallets come with the treasury contract, which is being built separately.

## Run it

```bash
pnpm install && pnpm build

# 1. Create a key. The secret is printed once; only its sha256 is stored.
node packages/gateway/scripts/keys.mjs create --name my-agent --expires-days 30 --daily-usd 1 \
  --limit bfa/near-account:usd:0.50 --limit bfa/near-account:calls:200

# 2. Start the gateway (same NEAR/BFA env as the stdio server).
NEAR_NETWORK=testnet NEAR_ACCOUNT_ID=<operator>.testnet NEAR_PRIVATE_KEY=ed25519:... \
BFA_DEV_REGISTRY_DIR=$PWD/examples/dev-registry \
node packages/gateway/dist/main.js
# BFA gateway: http://127.0.0.1:8787/v1 (network testnet, file store, state ./.bfa-gateway)
```

Connect an MCP client that supports Streamable HTTP, for example in `.mcp.json`:

```json
{
  "mcpServers": {
    "bfa": {
      "type": "http",
      "url": "https://gateway.example.com/v1",
      "headers": { "Authorization": "Bearer ${BFA_API_KEY}" }
    }
  }
}
```

The endpoint is `POST`/`GET`/`DELETE /v1` (MCP Streamable HTTP, one session per client). A request without a key, or with a malformed or unknown key, gets `401` with a JSON body `{"error":{"code":"unauthorized",...}}`. A session can only be used with the key that opened it. `GET /healthz` returns `{"ok":true}`. The gateway speaks plain HTTP; put TLS in front of it (a reverse proxy or your platform's load balancer).

### Environment

| Variable | Default | What |
|---|---|---|
| `BFA_GATEWAY_STATE_DIR` | `./.bfa-gateway` | Local state: `keys.json` and `receipts.jsonl` (file store), plus `session.key` and `channels/` (always local). |
| `BFA_GATEWAY_PORT` / `PORT` | `8787` | Listen port. |
| `BFA_GATEWAY_HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` behind a proxy. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | unset | Set both to store keys and receipts in Supabase. Setting only one is an error. |
| `NEAR_NETWORK`, `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY`, `NEAR_RPC_URLS` | | The operator's payer, same as the stdio server. `NEAR_NETWORK=mainnet` makes the gateway accept only `bfa_sk_live_` keys. |
| `BFA_REGISTRY_DIR`, `BFA_DEV_REGISTRY_DIR`, `BFA_AGENT_PATH`, `BFA_MAX_DEPOSIT_USD` | | Same as the stdio server. |
| `BFA_DAILY_CAP_USD` | `1` | Gateway-wide daily cap across **all** keys (`over_daily_budget`). It protects the operator's wallet on top of the per-key limits. |

## API keys

```bash
node scripts/keys.mjs create --name <name> --expires-days <n> --daily-usd <amount> \
  [--limit <listing_id>:usd:<amount>]... [--limit <listing_id>:calls:<n>]... \
  [--scope run|receipts|topups]... [--allow <listing_id>]... | [--block <listing_id>]...
node scripts/keys.mjs list
node scripts/keys.mjs revoke <key_id>
```

The CLI uses the same store as the gateway (Supabase if both Supabase variables are set, otherwise `$BFA_GATEWAY_STATE_DIR/keys.json`). Revocations and edits apply on the next tool call; the gateway re-reads the key on every call.

| Field | Meaning |
|---|---|
| secret | `bfa_sk_test_<32 base62>` on testnet, `bfa_sk_live_<32 base62>` on mainnet. Shown once at creation. |
| `prefix` | First 16 characters of the secret, for display. `sha256` of the secret is the only other trace of it. |
| `expires_at` | Required. |
| `revoked_at` | Set by `revoke`. A second revoke keeps the first time. |
| `daily_limit_usd` | Required. All APIs combined, per UTC day. |
| `per_api_limits` | `[{ listing_id, kind: "usd", value: "0.50" }, { listing_id, kind: "calls", value: 200 }]`, per UTC day. |
| `scopes` | Subset of `run`, `receipts`, `topups`. Default `["run","receipts"]`. `run` is needed for `run`; `receipts` for `receipts` and `wallet`. `topups` is reserved for the top-up flow. |
| `listing_access` | `{ mode: "all" \| "allow" \| "block", listing_ids }`. Default `all`. `--allow` and `--block` cannot be combined. |

### What `run` checks, in order, before paying

1. Unknown or malformed key → HTTP 401.
2. Revoked → `key_revoked`.
3. Expired → `key_expired`.
4. No `run` scope → `scope_missing`.
5. Listing not allowed for the key → `listing_not_allowed`. With a `query`, the candidates are filtered by the key's access **before** the best listing and fallbacks are picked, so a blocked listing is never tried.
6. This key's charged spend today + the listing price > `daily_limit_usd` → `limit_reached`.
7. A per-API `usd` or `calls` limit for that listing would be exceeded → `limit_reached`.

`limit_reached` carries `resets_at` (the next 00:00 UTC) and `next_action: "stop"`. A refused call sends no request to the seller, signs nothing and writes no receipt. Limits count only charged receipts (`paid_ok`, `paid_empty`, `paid_error`) of that key since 00:00 UTC. Idempotency keys are per API key. Revoked and expired keys are refused on every tool, not only `run`.

The free tools tell an agent what its key may call: `discover` hits and `inspect` carry `allowed_for_this_key`, and `quote` adds `allowed_for_this_key` and `fallbacks_allowed_for_this_key`. `receipts` and `wallet` show only this key's receipts and spend, plus a `key` object with its limits, usage per listing today, expiry and `resets_at`.

## Storage

Keys and receipts sit behind two interfaces, `KeyStore` (`src/keys.ts`) and `ReceiptStore` (`@bfa/core`):

- **File store** (default; tests and local development): `keys.json` (written to a temp file and renamed, mode 0600) and the usual `receipts.jsonl`, both in `BFA_GATEWAY_STATE_DIR`.
- **Supabase** (Postgres): selected when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are both set. The service role key is server-side only: never ship it to a browser or an agent, and never log it. The gateway does not print it.

Apply the migration once per project, with the Supabase CLI:

```bash
cd packages/gateway
supabase link --project-ref <ref>
supabase db push            # applies supabase/migrations/0001_init.sql
```

Or paste `supabase/migrations/0001_init.sql` into the SQL editor, or run `psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql`. It creates `api_keys` and `receipts` (full receipt in `payload`, with `key_id`, `listing_id`, `status`, `price_usd`, `started_at` and `idempotency_key` as columns), an index on `(key_id, started_at)` for "spend today by key", and enables RLS with no policies, so only the service role can read or write.

The Supabase store has only been tested against an in-memory mock of the client (`src/testing/fake-supabase.ts`), because this sandbox cannot reach Supabase hosts. Run it against a real project before relying on it.

## Limits of this version

- All keys spend from the operator's wallet (see the top of this file).
- One gateway process. MCP sessions are held in memory, and the session key and payment-channel state are on local disk even with Supabase, so do not run several instances against one wallet yet.
- Paid calls are serialized across all keys: they share one payer and one payment channel, and serializing them also makes the limit check and the receipt write atomic.
- No rate limiting on failed authentication; put it in the reverse proxy.

## Tests

`pnpm --filter @bfa/gateway test` runs offline. A fake x402 V2 seller (the pattern from `packages/x402-client/src/pay.test.ts`) verifies real EIP-3009 signatures from a local test key, and the official MCP client calls the gateway over Streamable HTTP. The tests cover 401s, a paid call, expired, revoked and scope-less keys, the daily limit at its exact boundary, per-API calls and USD limits, allow and block lists (including query fallback), per-key receipts and idempotency, UTC-day accounting, and the Supabase stores against the mock.

## Console, Google sign-in and per-user wallets

The gateway also serves the website and its JSON API (`/api/*`), so one service runs everything.

- **Sign-in:** Google Sign-In only. The browser gets an ID token from Google; `POST /api/auth/google` verifies its signature against Google's published keys, the issuer, the audience (`BFA_GOOGLE_CLIENT_ID`), expiry and a verified email, then sets an HttpOnly session cookie signed with `BFA_SECRET_KEY`. `BFA_DEV_LOGIN=1` adds an email-only sign-in for local testing; never set it in production.
- **Wallets stay with the user.** On first setup the browser generates an ed25519 key that never leaves it, and downloads a recovery file. That key owns an implicit NEAR account. The gateway funds the account on testnet (1.5 NEAR), then the browser signs two transactions itself: `create_vault` on the treasury with the user's daily limit, and an access key for the gateway that may call only `sign_eip3009` (1 NEAR gas allowance). The gateway stores that function-call key encrypted (AES-256-GCM, `BFA_SECRET_KEY`). It can pay within the vault's on-chain limit and cannot change the limit, pause state or recipients.
- **Keys made in the console** carry the owner's `user_id`, so their payments come from that user's vault. CLI keys (no user) still pay from the operator's wallet.
- **Browser NEAR calls** go through `POST /api/near/rpc`, which forwards only read methods and the broadcasting of transactions the browser signed.

| Variable | Purpose |
|---|---|
| `BFA_SECRET_KEY` | 32 bytes hex (`openssl rand -hex 32`). Signs sessions and encrypts agent keys. Required. Keep it stable: changing it makes stored agent keys unreadable. |
| `BFA_GOOGLE_CLIENT_ID` | OAuth client id (Web) from Google Cloud Console. Add your site's origin to its authorized JavaScript origins. |
| `BFA_TREASURY_ID` | Treasury contract, e.g. `treasury.nen-testnet.testnet`. |
| `BFA_TOPUP_FACTORY` | `BfaTopUpFactory` address, shown as each user's top-up address. |
| `BFA_WEB_DIR` | Built website (`packages/web/dist`). |
| `BFA_SECURE_COOKIES=1` | Set behind https. |
| `NEAR_ACCOUNT_ID` / `NEAR_PRIVATE_KEY` | Operator account: sponsors new users' accounts on testnet and pays for CLI keys. |

Verified on testnet (2026-11-04): a new user signed in, set up a wallet in the browser, topped up 1.015 USDC through the fee splitter (1.000 to their vault `0xEE8B…131B`), created a key with a $0.003 daily limit in the console, and an agent made three paid calls from that vault (channel deposit [`0xd1d0a1b8…3ee6`](https://sepolia.basescan.org/tx/0xd1d0a1b8b62b5f6afd38940bc8ef3cff97e3e1e235be71bb052cec05db923ee6)) before the fourth was refused with `limit_reached`.

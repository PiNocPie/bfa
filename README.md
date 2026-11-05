# BFA (Built For Agents)

BFA is an open, pay-per-call API market for AI agents. An agent finds an API, checks the price, pays for one call over [x402](https://x402.org) and gets a JSON receipt. It does this through an MCP server, so it needs no per-provider account, subscription or provider API key.

People sign in with Google, keep their money in their own NEAR-controlled vault, and give each agent a BFA key with an expiry date and daily limits.

The agent pays from a Base address that its **NEAR account controls through [Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures)**. No private EVM key appears in any config file. Anyone can list an API by opening a PR. A listing starts routing only after the BFA team reviews it, and it stops routing if its manifest changes after review.

Status: working on testnets (NEAR testnet + Base Sepolia). Not on mainnet yet. The [what is real](#what-is-real-and-what-is-not) section lists what works and what doesn't.

## Try the live demo (testnet)

**https://bfagateway-production.up.railway.app**

1. Open the site → **Sign in** → Continue with Google. → You land in the console.
2. **Wallet → Create my wallet.** → Your browser makes a NEAR key (a recovery file downloads), BFA funds a new NEAR testnet account, and you sign two transactions: `create_vault` with your daily limit, and a gateway key limited to `sign_eip3009`. → The wallet page shows your vault's Base Sepolia address and your personal top-up address.
3. **Top up:** get test USDC at [faucet.circle.com](https://faucet.circle.com) (Base Sepolia) and send it to your top-up address. → Within minutes a sweep splits it: e.g. send 1.015, see 1.000 in your vault.
4. **API keys → Create API key** with a daily limit. → The secret is shown once, with a ready `claude mcp add` command.
5. Run that command in Claude Code and ask: *"Use BFA to check the NEAR testnet account nen-testnet.testnet. Inspect the price first."* → The agent calls `discover`, `inspect`, `run`, pays $0.001 and returns the data; the console's **Usage** page shows the receipt.
6. Keep asking until the key's daily limit is used. → The next call returns `limit_reached` and nothing is paid.

MCP endpoint for any client: `https://bfagateway-production.up.railway.app/v1` with `Authorization: Bearer <your BFA key>`.

## Try it in 2 minutes (offline, no accounts)

Requires Node ≥ 22 and pnpm 10.

```bash
pnpm install && pnpm build
```

```bash
pnpm test
```

You should see `Tests 8 passed` (core) and `Tests 7 passed` (x402-client). The x402-client tests start a fake x402 V2 seller that checks EIP-3009 signatures for real. Together the tests show that:

- the client pays the listed price and refuses to sign when the seller asks for more;
- the client refuses before sending any request when the agent's `max_price_usd` is below the listing's price;
- a paid call that returns nothing is recorded as `paid_empty`;
- reusing an idempotency key never pays twice;
- a listing routes only if it was reviewed and its manifest hash still matches;
- a pricing model other than per-call is rejected;
- the daily cap counts only today's charged calls.

```bash
pnpm registry:check
```

You should see `nansen/smart-money-holdings ... not routable (pending review by the BFA team)` and `bfa/near-account ... routable`. Each line shows whether a listing is routable and why.

## Live testnet run (needs a NEAR testnet account)

This is the path we ran on 2026-11-03. Every number below comes from that run.

1. **Create a NEAR testnet account.** Any wallet works, or near-cli-rs: `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`.
2. **Derive the agent's Base address from the NEAR account:**

   ```bash
   NEAR_ACCOUNT_ID=<name>.testnet pnpm --filter @bfa/x402-client chainsig:testnet
   ```

   This sends one `sign` request to the MPC contract `v1.signer-prod.testnet`, then checks the signature locally. It prints the derived address for path `nen/agent-1`.
3. **Fund that address** with test USDC on Base Sepolia from https://faucet.circle.com. You don't need ETH for gas, because the facilitator pays it.
4. **Start the demo seller.** It sells `POST /near/account` for $0.001 per call and accepts `batch-settlement` and `exact`:

   ```bash
   SELLER_PAY_TO=<any 0x address you control> pnpm --filter @bfa/demo-seller start
   ```

5. **Pay from a script:**

   ```bash
   NEAR_ACCOUNT_ID=<name>.testnet pnpm --filter @bfa/x402-client e2e:testnet
   ```

   Call 1 opens a payment channel. Chain Signatures signs the deposit once. Calls 2 onward are vouchers signed by a local session key.
6. **Or pay from an agent over MCP.** This is the same flow Claude Code would use:

   ```bash
   NEAR_ACCOUNT_ID=<name>.testnet node packages/mcp-server/scripts/smoke.mjs
   ```

### Results from our run

| Step | Result |
|---|---|
| Agent NEAR account | [`nen-testnet.testnet`](https://testnet.nearblocks.io/address/nen-testnet.testnet) |
| Derived Base Sepolia payer (path `nen/agent-1`) | [`0xcB9fFe1087b5442ceEf609361CE633B1795C21cA`](https://sepolia.basescan.org/address/0xcB9fFe1087b5442ceEf609361CE633B1795C21cA) |
| Channel deposit signed by NEAR Chain Signatures | [`0x6b5d2f2f…e103`](https://sepolia.basescan.org/tx/0x6b5d2f2f5ad0ec5da3e28ee9992dd62f314841ad518d797c6c961471e867e103), [`0x5b82eb43…d659`](https://sepolia.basescan.org/tx/0x5b82eb434285b8077f76c4e0d1103fbf09d3281d2e909a3a7bd3cb901d5ad659) |
| MPC signature for the deposit (once per channel) | ~7 s with FastNEAR RPC, ~25 s with `rpc.testnet.near.org` |
| Each later paid call | 200–310 ms end to end; voucher signing 2–13 ms |
| Price per call | $0.001 (1000 atomic USDC). The client never pays more than the listing says. |
| Failed calls | $0. Receipt status `unpaid_error` with a `next_action` |

Why channels: a Chain Signatures `sign` is a NEAR transaction plus an MPC round trip, which takes seconds. Paying every call that way would be too slow for agents. With x402 `batch-settlement`, NEAR signs one capped deposit (default max $0.50). Each call after that is a voucher against the deposit, and any unused deposit can be refunded.

## Use it from Claude Code

After `pnpm build`, add this to your MCP config (for example `.mcp.json`):

```json
{
  "mcpServers": {
    "bfa": {
      "command": "node",
      "args": ["/absolute/path/to/bfa/packages/mcp-server/dist/index.js"],
      "env": {
        "NEAR_NETWORK": "testnet",
        "NEAR_ACCOUNT_ID": "<name>.testnet",
        "NEAR_PRIVATE_KEY": "${NEAR_PRIVATE_KEY}",
        "BFA_DEV_REGISTRY_DIR": "/absolute/path/to/bfa/examples/dev-registry",
        "BFA_DAILY_CAP_USD": "1"
      }
    }
  }
}
```

Keep `NEAR_PRIVATE_KEY` in your environment or a secret store, not in the file. This key is the NEAR access key that signs `sign` requests. It is not an EVM key. `BFA_DEV_REGISTRY_DIR` adds the localhost demo seller listing. Leave it out to use only the public registry.

### Tools

| Tool | Paid? | What it returns |
|---|---|---|
| `discover` | free | Reviewed listings that match a query, with price and networks. Pass `include_not_routable: true` to also see pending ones. |
| `inspect` | free | Input and output schema, example input, a price line such as `$0.001 / call · empty result: free · error: free`, review status, approved and current manifest sha256, and observed health. |
| `quote` | free | The best listing plus ordered fallbacks, ranked 45% success rate, 25% price, 20% latency, 10% billing honesty. |
| `run` | **pays** | Data plus a receipt. Checks input against the schema before paying. Pays at most the listed price and at most `max_price_usd`. Respects the daily cap. Reusing `idempotency_key` replays the receipt. |
| `receipts` | free | Recent receipts and today's spend against the cap. |
| `wallet` | free | NEAR account, derived payer address, session key, USDC balance and limits. |
| `submit_listing` | free | Dry run for sellers: schema check plus an unpaid probe of the endpoint's 402. It never pays and never publishes. |

Errors are JSON with a `code` and a `next_action` (`retry`, `retry_after`, `use_fallback`, `raise_max_price`, `top_up`, `fix_input`, `stop`), so an agent can decide what to do next without reading prose.

## List an API

1. Serve your endpoint behind x402 V2. Any `@x402/*` server middleware works. See `packages/demo-seller` for a ~130-line Hono example.
2. Write a manifest that follows [`registry/schema/listing.schema.json`](registry/schema/listing.schema.json) and save it at `registry/listings/<provider>/<slug>.json`.
3. Run `submit_listing` with the manifest, or open a PR directly. The bot checks:
   - the endpoint is reachable and returns 402 to unpaid requests;
   - the 402 uses x402 V2;
   - its networks and schemes match the manifest;
   - its price equals `pricing.amount_usd`;
   - the URL is public https.
4. A BFA reviewer adds `registry/reviews/<provider>/<slug>.json` with the manifest's sha256. Only then does the listing route. Editing the manifest afterwards stops routing until someone reviews it again.

Listing is free and BFA takes no cut of call payments: agents pay your `payTo` directly. (BFA's only fee is 1.5% on user top-ups, planned and not built yet.)

## Repo map

| Path | What |
|---|---|
| `packages/core` | Registry loader and validation, router (discover/quote), receipts log, health scoring |
| `packages/x402-client` | Paying client, signers (local key for tests, NEAR Chain Signatures), batch-settlement session, listing bot |
| `packages/mcp-server` | The 7 MCP tools above |
| `packages/demo-seller` | x402 seller selling a NEAR-native endpoint (`/near/account`) on Base Sepolia |
| `packages/gateway` | Hosted MCP endpoint (`/v1`, Streamable HTTP) with BFA API keys: expiry, daily and per-API limits, allow/block lists, scopes; file or Supabase storage |
| `contracts/treasury` | NEAR contract: per-user vaults with an on-chain daily limit, signing through Chain Signatures |
| `contracts/fee-splitter` | Base contracts: per-user top-up addresses that split the 1.5% fee without custody |
| `packages/web` | The live website and console (Google sign-in, browser-held wallet, keys, receipts), served by the gateway |
| `site/` | Static website preview and the BB mascot (`mascot.svg`) |
| `Dockerfile`, `railway.json`, `scripts/start-hosted.sh` | One-service deployment; see [docs/deploy-railway.md](docs/deploy-railway.md) |
| `registry/` | Public listings, reviews and JSON Schemas |
| `examples/dev-registry/` | Reviewed listing for the localhost demo seller |
| `docs/research/competitor-ux.md` | Survey of other agent API markets |

## What is real and what is not

**Real and tested on testnet**
- Chain Signatures derives the Base payer address and signs the channel deposit (txs above).
- x402 V2 payments with `batch-settlement` and `exact`, through the public facilitator at `x402.org`.
- The demo seller reads live NEAR testnet state (`view_account`) and returns 503 without charging when every RPC fails.
- All 7 MCP tools, driven by the official MCP client over stdio (`packages/mcp-server/scripts/smoke.mjs`).
- Review gating by manifest hash, the daily cap and idempotency.
- Failed calls cost $0: in live runs, RPC outages came back as `unpaid_error` receipts. There is no automated test for this path yet.
- **On-chain spending policy (BFA treasury).** [`treasury.nen-testnet.testnet`](contracts/treasury/README.md) signs only USDC EIP-3009 authorizations for a user's vault, after checking its daily limit, allowed recipients and tokens. The smoke run paid from the vault address `0x4752…82C6` with the channel deposit signed through the treasury ([`0x1e20c350…ed37`](https://sepolia.basescan.org/tx/0x1e20c3505732b51dac3e95027671c07386c5ddf5ed9ec84e1a7468e49276ed37)); an over-limit request was refused on-chain with `limit_reached`. Set `BFA_TREASURY_ID` to use it.
- **API-key gateway.** `packages/gateway` enforces each key's expiry, scopes, allow/block list, daily limit and per-API limits before any payment is signed. Live run on testnet through the treasury: no key → 401, two paid calls, the third refused with `limit_reached` and `resets_at`. 28 offline tests; the Supabase store is tested against a mock only.
- **Non-custodial top-up fee.** [`contracts/fee-splitter`](contracts/fee-splitter/README.md): each user gets a deterministic top-up address; anyone can sweep it, and it can only pay the user's wallet and BFA's 1.5% on-top fee (send $10.15, get $10.00). 18 tests on an in-process EVM. Live on Base Sepolia at [`0xd0fd…340f`](https://sepolia.basescan.org/address/0xd0fd9f5a17cdc84873a836c4c2971b2ae941340f), deployed with no EVM key (signed by NEAR Chain Signatures); a live top-up of 1.015 USDC was [swept](https://sepolia.basescan.org/tx/0xacc5b1c5c078d85293be34d1fdef0cbfeac1dad544c1a26e52295399c161244f) into 1.000 USDC for the user and 0.015 USDC for BFA.

**Not done yet**
- The demo seller runs on localhost only. It is not deployed at a public https URL, so `submit_listing` on it correctly fails `public_https`.
- `nansen/smart-money-holdings` is listed but not reviewed, so it does not route. We have not made a paid mainnet call to it.
- Seller payout through NEAR Intents (`payout.via: "near-intents"`) is in the schema only. Nothing executes it yet.
- The website ([`site/index.html`](site/index.html)) is a preview: sign-in (Privy), card top-ups, auto top-up and API keys are not wired to a backend yet.
- The MCP server has no unit tests. It is covered only by the live smoke script.
- Mainnet: not yet.

## License

MIT

# Competitor UX review: API marketplaces for AI agents

Research date: 2026-11-03. Author: UI/UX research pass for BFA (NEAR hackathon, deadline 2026-11-14).

**Method.** I read 23 public pages with the Monid `context.dev` markdown scraper, plus web search. I also used the Monid MCP server myself (free `discover` and `inspect`, paid `run`), which gave first-hand evidence of its agent UX. I did not call any private API, try to get past a login, or work around a block. Pages I could not reach are marked **[blocked]**. Claims I could not check are marked **[unverified]**. Numbers on competitor pages are what each site says about itself on the day I scraped it.

**Fit with the current BFA repo.** The recommendations below reuse names already in `registry/schema/listing.schema.json`, `registry/schema/review.schema.json` and `packages/core/src/types.ts`: `charges_empty_results`, `payout.via = near-intents`, review `status` / `manifest_sha256` / `routable` / `not_routable_reason`, `Health`, `Quote.rationale` / `fallbacks`, `ReceiptStatus` (`paid_ok`, `paid_empty`, `paid_error`, ...), and `BfaErrorShape.next_action`. Most of this report is about showing data BFA already models, not about inventing new data.

---

## 1. TL;DR: the 5 design decisions that matter most

1. **Show the exact price and the charge policy together, everywhere**: "$0.05 / call · empty result: free · error: free". Put it on catalog cards, the listing page, `inspect` and every receipt. (AIsa and Monid do this best. Nobody does it per seller.)
2. **Make the review state public on each listing**: bot-check results, human review status, reviewer, date, and the `manifest_sha256` that was approved. If the live manifest no longer matches, flip the badge to "changed since review". No competitor shows any of this.
3. **Onboarding is one paste with no private key**: an MCP URL plus a sign-in with a NEAR account and a daily cap, then one starter prompt. Competitors tell agents to put `AGENT_PRIVATE_KEY` / `YOUR_PRIVATE_KEY` in config files. BFA's Chain Signatures story is the visible difference.
4. **Receipts are first-class and linkable.** Every call returns JSON with quoted vs charged price, `status` (`paid_empty` etc.), the Base tx hash, the NEAR payer, latency and `output_valid`. The human spend page is just a view over those receipts.
5. **The seller flow is a live checklist.** Paste the `bfa.json` URL, see bot results row by row with fixes (as x402scan's failure table does), then follow a status timeline (bot → peer review → live) with a NEAR Intents payout chooser. Nothing goes public without an explicit submit.

---

## 2. Competitor-by-competitor

### 2.1 Summary table

| Product | Primary user | Steps to first paid call | Pricing display | Trust signals | Agent affordances | Standout good | Standout weak |
|---|---|---|---|---|---|---|---|
| **Monid** (monid.ai) | Agent (human sets up once) | 3: paste `set up https://monid.ai/SKILL.md` or add MCP URL → OAuth sign-in ($1 free credit) → agent runs discover → inspect → run | USD per call or per unit; `PER_CALL` / `PER_UNIT` in every discover/inspect/run response; "failed and blocked requests consume none" | `verified` and `no-markup` tags, `status: stable`, p50/p95 run time per endpoint; billed units and reported cost (micro-dollars) on each run | Skill file, remote MCP, CLI, x402 pay-per-run; `hints` with ready-to-call templates in every response; `BLOCKED` status with `reason` and `hints` | Machine responses carry the next call (`hints`), price notes and latency metrics | "verified" criteria not stated anywhere I saw; no per-endpoint human review info |
| **AIsa** (aisa.one) | Agent via MCP; human buys the key | 3: get key or OAuth → add MCP server (one-click "Add to Claude" link) → ask for an entity | "Billed per result", "No result, no charge", sample bill with a `$0.000` line for "no result" | Provenance per field (Source · Method · As of), "reported / observed / estimated" labels, "fields only ever get added", "licensed sources only" | One MCP for 30 clients, client picker, copy-prompt plus "Open ChatGPT with task" deep link, OAuth (no key paste), skills repo | Empty-result billing and provenance shown *visually* on the homepage | Aggregator: you never see which seller served you, and there is no seller onboarding |
| **x402 Bazaar** (x402bazaar.org, by Wintyx57) | Both (provider half and agent half side by side in the hero) | ~4: add MCP (auto-generates a wallet) → fund USDC (bridge page) → call → pay | "From $0.005 per call", 0.001 USDC in a curl sample; 95% revenue to seller | "Verified" badge on featured providers (criteria not stated), ERC-8004 link, on-chain payment claims | MCP server (15 tools, auto-wallet), CLI, TS SDK, n8n, LangChain | Four seller entry points: URL+price (~30 s), OpenAPI import, RapidAPI import, payment link | Catalog and counters render client-side: scraper saw "0 services", "0 APIs" in every category, "$0 USDC" volume; listing counts disagree (112 / 107 / 100+) |
| **402.com.tr** ("x402 Bazaar", Base + NEAR, by sukrutkrdg) | Agent | 1 to a *free* call (`claude mcp add x402-bazaar -- npx -y x402-bazaar-mcp`); 2–3 to paid (credit token or wallet key) | Big "$0.04 per call" on each card; "1 free call per service per day" via `?free=1`; prepaid credit packs; `x-credit-balance` header | GO/HOLD/STOP verdicts, "auditable receipt" wording, ERC-8021 attribution dashboard, a tweet from @aixbt_agent | `/.well-known/x402`, `/api/catalog`, OpenAPI, hosted MCP, Smithery and MCP Registry, "bind these first" tool list, NEAR Chain Signatures and NEAR Intents credit purchase | Free-probe design: without `?free=1` you get the 402 "so an unpaid probe always sees the price"; NEAR-native endpoints | Looks single-operator (all endpoints under one origin; no third-party submission flow found **[unverified]**); emoji-dense 229-card wall; private key in MCP env |
| **x402scan** (Merit Systems) | Human (explorer), seller | Buyer: "Try it" hands off to AgentCash **[unverified flow]**. Seller: paste origin URL | Price per resource in server page lists ("$0.06", "< $0.01", "Free" for SIWX); 30-day volume | On-chain activity: txns, volume, buyers, "Latest" (~2h ago) per server; runtime 402 probe at registration | OpenAPI-first discovery spec, "Copy Prompt for Agents", `@agentcash/discovery` CLI, dry-run "Test your API" | Best seller tooling: failure-reason table with fixes, dry-run probe, agent prompt that **requires user approval before registering** | No human review; "featured" is curated but criteria not shown; listing quality depends on seller text |
| **Teneo Protocol** (teneo-protocol.ai, agent-console.ai) | Agent via CLI; plus a consumer node/rewards program | ~3: `npx @teneo-protocol/cli` → wallet/USDC → run command **[unverified details]** | "0.01 USDC per query" per command; "Charged ONLY on HTTP 200" (in seller-written text) | "Jobs executed" counts per agent (e.g., 412k), Online/Offline state, explorer links per chain | CLI, skills repo, per-agent "commands" with examples | Listing detail gives commands with copyable example inputs and a price per command | Homepage leads with a bandwidth-sharing Beacon rewards app; animated counters scraped as "0123456789…"; a Nansen proxy listing showed **Offline** with no explanation |
| **RelAI** (relai.fi/market) | Seller (SDK), agent dev | Code-level: `createX402Client` with a wallet → `fetch` to `api.relai.fi/relay/<apiId>/…` | Seller sets `usdPrice` per path; facilitator sponsors gas | SDK plugins: `shield` (health check before 402), `preflight`, `circuitBreaker`, `refund`, ERC-8004 reputation `score()` injected into the 402 | Management API (create/price APIs from CI), agent self-provisioning of keys, bridge Solana↔SKALE↔Base | **Don't charge for broken endpoints**, enforced in middleware (503 instead of 402) | **[blocked]** relai.fi did not resolve for the scraper (WEBSITE_NOT_FOUND, twice); evidence comes from the npm README v0.6.10, SKALE docs and iq.wiki |
| **NEAR AI Agent Market** (market.near.ai) | Both ("I am Human / I am AI Assistant or Agent" toggle) | ~3: brief in plain English → payment held → accept or refund | Price per job ("$0.50 · Hire →"), USD or USDC, escrow | Jobs, median response time (30 d), success rate (lifetime), **Reputation 83/100 with a weighted breakdown**, reviews with structured checks, hosting (self-hosted / TEE "coming soon") | MCP for hiring and agent-to-agent, docs on Mintlify, REST from live OpenAPI | Most complete trust panel; "Limits" section on each listing | Jobs, not per-call APIs; the `skill.md` onboarding URL cited in its own announcement now returns 404 |
| **Nansen** (seller example) | Agent developer | 2 for a dev who has a wallet: fund USDC on Base/Solana/Monad → x402 client call | Clear tier table: Basic $0.01, Premium $0.05, Smart Money $0.05; "first 100 calls 50% off" promo advertised in `/.well-known/x402` | Brand; no badges needed | `llms.txt` link and a `.md` version at the top of every docs page; typed error `invalid_x402_version`; 429s not charged; `X-Payer-Address` to get a discounted quote | Exemplary seller docs: tier table, excluded endpoints, rate limits, "what if payment fails" FAQ | Sample code uses `Account.from_key("YOUR_PRIVATE_KEY")`; agents.nansen.ai is behind sign-in **[blocked]** |

### 2.2 Notes and evidence

**Monid**: https://monid.ai, https://monid.ai/docs/guide/quickstart-mcp, plus first-hand MCP use.
- Hero: "Give this to your agent: `$set up https://monid.ai/SKILL.md` and let it take it from there." Three ways to connect: Skill, MCP, CLI. "Start with $1 in free credit."
- Its FAQ answers the questions an agent operator actually has: "A provider failed. Do I get charged? No. We only charge when the request actually delivers results"; "Most endpoints carry 0 Markup".
- First-hand: `monid_discover` returned ranked results, each with `price {type: PER_CALL, amount: {value: 0.012, currency: USD}}`, `tags: ["verified","no-markup"]` and `metrics {status: stable, runTimeMs {p50, p95}}`. `monid_inspect` returned the input JSON Schema, price `notes` ("failed and blocked requests consume none. On x402 the quoted estimate is the price."), `docUrl`, and `hints` that are literal next-call templates. `monid_run` returned `billing.reportedCost` in micro-dollars, `billedUnits` and `resultCount`. **My two failed scrapes (bad hostname) were billed `0`**, which confirms the no-charge-on-failure claim. Tool descriptions tell the agent what to do on `BLOCKED` ("surface the reason to the user and ask them to act") and say "Before switching from a free endpoint to a paid alternative, obtain spending permission… Never switch automatically."
- Seller onboarding: "Monid is open source. Contribute your tool to the project… Contribute on GitHub →". This is a PR-based model, close to BFA's.
- Visual: blue (#0016D7) and white, terminal-prompt motif, a wall of logo tiles.

**AIsa**: https://aisa.one, https://aisa.one/connect.
- The homepage shows a sample result *as a table*: `Field | Value | Source | Method | As of`, with the footer "5 fields · 2 sources · one schema ● 1 result billed · no result, no charge".
- A mock bill: "get_person 1 result $0.010 · get_keyword 1 result $0.010 · get_listing no result $0.000 · Total $0.020 · No result, no charge". This is the clearest empty-result billing visual in the set.
- "Reported, observed and estimated values are told apart"; "Fields only ever get added… Breaking changes ship as a new version".
- Connect page: client picker ("Show all 30 clients"), three numbered steps per client, an "Add to Claude" deep link (`claude.ai/customize/connectors?...connectorUrl=https://mcp.aisa.one/mcp`), "Copy prompt" plus "Open ChatGPT with task" (a prompt-prefilled URL), and OAuth "No key to paste". It also publishes `index.md` alternates for agents.
- Weak spots for BFA's purposes: AIsa picks the source, so there is no seller identity, no listing pages and no seller flow. Claims such as "250k+ agent users" come from the company itself.

**x402 Bazaar (x402bazaar.org)**: https://www.x402bazaar.org, /register, /services.
- The hero is split into "For Providers: Monetize any API in 2 min" and "For AI Agents: Any agent. Any API. Instant pay." A curl sample shows the price as a comment (`// 0.001 USDC`).
- The register page offers four cards: "List Your API ~30 sec", "Import OpenAPI (bulk)", "From RapidAPI 1-click", "Payment Links". It is the best "how do you want to list" chooser in the set.
- Evidence for the anti-pattern: the scraped `/services` page showed only "Explore 100+ APIs … AllFree to tryFreeUnder $0.01New this week **0 services**". The homepage category tiles all said "0 APIs", and the traction block said "0 External providers earning revenue · $0 USDC". These are likely JS counters that had not hydrated, but crawlers and agents that read HTML see zeros. The hero also shows "Monthly revenue $24" and "0 txns on SKALE". The filter chips are good, though: "All / Free to try / Free / Under $0.01 / New this week".

**402.com.tr ("x402 Bazaar — Pay-per-call API marketplace on Base & NEAR")**: https://402.com.tr, https://402.com.tr/agents.
- **This is the closest overlap with BFA.** The /agents page describes "**Chain Signatures:** a NEAR account can control an EVM address and sign the x402 payment on Base directly… signed through the NEAR MPC signer". It also sells credit packs for "any asset NEAR Intents routes", and it ships 14 NEAR-native endpoints (near-account, near-transfer-preflight, near-swap-quote, …).
- Good for agents: "135 of them serve one free call a day if you ask for it with `?free=1`… without it you get the 402 challenge, which is deliberate so an unpaid probe always sees the price rather than an answer". There is an `x402 Ping` at $0.002 described as "the cheapest end-to-end x402 test", `x402-seller-check` (buyer-side check that "the URL is a well-formed 402 resource, does the price match, is the payTo sanctioned"), and the instruction "tell your agent to **bind these first**".
- Weak: MCP setup offers `-e AGENT_PRIVATE_KEY=0x…`. The page is a single 229-card wall with emoji icons. I found no third-party seller flow, so it looks single-operator **[unverified]**. It also offers prepaid credits, which BFA's schema rules out (`pricing.model: per_call`, "no prepaid credits").

**x402scan (Merit Systems)**: https://www.x402scan.com, /server/…, /resources/register, /discovery, /discovery/spec.
- Homepage: ecosystem stats for the last 30 days ("Transactions 3.8M · Volume $1.53M · Buyers 32.86K · Sellers 13K"). The Featured Services table has columns `Server | Activity | Volume | Txns | Buyers | Latest | Chain | Try it`.
- Server page: name, `v2` badge, "Try with AgentCash", resource count, tags, payTo addresses, 30-day activity, then a list of resources with `METHOD /path`, tag, `v2` and a price. Seller-written caveats show up verbatim in descriptions ("Known issue: openai.com resolves to wrong entity. x.com returns 404 — use twitter.com"). That is useful honesty that BFA could prompt for in a structured field.
- Register: a single `https://` input plus "Set up x402 with a prompt".
- Discovery spec: OpenAPI at `/openapi.json` with `x-payment-info` (fixed or dynamic price), `info.x-guidance`, and a "Common Failure Reasons" table (`Not Found`, `Input/Output Schema Missing`, `No Payment Modes Detected`, `Expected 402, got 400`, `Malformed Runtime Amount`), each with cause and fix. There is a dry-run "Test your API… Nothing is registered." The copy-paste agent prompt has a hard **registration gate**: "Do NOT register until… The user has explicitly approved registering that specific origin."
- Registered origins get a storefront page and a health-metrics page on tryponcho.com.
- Visual: near-black (#090909) block-explorer look, a command palette (⌘K), dense tables.

**Teneo Protocol**: https://teneo-protocol.ai, https://agent-console.ai/agent-marketplace/nansen-2-3.
- The hero rotates between "Run the Beacon. Earn your share" (bandwidth sharing) and "Connect agents to MCPs · Only pay per result in USDC (x402) · No accounts. No keys. No subscription". There are two products on one page.
- Agent cards show "8.2k Jobs executed" and category chips. The listing detail ("Nansen 2.3") shows status **Offline**, "76 requests · 2 commands", explorer links per chain (Peaq, Base, Avalanche, X Layer, BNB), long seller-written docs ("Charged ONLY on HTTP 200. No charge on errors or invalid inputs."), and a "Commands & Pricing" table (`query 0.01 USDC per query`, `query_premium 0.05 USDC`).
- The counter digits came through as "0123456789…K+", which tells us the stats are animated client-side.

**RelAI**: npm README `@relai-fi/x402@0.6.10` (https://cdn.jsdelivr.net/npm/@relai-fi/x402@0.6.10/README.md), SKALE docs, iq.wiki. **[blocked]** relai.fi/market did not resolve.
- Mostly SDK UX, but its trust model is concrete: "Shield… protects buyers from paying for unhealthy endpoints. Before the server returns 402, Shield runs a health check. If unhealthy, returns 503 instead of asking for payment." `circuitBreaker` blocks payment after repeated failures, and `refund` "auto-credit[s] buyers when paid requests fail". The ERC-8004 `score()` "inject[s] reputation into the 402 response".
- The Management API lets agents and CI create APIs and set pricing ("no browser needed"). "Agent self-setup" signs with `AGENT_PRIVATE_KEY`.

**NEAR AI Agent Market**: https://market.near.ai, https://market.near.ai/a/web-research, https://docs.market.near.ai.
- Homepage: "Live · 658 agents"; "I am Human / I am AI Assistant or Agent" toggle; cards with `JOBS 47 · SUCCESS 70% · $0.50 · Hire →`; "How a hire works: Brief → Hold → Result (Accept, ask for changes, or get refunded on a miss)".
- The listing page is the best structure in the set: breadcrumb → title and category → one-liner → `● Available now · listed Jul 2026` → four stat tiles (Jobs done, Response median 30 d, Success lifetime, Reputation 83/100) → What it does → What to send (example) → What you get back (example output) → Good for → **Limits** → reputation breakdown (Delivery ×0.30 73, Timeliness ×0.15 100, … "40 scored jobs · trailing 12 months, value- & recency-weighted", "this agent vs platform median") → reviews with structured checks ("Matched brief ✓ · Easy to work with ✓") → Hosting & runtime.
- Weak: `https://market.near.ai/skill.md` (which the announcement and search results point to) now renders a 404 page. All five reviews on page 1 came from the same reviewer.

**Nansen (seller-side example)**: https://docs.nansen.ai/getting-started/agentic-payments/x402-payments; agents.nansen.ai **[blocked: sign-in]**.
- The top of every page says: "For the complete documentation index, see llms.txt. This page is also available as Markdown." That is a cheap, high-value agent affordance.
- It states protocol constraints as typed errors ("If your client reports `invalid_x402_version`, upgrade it to V2 and send the payment using the `PAYMENT-SIGNATURE` header"). It gives a tier table, excluded endpoints, rate limits per wallet, "Payments are not charged for rate-limited requests", and promo rules advertised in `/.well-known/x402`.
- This matches the existing `registry/listings/nansen/smart-money-holdings.json` ($0.05, Base, 5 req/s).

**Also comparable (search only, not scraped):** Coinbase CDP **x402 Bazaar** discovery layer (https://docs.cdp.coinbase.com/x402/bazaar, Coinbase launch post 2025-09-09), the "search engine for agents" index that many of the above feed into **[unverified details]**.

---

## 3. Patterns to copy, and anti-patterns to avoid

### 3.1 Patterns to copy (best example in brackets)

| # | Pattern | Best at | How BFA should apply it |
|---|---|---|---|
| P1 | Charge policy next to the price, with a sample bill that includes a "no result $0.000" line | AIsa | Card and listing show `$0.05 / call` plus chips `empty: free` / `errors: free`, taken from `charges_empty_results`. Receipts show `paid_empty` rows explicitly. |
| P2 | Every machine response carries next-call templates (`hints`) and the price notes | Monid | `bfa_inspect` / `bfa_quote` responses include `next: {tool, args}` and `charge_policy`. Errors already have `next_action`. |
| P3 | One-paste onboarding: skill URL or MCP URL plus OAuth, no key paste; a client picker; "copy prompt" | Monid, AIsa | `/agents` page with a client picker (Claude Code, Cursor, Codex, Claude.ai) and a NEAR sign-in instead of a key. |
| P4 | `llms.txt` plus a `.md` twin for every page, announced at the top | Nansen | Every BFA page has a `.md` / `.json` twin, and the catalog itself is served as `catalog.json` and `llms.txt`. |
| P5 | Unpaid probe always returns the 402 with price; cheap ping endpoint for testing the payment path | 402.com.tr | Ship a `bfa/ping` listing at the lowest price for demo and agent self-test (near-native category). |
| P6 | Seller failure table: error → cause → fix, plus a dry-run probe that registers nothing | x402scan | Listing bot output uses that exact format, rendered on the submission page and posted as a PR comment. |
| P7 | Registration gate: the agent prompt must get explicit human approval before publishing | x402scan | "List with your coding agent" prompt that validates `bfa.json` but stops before opening the PR. |
| P8 | Multiple seller entry points (URL+price, OpenAPI import, …) | x402 Bazaar | MVP: paste manifest URL, or a form that generates `bfa.json`. Nice-to-have: import from `/openapi.json` `x-payment-info`. |
| P9 | Listing anatomy: stats tiles → what it does → what to send → what you get → **Limits** → reputation breakdown → reviews | NEAR AI Agent Market | Same skeleton with API-appropriate stats (success rate, p50, empty-paid rate from `Health`). |
| P10 | Reputation as a transparent weighted formula, compared with the platform median | NEAR AI Agent Market | Show how `Quote.score` is computed ("success 0.97 × …"), and the `rationale` string the router already produces. |
| P11 | Don't charge for broken endpoints (health check before 402; circuit breaker) | RelAI | Router refuses to pay when `Health.success_rate` is below a threshold and returns `use_fallback` with `fallback_listing_id`. Show "Paused: failing probes" on the listing. |
| P12 | Per-server activity table (txns, buyers, last seen) | x402scan | Catalog sort "Most used (7 d)" and a "last successful call ~2h ago" chip, from receipts. |
| P13 | Provenance per field (source, method, as-of) | AIsa | Lighter version: listing shows `data.sources` and `license_statement` prominently, and receipts carry `served_at` / `as_of` when the seller provides it. |
| P14 | Tier tables, excluded endpoints and rate limits written plainly | Nansen | Listing "Limits" block pulls rate limits from the manifest description (nice-to-have: a structured `limits` field). |

### 3.2 Anti-patterns (with evidence)

| # | Anti-pattern | Seen at | BFA rule |
|---|---|---|---|
| A1 | Catalog and stats rendered only client-side, so HTML readers see "0 services", "0 APIs", "$0" | x402bazaar.org (/services, homepage) | Server-render catalog and numbers. Agents and crawlers must read the same numbers people see. |
| A2 | Animated counters that scrape as digit soup | Teneo ("0123456789…K+") | No animated counters. Show plain numbers with a "as of" timestamp. |
| A3 | Vanity or contradictory stats (112 / 107 / 100+ APIs; "Monthly revenue $24" in the hero) | x402bazaar.org | Only show stats that come from receipts, and label the window ("last 7 d"). Hide a stat until it has meaningful volume. |
| A4 | A private key in MCP env or sample code | 402.com.tr (`AGENT_PRIVATE_KEY`), Nansen (`YOUR_PRIVATE_KEY`), RelAI | BFA's onboarding never asks for a key. Say so on the page: "No private key. Your NEAR account signs via Chain Signatures." |
| A5 | A "Verified" badge with no stated criteria | x402bazaar.org (featured providers), Monid (`verified` tag) | Every badge is clickable and opens the checklist that produced it, with date and reviewer. |
| A6 | A listing marked "Offline" with no reason, since-when or alternative | Teneo (Nansen 2.3) | Show the status from `not_routable_reason`, plus a "since" time and the top fallback listing. |
| A7 | Two products on one homepage (node rewards plus API access) | Teneo | One promise on the homepage: "Pay-per-call APIs for agents, settled on NEAR". |
| A8 | Dead onboarding URLs | market.near.ai/skill.md (404) | CI link-check on `/llms.txt`, `/agents`, MCP URL and the snippet in the README. |
| A9 | Wall of 200+ emoji cards with no filters above the fold | 402.com.tr | Filters first, then a dense table or list view with price aligned in its own column. |
| A10 | Reviews from a single reviewer shown as social proof | NEAR AI Agent Market (page 1 of reviews: same reviewer ×5) | Don't show reviews in the MVP. Show the review *process* (who reviewed the listing, against what checklist). |
| A11 | A gated seller "agents" site | agents.nansen.ai | All of BFA's catalog, listing, review status and receipt views are public and readable without an account (receipts are keyed by NEAR account, which is already public on chain). |

---

## 4. Gaps no competitor fills that BFA can own

1. **Public review status for each listing.** No competitor shows *human* review state. x402scan probes automatically, x402 Bazaar's "Verified" is undefined, and Monid's `verified` is unexplained. BFA already has `ReviewStatus = pending | reviewed | verified-provider | suspended | rejected` with `reviewer` and `reviewed_at`. Render it as a timeline on the listing and expose it in `bfa_inspect`.
2. **Manifest-hash verification.** The listing shows `sha256: 3f9a…c21e (approved by @reviewer on 2026-11-05)`. If the live `bfa.json` hash ≠ the approved hash, the badge flips to **"Changed since review: not routable"**. This uses the existing `routable` / `not_routable_reason`. Receipts carry the hash, so an agent can prove which reviewed version it paid for. Nobody else ties a payment to a reviewed contract.
3. **Empty-result billing per seller, declared and audited.** AIsa makes the promise for its own aggregated catalog; marketplaces leave it to seller prose (Teneo: "Charged ONLY on HTTP 200"). BFA has `charges_empty_results` in the manifest *and* `paid_empty` in receipts. Show "declared: empty is free" next to "observed: 0.4% of paid calls returned empty (`Health.empty_paid_rate`)". That "declared vs observed" pair is a signal no one else publishes.
4. **Quote → charge reconciliation on every receipt.** No competitor shows the quoted price, the 402 amount and the settled amount side by side. BFA's bot already checks "price matches 402". Repeat that check on every call and put `quoted_usd` / `charged_usd` / `match: true` on the receipt.
5. **Keyless agent payments as the default path.** 402.com.tr documents Chain Signatures as one option among private-key options. BFA should make it *the* onboarding: "Sign in with NEAR → set daily cap → done", and show the derived Base address and the cap on the spend page.
6. **Seller payout chooser through NEAR Intents.** x402 Bazaar pays 95% in USDC on its chains. RelAI bridges Solana↔SKALE↔Base in its SDK. Nobody offers "get paid in *any* chain/token" as a step in listing. `payout.via = near-intents` with `chain` / `token` / `recipient` already exists, so make it a visual chooser in the list flow.
7. **Persistent, public bot-check history.** x402scan's dry-run is one-off and private. BFA can publish the latest bot report (`bot_report_url`) on each listing ("last probe 14 min ago: 402 ok, price ok, schema ok") and keep re-probing. This doubles as uptime evidence.
8. **A crypto-data shelf with NEAR-native endpoints.** Generalists (Monid 2,900 tools, AIsa 5,000 APIs) bury crypto data, and 402.com.tr is one operator. BFA's catalog can open on "Onchain data · Market data · NEAR-native" with Nansen as anchor seller.

---

## 5. Recommended information architecture and wireframes

**Build budget: 2 people × ~8 days.** **[M]** = must-have for the demo; **[N]** = nice-to-have. Assumed stack: static or SSR pages generated from `registry/` plus a receipts store. Render everything on the server (A1).

### 5.0 Sitemap

```
/                      Catalog (also /catalog.json, /llms.txt)            [M]
/l/{provider}/{slug}   Listing detail (also .json, .md)                    [M]
/agents                Agent onboarding: MCP snippet + prompt              [M]
/list                  List your API: paste manifest / form → submit       [M]
/submissions/{id}      Bot-check report + review timeline (public)         [M]
/review                Reviewer queue (team-only actions, public read)     [M, minimal]
/spend/{near_account}  Receipts & spend for an agent (also .json)          [M]
/r/{receipt_id}        Single receipt (human view of the JSON)             [M]
/sellers/{provider}    Provider page, payouts summary                      [N]
/.well-known/x402      Machine catalog (x402 convention)                   [N]
/openapi.json, /mcp    BFA's own API + MCP server                          [M]
```

Global header: `BFA | Catalog · For agents · List your API · Spend | [Sign in with NEAR]`. Footer: `llms.txt · OpenAPI · MCP · GitHub registry · Review policy`.

### 5.1 Catalog page `/` [M]

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Pay-per-call APIs for AI agents. Settled on NEAR. No keys.                 │
│ [Connect your agent →]  [List your API →]        12 live · 3 in review     │
├───────────────────────────────────────────────────────────────────────────┤
│ Search [ smart money holdings…                ]   Sort: [Best match ▾]     │
│ Category: (All) (Onchain data) (Market data) (NEAR-native) (Social) (Web)  │
│ Filters:  [✓ Live only] [ Empty results free] [ ≤ $0.01] [Network: Base ▾] │
├───────────────────────────────────────────────────────────────────────────┤
│ NAME / PROVIDER            PRICE        CHARGE POLICY     HEALTH   STATUS  │
│ Smart Money holdings       $0.05/call   empty free ·      99% ·    ✓ Rev.  │
│ Nansen · onchain-data                   errors free       420ms   sha 3f9a │
│ NEAR account check         $0.002/call  empty free        100% ·   ✓ Rev.  │
│ bfa · near-native                                         180ms           │
│ Token flows                $0.01/call   ⚠ empty charged   —        ◷ Pend. │
│ …                                                                         │
└───────────────────────────────────────────────────────────────────────────┘
```

- Use a table or list, not a card wall (A9). Prices go in a monospace, right-aligned column with an explicit unit, and always come from `pricing.amount_usd`.
- The STATUS column renders `ReviewStatus`. Pending listings are visible but greyed and labelled "not routable", so the bot→review pipeline is part of the demo story. **[M]**
- "Charge policy" chips come from `charges_empty_results`. "Errors free" is a BFA platform rule; only show it if the router actually enforces it.
- HEALTH = `Health.success_rate` · `p50_ms`, shown as "—" until `samples ≥ 20` (A3). **[M if receipts exist by day 5, otherwise N]**
- Sort options: Best match (router score), Price ↑, Most used 7 d **[N]**.
- The same data ships as `/catalog.json` and `/llms.txt`, with a `<link rel="alternate">` pointing at them. **[M]**

### 5.2 Listing detail `/l/{provider}/{slug}` [M]

```
Catalog / Onchain data / Smart Money holdings                    [.json] [.md]
┌───────────────────────────────────────────────────────────────────────────┐
│ Smart Money holdings                          by Nansen  ↗ nansen.ai       │
│ Current token holdings of wallets labelled Smart Money, by chain.          │
│ ● Routable   ✓ Reviewed by @alice · 2026-11-05 · manifest sha256 3f9a…c21e │
├──────────────┬──────────────┬──────────────┬──────────────┬───────────────┤
│ $0.05 / call │ Empty: FREE  │ Success 99%  │ p50 420 ms   │ Empty-paid    │
│ USDC · Base  │ (declared)   │ last 7 d     │ last 7 d     │ 0.0% (observed)│
├──────────────┴──────────────┴──────────────┴──────────────┴───────────────┤
│ [Use from your agent]  copy:  bfa_run("nansen/smart-money-holdings", {...})│
├───────────────────────────────────────────────────────────────────────────┤
│ What to send          example_input (copy)    │ input_schema (collapsible) │
│ What you get back     example output / output_schema (collapsible)         │
│ Limits                rate limits, excluded cases, known issues            │
│ Data & license        data.sources · data.license_statement · terms ↗      │
│ Payment               x402 V2 · eip155:8453 · payout: direct / NEAR Intents│
├───────────────────────────────────────────────────────────────────────────┤
│ Review & checks                                                            │
│  Bot check · 14 min ago      ✓ 402 returned  ✓ price $0.05 = manifest       │
│                              ✓ schema valid  ✓ paid test call: output valid │
│  Timeline  submitted 11-04 → bot passed 11-04 → reviewed 11-05 (@alice)    │
│  Manifest  sha256 3f9a…c21e  = approved hash ✓   [view bfa.json on GitHub] │
├───────────────────────────────────────────────────────────────────────────┤
│ Recent calls (public receipts)  rcpt_…  paid_ok  $0.05  412ms  2m ago  →   │  [N]
└───────────────────────────────────────────────────────────────────────────┘
```

- Status line states: `● Routable`, `◷ Pending review`, `⚠ Changed since review (live hash ≠ approved)`, `⏸ Suspended: <notes>`, `✕ Rejected`. Each one shows `not_routable_reason` verbatim and a fallback ("Try instead: …" from `Quote.fallbacks`) (A6). **[M]**
- The 5 stat tiles come from the NEAR Agent Market's layout, adapted to APIs. Pair "declared" with "observed" for empty results (Gap 3). **[M for declared, N for observed]**
- The "Use from your agent" box gives one line for MCP and a `curl` tab showing the raw 402 flow. **[M]**
- Limits block: free text in MVP, structured later **[N]**. This is P14 / Nansen.
- Every badge links to the bot report and the review record (A5). **[M]**

### 5.3 List-your-API flow `/list` → `/submissions/{id}` [M]

Step 1, choose an entry (x402 Bazaar-style chooser, trimmed for MVP):

```
How do you want to list?
( ) Paste a bfa.json URL or file          ← [M]
( ) Fill a form → we generate bfa.json    ← [M if time, simple form over listing.schema.json]
( ) Import from /openapi.json (x-payment-info) ← [N]
( ) List with your coding agent: [Copy prompt]  (validates, then STOPS for your approval) ← [M, it's just text]
```

Step 2, payout chooser (Gap 6):

```
Where should you get paid?
( ) Direct: payTo is my own address on Base        payout.via = "direct"
(•) Any chain via NEAR Intents
     Chain [ near ▾ ]  Token [ USDC ▾ ]  Recipient [ seller.near        ]
     "Agents pay USDC on Base; NEAR Intents delivers USDC on NEAR to seller.near.
      Est. fee shown at settlement." [unverified: fee display depends on 1Click quote]
```

Step 3, bot-check report (live, row by row; x402scan failure-table format):

```
Bot check for nansen/smart-money-holdings                 run 2026-11-04 10:12
 ✓ Manifest valid against listing.schema.json
 ✓ id unique · provider.url https
 ✓ Endpoint reachable (POST, 312 ms)
 ✓ Unpaid probe returned HTTP 402 (x402 V2)
 ✓ Price match: manifest $0.05 = 402 accepts[].amount 50000 (USDC, 6 dp)
   (a failing row would read:)
 ✗ Price mismatch: manifest $0.05 vs 402 $0.10
     Cause: amount_usd differs from accepts[].amount.  Fix: update amount_usd or your 402.
 ✓ Network eip155:8453 offered in 402 accepts[]
 ✓ Paid test call with example_input → 200, output matches output_schema
 ◷ Empty-result behaviour: not tested (needs example_empty_input)   [N]
[Re-run checks]                                  [Submit for review →] (disabled until all ✓)
```

Step 4, status timeline on `/submissions/{id}`, public and linkable from the PR:

```
● Submitted 11-04 10:10 → ● Bot passed 10:12 → ◷ In peer review (est. < 24 h) → ○ Live
Manifest sha256 3f9a…c21e · PR #12 ↗ · Reviewer: unassigned
```

- Implementation shortcut: the bot is a GitHub Action posting the same rows as a PR comment, and the page renders the latest bot JSON. **[M]**
- The "Submit" step should be the PR itself (CODEOWNERS already gate `registry/reviews/`). The web form can just pre-fill a GitHub "new file" URL. **[M]**, and much cheaper than building auth.

### 5.4 Reviewer queue `/review` [M, minimal]

```
Queue (3)     Filter: [Bot passed ▾]  [Oldest first ▾]
ID                         BOT     PRICE   PAYOUT        WAITING  CHANGED?
acme/token-flows           ✓ 7/7   $0.01   near-intents  18 h     new
nansen/smart-money-hold.   ✓ 7/7   $0.05   direct        2 h      hash changed (price ↑)
foo/scraper                ✗ 2 fail $0.20  direct        1 h      —

▸ acme/token-flows
  Diff vs last approved: (new listing)              [open PR ↗]
  Checklist  [ ] description is agent-facing, no marketing
             [ ] license_statement credible for data.sources
             [ ] price sane for category (median onchain-data $0.02)
             [ ] charges_empty_results declared truthfully (bot probe)
             [ ] payout recipient controlled by provider (contact confirmed)
  Decision   (•) reviewed  ( ) verified-provider  ( ) rejected  ( ) suspended
  Notes      [                                      ]
  [Write review record → opens PR to registry/reviews/acme/token-flows.json]
```

- "Hash changed" rows put re-reviews of price or schema changes at the top (Gap 2). **[M]**
- The checklist is shown publicly, read-only, on the listing as "Reviewed against: …" (A5, A10). **[M]**
- Actions go out as GitHub PRs, so there's no backend auth to build. Read-only page plus a deep link to a PR template. **[M]**

### 5.5 Agent receipts and spend `/spend/{near_account}` and `/r/{id}` [M]

```
Spend for research-bot.near        derived Base payer 0x7a…91 (Chain Signatures)
Today $0.37 of $2.00 daily cap ▓▓▓░░░░░░░   Calls 19 · Charged 15 · Free 4
Filters: [All statuses ▾] [Listing ▾] [Last 24 h ▾]          [Download JSONL]

TIME      LISTING                  STATUS      QUOTED  CHARGED  LATENCY  TX
10:41:02  nansen/smart-money-hold. paid_ok     $0.05   $0.05 ✓  412 ms   0x9c…↗
10:40:55  acme/token-flows         paid_empty  $0.01   $0.00    380 ms   —    ← empty: free
10:39:10  nansen/smart-money-hold. unpaid_error —      $0.00    —        —    over_daily_budget → stop
10:30:00  foo/scraper              paid_error  $0.20   $0.20 ⚠  9.8 s    0x1d…↗  output_valid=false
```

The single receipt page `/r/{id}` is a pretty-printed version of the JSON:

```json
{
  "receipt_version": 1,
  "receipt_id": "rcpt_…",
  "listing_id": "nansen/smart-money-holdings",
  "manifest_sha256": "3f9a…c21e",          // proposed addition (Gap 2)
  "status": "paid_ok",
  "price_usd": "0.05",
  "quoted_usd": "0.05", "charged_usd": "0.05", // proposed addition (Gap 4)
  "network": "eip155:8453",
  "payment_tx": "0x9c…",
  "payer": "0x7a…91",
  "payer_near_account": "research-bot.near",  // proposed addition
  "http_status": 200,
  "output_valid": true,
  "latency_ms": 412,
  "started_at": "2026-11-05T10:41:02Z"
}
```

- `paid_error` rows with `output_valid=false` get a "Report to reviewers" link (opens a GitHub issue) **[N]**. This is the feedback loop for `suspended`.
- If `paid_empty` shows up on a listing that declared `charges_empty_results: false` with a non-zero charge, highlight it in red, because the seller is breaking its declared policy. **[M visual]**
- The cap bar comes from `assertWithinDailyBudget`. Changing the cap is **[N]**; in MVP it's set in the MCP config or at sign-in.

### 5.6 Agent onboarding `/agents` [M]

Layout, AIsa/Monid style: client picker tabs `[Claude Code] [Cursor] [Codex] [Claude.ai] [Any MCP client]` → 3 numbered steps → copy prompt → "What your agent can call" (tool list) → machine links (`llms.txt`, `catalog.json`, OpenAPI).

Step 1, add the server. The URL is a placeholder until deployed:

```bash
claude mcp add --transport http bfa https://<bfa-host>/mcp
```

```json
{
  "mcpServers": {
    "bfa": {
      "type": "http",
      "url": "https://<bfa-host>/mcp"
    }
  }
}
```

Step 2, sign in with NEAR (OAuth-style, as with Monid and AIsa), choose a daily cap, done. Page copy: **"No private key. Your agent pays from a Base address controlled by your NEAR account through Chain Signatures."** *(Design proposal: the exact auth handshake for the MCP server must match what `packages/x402-client/src/near-mpc.ts` supports. If MVP uses a function-call access key in env instead, say plainly what that key can and cannot do.)*

Step 3, the copy-paste starter prompt (one button; also a "copy for agent" version in `/llms.txt`):

> Use the BFA MCP server. Find an endpoint that returns current Smart Money token holdings on Ethereum. Inspect it and tell me its price, whether empty results are charged, and its review status before calling. Call it only if it is under $0.10, and stay under my daily cap. Then show me the top 5 tokens and the receipt ID.

MCP tools to list on the page. Names are a suggestion; align them with `packages/mcp-server`.

| Tool | Returns | Copies |
|---|---|---|
| `bfa_discover(query, max_price_usd?, category?)` | ranked listings with price, charge policy, review status, `rationale` | Monid discover |
| `bfa_inspect(listing_id)` | schemas, example_input, limits, manifest hash, bot report, `next` call template | Monid inspect `hints` |
| `bfa_quote(listing_id, input)` | `Quote` with price, `fallbacks`, `score`, `rationale` | BFA-specific |
| `bfa_run(listing_id, input, max_price_usd, idempotency_key)` | data + `receipt` | |
| `bfa_receipts(since?)` / `bfa_balance()` | receipts, spent today vs cap | Monid balance |

Every error uses the existing `BfaErrorShape`. Show the full list on `/agents` so agents and humans see the same contract. Example:

```json
{ "code": "over_daily_budget", "message": "paying $0.05 would exceed the daily cap of $2.00 (spent $1.98 today)",
  "next_action": "stop", "details": { "spent_today_usd": "1.98", "daily_cap_usd": "2.00" } }
```

Suggested additions to `BfaErrorCode`, so every situation competitors document has a typed code: `listing_changed_since_review` (next_action `use_fallback`), `quote_mismatch` (402 amount ≠ manifest; `stop`), `provider_unhealthy` (RelAI-style "don't pay a failing endpoint"; `use_fallback`). Also make it explicit for every code whether money moved (`charged: false`). Monid and Nansen both document "not charged on X", and agents need it per error.

### 5.7 Suggested 8-day cut (2 people)

| Day | Person A (web) | Person B (agent / backend) |
|---|---|---|
| 1–2 | SSR catalog + listing detail from `registry/` (incl. `.json` / `.md` twins, status line, charge chips) | Listing-bot check rows as JSON + PR comment; manifest hash vs review hash |
| 3–4 | `/list` (paste URL / form → GitHub new-file link), `/submissions/{id}` timeline, payout chooser UI | MCP tools discover / inspect / run; typed errors; receipts with `manifest_sha256`, `quoted_usd` / `charged_usd` |
| 5–6 | `/spend/{account}` + `/r/{id}`; `/review` read-only queue with checklist + PR deep link | Health from receipts and probes; `/catalog.json`, `/llms.txt`, `/openapi.json` |
| 7 | `/agents` page with client tabs + prompt; link-check CI (A8) | `bfa/ping` listing; end-to-end demo: NEAR account → Base payment → receipt |
| 8 | Polish, empty/error states, mobile | Buffer and demo script |

Visual direction: a dense explorer-style table (x402scan) on a calm light/dark theme. Monospace for prices, hashes and IDs. Status colours used only for state (green routable, amber pending/changed, red suspended or policy breach). No emoji icons, no animated counters, no logo walls until there are real sellers.

---

## 6. Sources

Scraped on 2026-11-03 (Monid `context.dev` `/web/scrape/markdown`; 23 billed pages, ~$0.046):

- Monid: https://monid.ai · https://monid.ai/docs/guide/quickstart-mcp · first-hand Monid MCP `monid_discover`, `monid_inspect`, `monid_run` responses (this session)
- AIsa: https://aisa.one · https://aisa.one/connect
- x402 Bazaar: https://www.x402bazaar.org · https://www.x402bazaar.org/register · https://www.x402bazaar.org/services
- 402.com.tr: https://402.com.tr · https://402.com.tr/agents
- x402scan: https://www.x402scan.com · https://www.x402scan.com/server/b8a06bde-b6e8-4a10-b4e0-cc6a25fb9efb (StableEnrich) · https://www.x402scan.com/resources/register · https://www.x402scan.com/discovery · https://www.x402scan.com/discovery/spec
- Teneo: https://teneo-protocol.ai · https://agent-console.ai/agent-marketplace/nansen-2-3
- RelAI: https://cdn.jsdelivr.net/npm/@relai-fi/x402@0.6.10/README.md · **[blocked]** https://relai.fi/market and https://www.relai.fi/market (hostname not found by scraper; not billed)
- NEAR AI Agent Market: https://market.near.ai · https://market.near.ai/a/web-research · https://docs.market.near.ai · https://market.near.ai/skill.md (now a 404 page)
- Nansen: https://docs.nansen.ai/getting-started/agentic-payments/x402-payments · https://agents.nansen.ai (**[blocked]**: only the sign-in screen is public)

From web search only (not scraped; details unverified):

- Coinbase x402 Bazaar launch: https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar · docs https://docs.cdp.coinbase.com/x402/bazaar
- NEAR AI Agent Market announcement: https://near.ai/blog/introducing-near-ai-agent-market
- RelAI: https://skale.space/blog/relai-goes-live-on-skale-on-base-adding-more-firepower-to-the-api-micropayment-movement · https://docs.skale.space/cookbook/facilitators/using-relai · https://iq.wiki/wiki/relai
- Teneo / CMC Labs: https://coinmarketcap.com/academy/th/article/teneo-protocol-joins-cmc-labs-agent-driven-infrastructure
- AIsa docs and funding: https://docs.aisa.one/ · https://aisa.one/news/aisa-raises-6-5m-ai-agent-resource-network
- Monid third-party profile: https://providers.apievangelist.com/providers/monid/
- x402scan as an indexer (third-party description): https://pkg.go.dev/github.com/ObolNetwork/obol-stack/internal/x402scan

BFA repo files read for alignment: `registry/schema/listing.schema.json`, `registry/schema/review.schema.json`, `registry/listings/nansen/smart-money-holdings.json`, `packages/core/src/types.ts`, `packages/core/src/errors.ts`, `packages/core/src/receipts.ts`.

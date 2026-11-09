# NEAR HACKATHON submission: BFA (Built For Agents)

Deadline: **2026-11-14 23:59 UTC** (2026-11-15 06:59 Bangkok). One submission per project and it **cannot be edited**, so fill every field from this page in one sitting. Keep the hosted demo up until at least 2026-11-18 (organizers prefer 2026-11-25).

## Form fields

| Field | Value |
|---|---|
| projectName | BFA (Built For Agents) |
| leadName | *(your name)* |
| email | *(your email)* |
| size | 2 |
| tracks | Agent Economy, Autonomous Business |
| nearAddress | *(your **mainnet** NEAR account for prize payout, e.g. `yourname.near`)* |
| projectUrl | https://github.com/PiNocPie/bfa |
| demoUrl | https://x.com/0xxenonicle/status/2119851375081463890 (live app: https://bfagateway-production.up.railway.app) |
| idea | the text below (under 2000 characters) |
| consent | tick |

Leave any hidden "website" field empty: the organizers use it as a spam trap.

Why these tracks: the organizers' hint for **agents** is "agent commerce, NEAR Intents, chain signatures" and for **business** is "AI agents, chain signatures — humans only set the constraints". That is exactly BFA: people set the limits, agents buy API calls, NEAR signs.

## What did you build? (paste as is, 1901 characters)

The problem: AI agents are becoming the main users of APIs, but APIs are still built for humans: accounts, subscriptions, API keys, a card on file. An agent can't sign up, and you don't want to hand it your card or a private key. We think building for humans first is the wrong bet now that agents are growing this fast.

What we built: BFA, the convenience store for AI agents. It is an open, pay-per-call API market. An agent connects over MCP, finds an API, sees the exact price, pays for one call in USDC with x402 on Base and gets a receipt. You sign in with Google, pick the APIs you prefer in the aisles, set how much to spend on each, and give each agent its own key with an expiry, a daily cap, per-API caps, an allow/block list and a provider order (say Gemini first, then Wan). Anyone can list an API by pull request; a reviewer pins the manifest hash. Failed and empty calls are free.

How NEAR fits in: every user's wallet is a vault in our treasury contract on NEAR. Its Base address is derived by NEAR Chain Signatures, so nobody holds its EVM key. The contract rebuilds each USDC authorization itself and signs only within the user's on-chain daily limit, allowed recipients and pause switch. The agent's gateway gets a NEAR function-call key that can call only sign_eip3009, so it can spend within the limit but never raise it. The NEAR wallet key is made in the user's browser, and the user signs their own vault setup. Top-ups go through a public split contract: send $10.15, $10.00 lands in your vault, $0.15 is our fee.

Live on testnet (NEAR testnet + Base Sepolia), shown in the demo: a new user signs in, sets up a wallet, gets test USDC, makes a key with a $0.003 daily limit, and an agent pays three calls from that vault before the fourth is refused with limit_reached, before any money moves.

Next, on mainnet: top-ups in any token and seller payouts through NEAR Intents.

## X post: the public demo post (attach bfa-demo-full.mp4, 2:16)

NEAR's rules count a public demo post as part of the entry, so post this before submitting and use the link to post 1 as demoUrl. X counts each link as 23 characters.

Post 1 (266):

```
AI agents are growing too fast to keep building for humans first.

We built BFA, the convenience store for AI agents. You pick the APIs and a budget; your agent pays per call with x402 on Base, signed by NEAR Chain Signatures.

bfagateway-production.up.railway.app
#NEARHackathon
```

Reply 2 (268):

```
In the video: the agent bought 3 calls for $0.003 from its owner's vault. Call 4 was refused at its daily limit before any money moved.

1. Pick the APIs you prefer, set $ for each
2. Copy one prompt to your agent
3. It checks each price, pays per call, keeps receipts
```

Reply 3 (130):

```
Anyone can list an API on BFA by pull request.

Open source: github.com/PiNocPie/bfa
Which API should we stock next? @NEARProtocol
```

Optional reply 4, roadmap (185):

```
Next, on mainnet: top up with any token through NEAR Intents (it swaps into USDC on Base for you), seller payouts in any token, and a cart tool that quotes a whole basket before paying.
```

Videos: `bfa-demo-full.mp4` (2:16, the one to post) and `bfa-demo-short.mp4` (58 s). Both are silent with burned-in captions and show real testnet transactions. Don't use the older 1:57 cut: its basket prompt mentions a cart tool that isn't built.

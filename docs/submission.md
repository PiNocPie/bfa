# NEAR HACKATHON submission: BFA (Built For Agents)

Deadline: **2026-11-14 23:59 UTC** (2026-11-15 06:59 Bangkok). One submission per project and it **cannot be edited**, so fill every field from this page in one sitting. Keep the hosted demo up until at least 2026-11-18 (organizers prefer 2026-11-25).

## Form fields

| Field | Value |
|---|---|
| projectName | BFA (Built For Agents) |
| leadName | *(your name)* |
| email | *(your email)* |
| size | 2 |
| tracks | `agents`, `business` |
| nearAddress | *(your **mainnet** NEAR account for prize payout, e.g. `yourname.near`)* |
| projectUrl | https://github.com/PiNocPie/bfa |
| demoUrl | the link to your X demo post (live app: https://bfagateway-production.up.railway.app) |
| idea | the text below (under 2000 characters) |
| consent | tick |

Leave any hidden "website" field empty: the organizers use it as a spam trap.

Why these tracks: the organizers' hint for **agents** is "agent commerce, NEAR Intents, chain signatures" and for **business** is "AI agents, chain signatures — humans only set the constraints". That is exactly BFA: people set the limits, agents buy API calls, NEAR signs.

## idea (paste as is, 1942 characters)

BFA is the convenience store for AI agents: open 24 hours, for every agent. It is an open, pay-per-call API market: an agent connects over MCP, finds an API, sees the exact price, pays for one call in USDC over x402 and gets a receipt. No subscriptions, no per-provider accounts, no private key in the agent's config.

Every user's wallet is a vault in our treasury contract on NEAR, and its Base address is derived by NEAR Chain Signatures, so nobody holds its EVM key. The contract rebuilds each USDC authorization's EIP-712 digest and signs only within the user's on-chain daily limit, allowed recipients and pause switch. The agent gets a function-call key that can call only sign_eip3009, so it can spend within the limit but never raise it.

People sign in with Google. Their browser makes and keeps a burner NEAR wallet key and they sign their own vault setup. They create API keys with an expiry date, a daily cap, per-API caps, allow/block lists and routing: an ordered list of preferred providers, say Gemini then Wan, tried first when the agent asks by description. Top-ups go to a per-user address whose public contract splits each deposit: send $10.15, $10.00 lands in the vault, $0.15 is BFA's fee. Deposits are one-way: they can only be spent on API calls.

Anyone can list an API by pull request. A reviewer pins the manifest's sha256, and editing the manifest stops routing until a new review. Failed and empty calls are not charged. BFA settles payments through its own x402 facilitator, so calls keep working when a public facilitator runs out of gas.

Live on testnet (NEAR testnet + Base Sepolia), recorded in the demo: a new user signs in, sets up a wallet, gets 1.015 test USDC (1.000 to the vault, 0.015 fee), makes a key with a $0.003 daily limit, and an agent pays three calls from that vault before the fourth is refused with limit_reached. NEAR signs once per payment channel (~10 s); each later call takes ~0.3 s.

## X post: the public demo post (attach the 58 s video)

NEAR's rules count a public demo post as part of the entry, so post this before submitting and use its link as demoUrl. X counts each link as 23 characters: the post is 277, the reply 228.

```
An AI agent bought 3 API calls alone: $0.003 USDC, no account, no API key. Call 4 was refused at its limit.

Paid over x402 from its owner's vault, signed by NEAR Chain Signatures.

BFA: the convenience store for AI agents.

bfagateway-production.up.railway.app
#NEARHackathon @NEARProtocol
```

Reply to it (thread):

```
Any API can list on BFA by pull request. Agents see the price on the tag, pay per call, and you choose which provider they try first.

Built at NEAR HACKATHON. Open source: github.com/PiNocPie/bfa
Which API should we stock next?
```

Videos: `bfa-demo.mp4` (1:57, for the form or YouTube) and `bfa-demo-short.mp4` (58 s, for X). Both are silent with burned-in captions and show real testnet transactions.

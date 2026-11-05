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
| projectUrl | https://github.com/PiNocPie/bfa *(after the rename; must be public)* |
| demoUrl | https://bfagateway-production.up.railway.app |
| idea | the text below (under 2000 characters) |
| consent | tick |

Leave any hidden "website" field empty: the organizers use it as a spam trap.

Why these tracks: the organizers' hint for **agents** is "agent commerce, NEAR Intents, chain signatures" and for **business** is "AI agents, chain signatures — humans only set the constraints". That is exactly BFA: people set the limits, agents buy API calls, NEAR signs.

## idea (paste as is)

BFA is an open, pay-per-call API market built for AI agents. An agent connects over MCP, finds an API, sees the exact price, pays for one call in USDC over x402 and gets a receipt. No subscriptions, no per-provider accounts, no private key in the agent's config.

NEAR does the part nobody else can: every user's wallet is a vault in our treasury contract on NEAR, and its Base address is derived by NEAR Chain Signatures, so nobody holds its EVM key. The contract rebuilds each USDC authorization's EIP-712 digest itself and signs only within the user's on-chain daily limit, allowed recipients and pause switch. The agent gets a function-call key that can call only sign_eip3009, so it can spend within the limit but never raise it.

People sign in with Google. Their NEAR key is generated in their browser and never leaves it; they sign their own vault setup. They create API keys with an expiry date, a daily cap, per-API caps and allow/block lists. Top-ups go to a per-user address whose public contract splits each deposit: send $10.15, $10.00 lands in your vault, $0.15 is BFA's fee. BFA never holds customer money.

Anyone can list an API by pull request. A bot probes the endpoint's 402, a reviewer pins the manifest's sha256, and an edited manifest stops routing until it is reviewed again. Failed and empty calls are not charged.

Live on testnet (NEAR testnet + Base Sepolia): a new user signed in, set up a wallet, topped up 1.015 USDC (1.000 to the vault, 0.015 fee), made a key with a $0.003 daily limit, and an agent paid three calls from that vault before the fourth was refused with limit_reached. With x402 batch settlement, NEAR signs once per channel deposit (~8 s) and each later paid call takes ~300 ms. Every transaction is linked in the README.

## X post (attach the 45 s video, fits in 280 characters)

> Built at #NEARHackathon: BFA, an API market for AI agents.
>
> Agents pay per call in USDC. Your NEAR account signs via Chain Signatures, under an on-chain limit the agent can't raise. Google sign-in; money stays in your vault.
>
> bfagateway-production.up.railway.app
> @NEARProtocol @NearBuilders

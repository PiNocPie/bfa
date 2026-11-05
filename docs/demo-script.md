# Demo video script

Two cuts from one recording. Record the screen at 1920×1080 (QuickTime, OBS or Screen Studio), browser zoom 125%, dark mode. Subtitles for the long cut are in [`demo.srt`](demo.srt); burn them into the X cut.

Before recording:
- Sign in once with a fresh Google account so the wallet setup is shown from scratch.
- Have test USDC ready to send to your top-up address (Circle faucet → Base Sepolia).
- Open Claude Code in a terminal next to the browser with the BFA config added.
- Open basescan in a tab for the deposit transaction.

## Long cut for the submission (about 2:30)

| Time | On screen | Voice-over |
|---|---|---|
| 0:00 | Home page, BB on the receipt | "AI agents need data, but every API wants an account, a subscription and a key. Agents can't sign up, and you don't want to hand them your card." |
| 0:12 | Click **Sign in with Google** | "BFA is an API market built for agents. You sign in with Google." |
| 0:20 | Wallet setup: recovery file downloads, the two signatures | "Your browser creates a NEAR key that never leaves it. You sign two transactions yourself: a vault with your daily limit, and a key for our gateway that can only call sign_eip3009." |
| 0:45 | Wallet page, top-up address, send $1.015, balance shows $1.00 | "To add funds, you send USDC to your own top-up address. A public contract splits it: one dollar to your vault, one and a half cents to us. We never hold your money." |
| 1:05 | Keys page: create a key, 30 days, $0.50 a day, allowlist | "Each agent gets its own API key, with an expiry date, a daily cap, per-API caps and an allowlist." |
| 1:20 | Terminal: Claude Code, prompt "check the NEAR account …" | "Now the agent works on its own. Claude Code finds the API, reads the exact price, and pays for one call." |
| 1:40 | Receipt in the console; basescan tab with the deposit tx | "Every call has a receipt. The payment comes from your vault's Base address, signed by NEAR Chain Signatures and checked by our treasury contract on NEAR." |
| 2:00 | Run calls until `limit_reached` | "When the agent hits its limit, the next call is refused before anything is paid. Failed and empty calls are free." |
| 2:15 | APIs page, then the GitHub README | "Anyone can list an API by pull request; we review it and pin the manifest hash. BFA is open source and live on testnet today." |
| 2:28 | Logo + URL | "BFA. Built for agents." |

## Short cut for X (about 45 s)

| Time | On screen | Caption |
|---|---|---|
| 0:00 | Claude Code paying for a call, receipt appears | Your agent just bought an API call. By itself. |
| 0:06 | Basescan tx | Signed by NEAR Chain Signatures. No private key anywhere. |
| 0:13 | Key form with limits | You set the limits. On-chain. The agent can't raise them. |
| 0:21 | `limit_reached` | Over the limit? Refused before it pays. |
| 0:28 | Top-up split $1.015 → $1.00 + $0.015 | Your money stays in your own vault. |
| 0:36 | Sign in with Google → console | Sign in with Google. That's it. |
| 0:41 | Logo + URL | BFA · Built for agents · #NEARHackathon |

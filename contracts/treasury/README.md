# BFA treasury (NEAR contract)

The treasury lets each user's money stay in their own wallet while their agents spend it within limits that are enforced on-chain.

- **One vault per NEAR account.** The vault's Base address is derived by NEAR Chain Signatures from the treasury account and the path `vault/<user account id>`. Only this contract can ask the MPC network to sign for that address, and nobody holds its EVM key.
- **It signs only USDC payments.** `sign_eip3009` takes a structured USDC EIP-3009 authorization (`TransferWithAuthorization` for x402 `exact`, `ReceiveWithAuthorization` for `batch-settlement` channel deposits), rebuilds the EIP-712 digest itself, checks the policy, and only then calls `v1.signer` (`v1.signer-prod.testnet` on testnet).
- **Policy checks:** the vault exists and is not paused; the token is in the treasury's allowed list (per chain); the recipient is in the vault's allowlist when one is set; and today's total stays within `daily_limit` (USDC atomic units, 6 decimals, resets at 00:00 UTC). If the MPC call fails, the amount is released back to today's limit.
- **Agents can't raise their own limits.** `set_limits`, `pause` and `unpause` need exactly 1 yoctoNEAR attached, which a function-call access key cannot attach. Give the agent a function-call key limited to `sign_eip3009`; keep the full-access key for yourself.

## Live on testnet

| | |
|---|---|
| Contract | [`treasury.nen-testnet.testnet`](https://testnet.nearblocks.io/address/treasury.nen-testnet.testnet) (deploy tx `4v5jpteU66wd6da5wZ6Lm5V7vkgL26XwzNAvKim8JUfY`) |
| Vault | `nen-testnet.testnet`, daily limit 1,000,000 (= $1.00) |
| Vault address (Base Sepolia) | [`0x475206a44AC7eb493775Bf72282bD37C312682C6`](https://sepolia.basescan.org/address/0x475206a44AC7eb493775Bf72282bD37C312682C6) |
| Channel deposit signed through the treasury | [`0x1e20c350…ed37`](https://sepolia.basescan.org/tx/0x1e20c3505732b51dac3e95027671c07386c5ddf5ed9ec84e1a7468e49276ed37) |
| Over-limit request | refused by the contract with `limit_reached` |

Measured on 2026-11-03: a signature through the treasury takes about 8–9 s (one NEAR transaction plus the MPC round trip). With batch settlement that happens once per channel deposit; each paid call after that is a voucher signed locally in 4–6 ms.

## Build and test

Needs Rust with the `wasm32-unknown-unknown` target. The crate builds with Rust 1.86 (`.cargo/config.toml` makes cargo pick dependency versions that support it).

```bash
cargo +1.86.0 test
```

```bash
RUSTFLAGS="-C link-arg=-s" cargo +1.86.0 build --target wasm32-unknown-unknown --release
```

## Deploy and prove one signature (testnet)

```bash
NODE_USE_ENV_PROXY=1 NEAR_ACCOUNT_ID=<you>.testnet node contracts/treasury/scripts/deploy-testnet.mjs
```

The script creates `treasury.<you>.testnet` (its key goes to `~/.near-credentials`, mode 0600), deploys and initializes the contract, creates your vault, asks the treasury for one signature, checks that it recovers to the vault address, and checks that an over-limit request is refused.

## Use it from the MCP server

Set `BFA_TREASURY_ID=treasury.nen-testnet.testnet`. Payments are then signed by your vault instead of directly by your NEAR account, and `wallet` reports the vault address and who controls it.

## Not done yet

- No external audit.
- The contract trusts the `from` field it is given; a wrong `from` only produces a signature for an authorization USDC will reject.
- Mainnet deployment.

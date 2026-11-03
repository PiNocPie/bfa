# @bfa/fee-splitter

Solidity contracts that take BFA's top-up fee without BFA ever holding a customer's money.

Status: tested in an in-process EVM. Not deployed anywhere yet.

## What it does

Each customer wallet gets its own **top-up address** on Base. The customer (or their card on-ramp or exchange) sends USDC there. Then anyone calls `sweep(wallet)`, and the USDC is split in one transaction:

- BFA's fee goes to `feeRecipient`;
- everything else goes to the customer's `wallet`.

Those are the only two places the money can go.

- **`BfaTopUpFactory`** is immutable. It has no owner, no admin functions, no upgrade and no pause. `feeRecipient` and `token` (USDC) are set in the constructor and can never change. Neither can the fee.
- **`BfaTopUp`** is a tiny per-customer contract, deployed with CREATE2 (salt = customer wallet) the first time someone sweeps. Its bytecode fixes the two addresses it can pay. It has no `approve`, no arbitrary call and no withdraw, and only the factory can trigger its `sweep`.
- `topUpAddressOf(wallet)` returns the top-up address **before** it is deployed, so USDC can be sent there first.
- `sweep(wallet)` is permissionless. Anyone can call it: BFA's backend, the customer or a keeper. The caller pays the gas but gets nothing and can't change where the money goes. It emits `Swept(wallet, received, fee, credited)` (plus `TopUpDeployed(wallet, topUp)` on first use).
- Sweeping a zero balance reverts with `NothingToSweep(wallet)` and deploys nothing. `sweep` has a reentrancy guard. Transfers are checked SafeERC20-style by a small inline library (`SafeTransfer.sol`), which accepts `true` or empty return data.

**Only USDC can be swept.** Any other token, or ETH, sent to a top-up address is stuck there for good, because no function can move it. The website must warn about this next to every top-up address.

## Fee math

The fee is 1.5% **on top**. To add $10.00, the customer sends $10.15: $10.00 is credited and $0.15 goes to BFA.

```
fee      = floor(received * 15 / 1015)
credited = received - fee
```

Rounding is down, so any remainder goes to the customer. In USDC's 6-decimal units, `10_150_000` in means `10_000_000` to the wallet and `150_000` to BFA, exactly. When the website charges `credit + floor(credit * 15 / 1000)`, the customer is always credited at least `credit`. `feeOf(received)` exposes the same math on-chain.

## Build and test

No Foundry needed. The package compiles with solcjs `0.8.30` (pinned, optimizer 200 runs, `evmVersion: cancun`) and tests against `@ethereumjs/vm` in process.

```bash
pnpm install
pnpm --filter @bfa/fee-splitter build   # writes out/*.json, prints contract sizes
pnpm --filter @bfa/fee-splitter test
```

Compiler warnings fail the build. The tests compile the sources (plus `test/contracts/MockToken.sol`, a 6-decimal token that can be switched to misbehave) in memory, so they don't depend on `out/`.

The tests cover:

- the address is predictable before deploy and matches the deployed address;
- the exact 10.15 → 10.00 + 0.15 split, and rounding in the customer's favor for odd amounts;
- anyone can sweep;
- nobody, including `feeRecipient`, can move funds anywhere else;
- repeat deposits and sweeps;
- zero balances and the zero wallet;
- tokens that return `false` or no data;
- reentrancy, and other tokens staying stuck.

## Deploy (Base Sepolia)

```bash
pnpm --filter @bfa/fee-splitter build
DEPLOYER_PRIVATE_KEY=0x... FEE_RECIPIENT=0x... pnpm --filter @bfa/fee-splitter deploy:base-sepolia
```

- Chain 84532, RPC `https://sepolia.base.org` (override with `BASE_SEPOLIA_RPC_URL`), USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- `DRY_RUN=1` checks the chain, the USDC contract and the gas estimate without sending anything.
- The key is read only from the environment. Never put it in a file in this repo. The deployer needs a little Base Sepolia ETH, and once the transaction is mined it has no power over the factory.
- The script reads `token()` and `feeRecipient()` back from the new factory and prints its address.

Changing `FEE_RECIPIENT` means deploying a new factory. That changes every customer's top-up address, so the website must always show addresses from the factory it actually uses.

## Live on Base Sepolia

Deployed on 2026-11-03 with no EVM private key: the deployer address is derived from the NEAR account `nen-testnet.testnet` (path `bfa/deployer`) and every transaction was signed by NEAR Chain Signatures (`DEPLOYER_NEAR_ACCOUNT=nen-testnet.testnet node scripts/deploy.mjs`). Its gas ETH was bridged from Ethereum Sepolia the same way (`packages/x402-client/scripts/bridge-sepolia-to-base.mjs`, [tx](https://sepolia.etherscan.io/tx/0xe0e0e9b0049b652608924933a2224c4286b72baaddf954e24adaad81fa8260fc)).

| | |
|---|---|
| Factory | [`0xd0fd9f5a17cdc84873a836c4c2971b2ae941340f`](https://sepolia.basescan.org/address/0xd0fd9f5a17cdc84873a836c4c2971b2ae941340f) ([deploy tx](https://sepolia.basescan.org/tx/0xb8089368b2cedff8629316878305b498601bdf771e5431b2a3a8153b7a3ec9df)) |
| Fee recipient | `0x2016B49D1FF2619Da9782ba3b6d779790693a22A` (NEAR-derived, path `bfa/fees`; testnet only) |
| Example customer wallet | the treasury vault `0x4752…82C6` of `nen-testnet.testnet` |
| Its top-up address | `0x10736D4Cb5faA16C174999316B7A472E65E24d8d` |
| Live top-up | 1.015 USDC sent → [sweep](https://sepolia.basescan.org/tx/0xacc5b1c5c078d85293be34d1fdef0cbfeac1dad544c1a26e52295399c161244f) → **1.000 USDC to the wallet, 0.015 USDC to BFA** |

Sweep anyone's top-up address with:

```bash
WALLET=0x... FACTORY=0xd0fd9f5a17cdc84873a836c4c2971b2ae941340f DEPLOYER_NEAR_ACCOUNT=nen-testnet.testnet node scripts/sweep.mjs
```

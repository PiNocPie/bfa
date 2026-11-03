// Sweep a customer's top-up address: anyone may call it. Prints the split.
//   WALLET=0x... FACTORY=0x... DEPLOYER_NEAR_ACCOUNT=nen-testnet.testnet node scripts/sweep.mjs
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { nearDeployer } from "./near-signer.mjs";

const wallet = getAddress(process.env.WALLET);
const factory = getAddress(process.env.FACTORY);
const account = await nearDeployer(process.env.DEPLOYER_NEAR_ACCOUNT ?? "nen-testnet.testnet", process.env.DEPLOYER_PATH ?? "bfa/deployer");
const transport = http(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org");
const pub = createPublicClient({ chain: baseSepolia, transport });
const wal = createWalletClient({ account, chain: baseSepolia, transport });
const f = parseAbi(["function topUpAddressOf(address) view returns (address)", "function sweep(address)", "function feeRecipient() view returns (address)", "function token() view returns (address)"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const [topUp, fee, token] = await Promise.all([
  pub.readContract({ address: factory, abi: f, functionName: "topUpAddressOf", args: [wallet] }),
  pub.readContract({ address: factory, abi: f, functionName: "feeRecipient" }),
  pub.readContract({ address: factory, abi: f, functionName: "token" }),
]);
const bal = (a) => pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [a] });
const before = await Promise.all([bal(topUp), bal(wallet), bal(fee)]);
console.log("top-up address", topUp, "holds", formatUnits(before[0], 6), "USDC");
if (process.env.DRY_RUN) process.exit(0);
const hash = await wal.writeContract({ address: factory, abi: f, functionName: "sweep", args: [wallet] });
await pub.waitForTransactionReceipt({ hash });
const after = await Promise.all([bal(topUp), bal(wallet), bal(fee)]);
console.log("sweep tx", `https://sepolia.basescan.org/tx/${hash}`);
console.log("wallet +", formatUnits(after[1] - before[1], 6), "USDC; BFA fee +", formatUnits(after[2] - before[2], 6), "USDC; left in top-up", formatUnits(after[0], 6));

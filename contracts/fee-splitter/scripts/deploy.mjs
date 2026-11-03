// Deploy BfaTopUpFactory to Base Sepolia.
//
//   DEPLOYER_PRIVATE_KEY=0x... FEE_RECIPIENT=0x... node scripts/deploy.mjs
// or, with no EVM key at all (the deployer address is derived from a NEAR account and every
// transaction is signed by NEAR Chain Signatures):
//   DEPLOYER_NEAR_ACCOUNT=nen-testnet.testnet DEPLOYER_PATH=bfa/deployer FEE_RECIPIENT=0x... node scripts/deploy.mjs
//
// DEPLOYER_PRIVATE_KEY is read from the environment only. It is never written anywhere.
// The deployer needs a little Base Sepolia ETH for gas. The factory has no owner, so the deployer
// key has no power over the factory once the deployment transaction is mined.
//
// Optional: BASE_SEPOLIA_RPC_URL (default https://sepolia.base.org), DRY_RUN=1 (estimate gas, send nothing).
import { createPublicClient, createWalletClient, encodeDeployData, formatEther, getAddress, http, isAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { compileContracts, solcVersion } from "./compile.mjs";
import { nearDeployer } from "./near-signer.mjs";

const CHAIN_ID = 84532;
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

function fail(msg) {
  console.error(`deploy: ${msg}`);
  process.exit(1);
}

let account;
if (process.env.DEPLOYER_NEAR_ACCOUNT) {
  account = await nearDeployer(process.env.DEPLOYER_NEAR_ACCOUNT, process.env.DEPLOYER_PATH ?? "bfa/deployer");
} else {
  const rawKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rawKey) fail("set DEPLOYER_PRIVATE_KEY (0x-prefixed 32-byte hex), or DEPLOYER_NEAR_ACCOUNT to sign with NEAR Chain Signatures");
  const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("DEPLOYER_PRIVATE_KEY must be 32 bytes of hex");
  account = privateKeyToAccount(key);
}

const feeRecipientRaw = process.env.FEE_RECIPIENT;
if (!feeRecipientRaw || !isAddress(feeRecipientRaw)) fail("set FEE_RECIPIENT to the 0x address that receives BFA's fee");
const feeRecipient = getAddress(feeRecipientRaw);
if (feeRecipient === zeroAddress) fail("FEE_RECIPIENT must not be the zero address");

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const walletClient = createWalletClient({ account, chain: baseSepolia, transport });

const chainId = await publicClient.getChainId();
if (chainId !== CHAIN_ID) fail(`RPC ${RPC_URL} is chain ${chainId}, expected Base Sepolia (${CHAIN_ID})`);

const usdcCode = await publicClient.getCode({ address: USDC_BASE_SEPOLIA });
if (!usdcCode || usdcCode === "0x") fail(`no contract at USDC address ${USDC_BASE_SEPOLIA}`);

const { BfaTopUpFactory } = compileContracts();
const args = [feeRecipient, USDC_BASE_SEPOLIA];
const data = encodeDeployData({ abi: BfaTopUpFactory.abi, bytecode: BfaTopUpFactory.bytecode, args });

const balance = await publicClient.getBalance({ address: account.address });
console.log(`solc          ${solcVersion()}`);
console.log(`chain         Base Sepolia (${chainId}) via ${RPC_URL}`);
console.log(`deployer      ${account.address} (${formatEther(balance)} ETH)`);
console.log(`fee recipient ${feeRecipient}`);
console.log(`token (USDC)  ${USDC_BASE_SEPOLIA}`);

const gas = await publicClient.estimateGas({ account, data });
console.log(`gas estimate  ${gas}`);
if (process.env.DRY_RUN) {
  console.log("DRY_RUN set: nothing sent.");
  process.exit(0);
}
if (balance === 0n) fail("deployer has no Base Sepolia ETH for gas");

const hash = await walletClient.deployContract({ abi: BfaTopUpFactory.abi, bytecode: BfaTopUpFactory.bytecode, args });
console.log(`tx            ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) fail(`deployment failed: ${receipt.status}`);
const factory = receipt.contractAddress;

const [onchainToken, onchainFee] = await Promise.all([
  publicClient.readContract({ address: factory, abi: BfaTopUpFactory.abi, functionName: "token" }),
  publicClient.readContract({ address: factory, abi: BfaTopUpFactory.abi, functionName: "feeRecipient" }),
]);
if (getAddress(onchainToken) !== getAddress(USDC_BASE_SEPOLIA) || getAddress(onchainFee) !== feeRecipient) {
  fail(`factory at ${factory} reports token ${onchainToken} / feeRecipient ${onchainFee}, which does not match`);
}

console.log(`factory       ${factory}`);
console.log(`explorer      https://sepolia.basescan.org/address/${factory}`);

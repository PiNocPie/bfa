import { beforeEach, describe, expect, it } from "vitest";
import {
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  pad,
  toFunctionSelector,
  type Abi,
  type Address,
} from "viem";
import { TestChain, addr } from "./evm.js";

const DEPLOYER = addr(0xde);
const FEE_RECIPIENT = addr(0xfe);
const ALICE = addr(0xa1);
const BOB = addr(0xb0);
const KEEPER = addr(0xcc);
const ONRAMP = addr(0x0a);

/** Reference fee math, done independently of the contract: floor(received * 15 / 1015). */
const expectedFee = (received: bigint) => (received * 15n) / 1015n;

let chain: TestChain;
let factoryAbi: Abi;
let topUpAbi: Abi;
let tokenAbi: Abi;
let token: Address;
let factory: Address;

async function balanceOf(who: Address, tok: Address = token): Promise<bigint> {
  return chain.read<bigint>(tok, tokenAbi, "balanceOf", [who]);
}

async function topUpAddressOf(wallet: Address): Promise<Address> {
  return chain.read<Address>(factory, factoryAbi, "topUpAddressOf", [wallet]);
}

/** An on-ramp pays `amount` of `tok` to the customer's top-up address (which may not exist yet). */
async function deposit(wallet: Address, amount: bigint, tok: Address = token): Promise<Address> {
  const to = await topUpAddressOf(wallet);
  expect((await chain.call(ONRAMP, tok, tokenAbi, "mint", [ONRAMP, amount])).ok).toBe(true);
  expect((await chain.call(ONRAMP, tok, tokenAbi, "transfer", [to, amount])).ok).toBe(true);
  return to;
}

async function sweep(wallet: Address, from: Address = KEEPER) {
  return chain.call(from, factory, factoryAbi, "sweep", [wallet]);
}

beforeEach(async () => {
  chain = await TestChain.create();
  factoryAbi = chain.artifacts.BfaTopUpFactory!.abi;
  topUpAbi = chain.artifacts.BfaTopUp!.abi;
  tokenAbi = chain.artifacts.MockToken!.abi;
  token = await chain.deploy("MockToken");
  factory = await chain.deploy("BfaTopUpFactory", [FEE_RECIPIENT, token], DEPLOYER);
});

describe("BfaTopUpFactory deployment", () => {
  it("stores the fee recipient and token and exposes the fee constants", async () => {
    expect((await chain.read<Address>(factory, factoryAbi, "feeRecipient")).toLowerCase()).toBe(FEE_RECIPIENT);
    expect((await chain.read<Address>(factory, factoryAbi, "token")).toLowerCase()).toBe(token.toLowerCase());
    expect(await chain.read(factory, factoryAbi, "FEE_NUMERATOR")).toBe(15n);
    expect(await chain.read(factory, factoryAbi, "FEE_DENOMINATOR")).toBe(1015n);
  });

  it("rejects a zero fee recipient, a zero token and a token without code", async () => {
    await expect(chain.deploy("BfaTopUpFactory", ["0x0000000000000000000000000000000000000000", token])).rejects.toThrow(
      /ZeroAddress/,
    );
    await expect(
      chain.deploy("BfaTopUpFactory", [FEE_RECIPIENT, "0x0000000000000000000000000000000000000000"]),
    ).rejects.toThrow(/ZeroAddress/);
    await expect(chain.deploy("BfaTopUpFactory", [FEE_RECIPIENT, addr(0x1234)])).rejects.toThrow(/TokenHasNoCode/);
  });

  it("has no owner or admin surface: only views and sweep", () => {
    const fns = factoryAbi.filter((x) => x.type === "function").map((x) => (x as { name: string }).name).sort();
    expect(fns).toEqual(["FEE_DENOMINATOR", "FEE_NUMERATOR", "feeOf", "feeRecipient", "sweep", "token", "topUpAddressOf"]);
    const nonView = factoryAbi.filter(
      (x) => x.type === "function" && x.stateMutability !== "view" && x.stateMutability !== "pure",
    );
    expect(nonView.map((x) => (x as { name: string }).name)).toEqual(["sweep"]);
  });
});

describe("deterministic top-up address", () => {
  it("is known before deployment and equals the address the contract is deployed at", async () => {
    const predicted = await topUpAddressOf(ALICE);

    // Independent CREATE2 computation: keccak256(0xff ++ factory ++ salt ++ keccak256(initcode)).
    const art = chain.artifacts.BfaTopUp!;
    const offchain = getContractAddress({
      opcode: "CREATE2",
      from: factory,
      salt: pad(ALICE, { size: 32 }),
      bytecode: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [token, FEE_RECIPIENT, ALICE] }),
    });
    expect(predicted).toBe(offchain);
    expect(await chain.codeAt(predicted)).toBe("0x");

    await deposit(ALICE, 10_150_000n);
    const r = await sweep(ALICE);
    expect(r.ok).toBe(true);

    const deployed = r.logs.find((l) => l.eventName === "TopUpDeployed");
    expect(deployed?.args.wallet).toBe(getAddress(ALICE));
    expect(deployed?.args.topUp).toBe(predicted);
    // Same runtime code as compiled (immutables are filled in at deploy time, so compare length).
    expect((await chain.codeAt(predicted)).length).toBe(chain.artifacts.BfaTopUp!.deployedBytecode.length);
    expect(await topUpAddressOf(ALICE)).toBe(predicted);

    chain.register(predicted, "BfaTopUp");
    expect(await chain.read(predicted, topUpAbi, "wallet")).toBe(getAddress(ALICE));
    expect(await chain.read(predicted, topUpAbi, "feeRecipient")).toBe(getAddress(FEE_RECIPIENT));
    expect(await chain.read(predicted, topUpAbi, "token")).toBe(token);
    expect(await chain.read(predicted, topUpAbi, "factory")).toBe(factory);
  });

  it("differs per wallet", async () => {
    const a = await topUpAddressOf(ALICE);
    const b = await topUpAddressOf(BOB);
    expect(a).not.toBe(b);
  });
});

describe("fee split", () => {
  it("$10.15 in: exactly $10.00 to the wallet and $0.15 to BFA", async () => {
    const topUp = await deposit(ALICE, 10_150_000n);
    const r = await sweep(ALICE);
    expect(r.ok).toBe(true);
    expect(r.result).toEqual([10_150_000n, 150_000n, 10_000_000n]);

    expect(await balanceOf(ALICE)).toBe(10_000_000n);
    expect(await balanceOf(FEE_RECIPIENT)).toBe(150_000n);
    expect(await balanceOf(topUp)).toBe(0n);

    const swept = r.logs.filter((l) => l.eventName === "Swept");
    expect(swept).toHaveLength(1);
    expect(swept[0]!.address).toBe(factory);
    expect(swept[0]!.args).toEqual({ wallet: getAddress(ALICE), received: 10_150_000n, fee: 150_000n, credited: 10_000_000n });
  });

  it("odd amounts round in the customer's favor", async () => {
    const amounts = [1n, 2n, 67n, 68n, 1014n, 1015n, 1016n, 1_015_001n, 999_999n, 10_150_001n, 10_149_999n, 123_456_789n];
    for (const [i, received] of amounts.entries()) {
      const wallet = addr(0x1000 + i);
      await deposit(wallet, received);
      const r = await sweep(wallet);
      expect(r.ok, `sweep ${received}`).toBe(true);
      const fee = expectedFee(received);
      const credited = received - fee;
      expect(r.result).toEqual([received, fee, credited]);
      expect(await balanceOf(wallet)).toBe(credited);
      // The fee never exceeds the exact 15/1015 share, and the customer always gets at least 1000/1015.
      expect(fee * 1015n <= received * 15n).toBe(true);
      expect(credited * 1015n >= received * 1000n).toBe(true);
    }
    // Small deposits whose 1.5% is under one unit (6 decimals: under $0.000001) pay no fee at all.
    expect(await balanceOf(addr(0x1000 + 2))).toBe(67n);
    expect(await balanceOf(FEE_RECIPIENT)).toBe(amounts.reduce((s, a) => s + expectedFee(a), 0n));
  });

  it("feeOf matches floor(received * 15 / 1015) across many amounts", async () => {
    let x = 0x9e3779b97f4a7c15n;
    for (let i = 0; i < 300; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      const received = x % 10n ** (BigInt(i % 13) + 1n);
      expect(await chain.read(factory, factoryAbi, "feeOf", [received])).toBe(expectedFee(received));
    }
  });

  it("charging 1.5% on top always credits at least the amount the customer asked for", async () => {
    // What the website charges: credit + floor(credit * 15 / 1000).
    for (const credit of [1n, 99n, 1_000_000n, 1_000_001n, 10_000_000n, 12_345_678n, 99_999_999n]) {
      const pay = credit + (credit * 15n) / 1000n;
      const fee = (await chain.read<bigint>(factory, factoryAbi, "feeOf", [pay]));
      expect(pay - fee >= credit, `credit ${credit}`).toBe(true);
    }
  });
});

describe("permissions", () => {
  it("anyone can sweep, and the money still goes only to the wallet and BFA", async () => {
    for (const [i, caller] of [KEEPER, FEE_RECIPIENT, BOB, ALICE].entries()) {
      await deposit(ALICE, 1_015_000n);
      const r = await sweep(ALICE, caller);
      expect(r.ok, `sweep by ${caller}`).toBe(true);
      expect(await balanceOf(ALICE)).toBe(1_000_000n * BigInt(i + 1));
      expect(await balanceOf(FEE_RECIPIENT)).toBe(15_000n * BigInt(i + 1));
    }
    expect(await balanceOf(KEEPER)).toBe(0n);
    expect(await balanceOf(BOB)).toBe(0n);
  });

  it("nobody, including the fee recipient, can move a top-up's funds anywhere else", async () => {
    const topUp = await deposit(ALICE, 10_150_000n);

    // Before deployment there is no code and no key behind the CREATE2 address: only sweep can move it.
    for (const who of [FEE_RECIPIENT, DEPLOYER, KEEPER]) {
      const r = await chain.call(who, token, tokenAbi, "transferFrom", [topUp, who, 1n]);
      expect(r.ok).toBe(false);
    }

    expect((await sweep(ALICE)).ok).toBe(true);
    await deposit(ALICE, 10_150_000n);
    chain.register(topUp, "BfaTopUp");

    // The per-customer contract's sweep only answers to the factory.
    for (const who of [FEE_RECIPIENT, DEPLOYER, KEEPER, ALICE]) {
      const r = await chain.call(who, topUp, topUpAbi, "sweep");
      expect(r.ok).toBe(false);
      expect(r.error).toBe("OnlyFactory");
    }

    // It has no other entry points: ERC-20 style calls, approvals, arbitrary data and plain calls all revert.
    const probes = [
      encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [FEE_RECIPIENT, 1n] }),
      encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [FEE_RECIPIENT, 2n ** 256n - 1n] }),
      toFunctionSelector("execute(address,uint256,bytes)"),
      toFunctionSelector("withdraw(address,address,uint256)"),
      "0x" as const,
      "0xdeadbeef" as const,
    ];
    for (const data of probes) {
      const r = await chain.rawCall(FEE_RECIPIENT, topUp, data);
      expect(r.ok, `probe ${data}`).toBe(false);
    }
    const fns = topUpAbi.filter((x) => x.type === "function").map((x) => (x as { name: string }).name).sort();
    expect(fns).toEqual(["factory", "feeRecipient", "sweep", "token", "wallet"]);

    // No allowance was ever granted, so transferFrom by the fee recipient still fails.
    expect(await chain.read(token, tokenAbi, "allowance", [topUp, FEE_RECIPIENT])).toBe(0n);
    expect((await chain.call(FEE_RECIPIENT, token, tokenAbi, "transferFrom", [topUp, FEE_RECIPIENT, 1n])).ok).toBe(false);

    // The second deposit is still there, and sweeping it pays Alice.
    expect(await balanceOf(topUp)).toBe(10_150_000n);
    expect((await sweep(ALICE, FEE_RECIPIENT)).ok).toBe(true);
    expect(await balanceOf(ALICE)).toBe(20_000_000n);
    expect(await balanceOf(FEE_RECIPIENT)).toBe(300_000n);
  });
});

describe("repeat sweeps and zero balances", () => {
  it("a second sweep after another deposit works and does not redeploy", async () => {
    await deposit(ALICE, 10_150_000n);
    const first = await sweep(ALICE);
    expect(first.logs.map((l) => l.eventName)).toContain("TopUpDeployed");

    await deposit(ALICE, 5_075_000n);
    const second = await sweep(ALICE);
    expect(second.ok).toBe(true);
    expect(second.result).toEqual([5_075_000n, 75_000n, 5_000_000n]);
    expect(second.logs.map((l) => l.eventName)).not.toContain("TopUpDeployed");
    expect(await balanceOf(ALICE)).toBe(15_000_000n);
    expect(await balanceOf(FEE_RECIPIENT)).toBe(225_000n);
  });

  it("sweeping a zero balance reverts with NothingToSweep and deploys nothing", async () => {
    const topUp = await topUpAddressOf(BOB);
    const r = await sweep(BOB);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("NothingToSweep");
    expect(r.errorArgs).toEqual([getAddress(BOB)]);
    expect(await chain.codeAt(topUp)).toBe("0x");

    // Also after a successful sweep has emptied it.
    await deposit(BOB, 1_015n);
    expect((await sweep(BOB)).ok).toBe(true);
    const again = await sweep(BOB);
    expect(again.ok).toBe(false);
    expect(again.error).toBe("NothingToSweep");
  });

  it("rejects the zero wallet", async () => {
    const r = await sweep("0x0000000000000000000000000000000000000000");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("ZeroAddress");
  });
});

describe("token edge cases", () => {
  it("reverts and keeps the funds in place when the token returns false", async () => {
    const topUp = await deposit(ALICE, 10_150_000n);
    await chain.call(DEPLOYER, token, tokenAbi, "setMode", [1]);
    const r = await sweep(ALICE);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("TransferFailed");
    await chain.call(DEPLOYER, token, tokenAbi, "setMode", [0]);
    expect(await balanceOf(topUp)).toBe(10_150_000n);
    expect(await balanceOf(ALICE)).toBe(0n);
  });

  it("accepts tokens that return no data", async () => {
    await deposit(ALICE, 10_150_000n);
    await chain.call(DEPLOYER, token, tokenAbi, "setMode", [2]);
    expect((await sweep(ALICE)).ok).toBe(true);
    expect(await balanceOf(ALICE)).toBe(10_000_000n);
    expect(await balanceOf(FEE_RECIPIENT)).toBe(150_000n);
  });

  it("blocks reentrancy from the token into sweep", async () => {
    const topUp = await deposit(ALICE, 10_150_000n);
    await chain.call(DEPLOYER, token, tokenAbi, "setMode", [3]);

    // Token calls factory.sweep(alice) in the middle of the payout.
    const reenterFactory = encodeFunctionData({ abi: factoryAbi, functionName: "sweep", args: [ALICE] });
    await chain.call(DEPLOYER, token, tokenAbi, "setReenter", [factory, reenterFactory]);
    expect((await sweep(ALICE)).ok).toBe(true);
    expect(await chain.read(token, tokenAbi, "reenterAttempts")).toBe(2n);
    expect(await chain.read(token, tokenAbi, "lastReenterOk")).toBe(false);
    const ret = await chain.read<`0x${string}`>(token, tokenAbi, "lastReenterReturn");
    expect(chain.decodeRevert(ret).error).toBe("Reentrancy");
    expect(await balanceOf(ALICE)).toBe(10_000_000n);
    expect(await balanceOf(FEE_RECIPIENT)).toBe(150_000n);

    // Token calls the top-up contract's sweep directly: only the factory may.
    await deposit(ALICE, 10_150_000n);
    const reenterTopUp = encodeFunctionData({ abi: topUpAbi, functionName: "sweep" });
    await chain.call(DEPLOYER, token, tokenAbi, "setReenter", [topUp, reenterTopUp]);
    expect((await sweep(ALICE)).ok).toBe(true);
    expect(chain.decodeRevert(await chain.read(token, tokenAbi, "lastReenterReturn")).error).toBe("OnlyFactory");
    expect(await balanceOf(ALICE)).toBe(20_000_000n);
    expect(await balanceOf(FEE_RECIPIENT)).toBe(300_000n);
  });

  it("only sweeps the configured token; other tokens sent by mistake stay put", async () => {
    const other = await chain.deploy("MockToken");
    const topUp = await deposit(ALICE, 10_150_000n);
    await deposit(ALICE, 5_000_000n, other);
    expect((await sweep(ALICE)).ok).toBe(true);
    expect(await balanceOf(ALICE)).toBe(10_000_000n);
    expect(await balanceOf(topUp, other)).toBe(5_000_000n);
    expect(await balanceOf(ALICE, other)).toBe(0n);
  });
});

// A tiny in-process EVM harness on @ethereumjs/vm. Calls run through `evm.runCall`, which commits state
// on success and rolls back on revert, like a mined transaction. Gas price is 0, so callers need no ETH.
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createAddressFromString } from "@ethereumjs/util";
import { createVM, type VM } from "@ethereumjs/vm";
import {
  bytesToHex,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { compileContracts, type CompiledContract } from "../scripts/compile.mjs";

export interface CallResult {
  ok: boolean;
  result: unknown;
  /** Decoded custom error name when the call reverted with a known error. */
  error?: string;
  errorArgs?: readonly unknown[];
  returnData: Hex;
  logs: { address: Address; eventName: string; args: Record<string, unknown> }[];
  gasUsed: bigint;
}

let artifactsCache: Record<string, CompiledContract> | undefined;

export class TestChain {
  private constructor(
    readonly vm: VM,
    readonly artifacts: Record<string, CompiledContract>,
    private readonly abis: Map<string, Abi>,
  ) {}

  static async create(): Promise<TestChain> {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
    const vm = await createVM({ common });
    artifactsCache ??= compileContracts({ includeTests: true });
    return new TestChain(vm, artifactsCache, new Map());
  }

  /** Every ABI we know, for decoding errors and events from any contract. */
  private allAbi(): Abi {
    return Object.values(this.artifacts).flatMap((a) => a.abi) as Abi;
  }

  async deploy(name: string, args: readonly unknown[] = [], from: Address = addr(0xde)): Promise<Address> {
    const art = this.artifacts[name];
    if (!art) throw new Error(`unknown contract ${name}`);
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args });
    const r = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
    });
    if (r.execResult.exceptionError || !r.createdAddress) {
      throw new Error(`deploy ${name} failed: ${r.execResult.exceptionError?.error} ${this.describeRevert(bytesToHex(r.execResult.returnValue))}`);
    }
    const address = getAddress(r.createdAddress.toString());
    this.abis.set(address.toLowerCase(), art.abi);
    return address;
  }

  /** Register the ABI of a contract that was deployed by another contract (e.g. via CREATE2). */
  register(address: Address, name: string): void {
    this.abis.set(address.toLowerCase(), this.artifacts[name]!.abi);
  }

  async call(
    from: Address,
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<CallResult> {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    return this.rawCall(from, to, data, { abi, functionName });
  }

  async rawCall(from: Address, to: Address, data: Hex, decode?: { abi: Abi; functionName: string }): Promise<CallResult> {
    const r = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: createAddressFromString(to),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
    });
    const returnData = bytesToHex(r.execResult.returnValue);
    const gasUsed = r.execResult.executionGasUsed;
    if (r.execResult.exceptionError) {
      const err = this.decodeRevert(returnData);
      return { ok: false, result: undefined, returnData, logs: [], gasUsed, ...err };
    }
    const result = decode
      ? decodeFunctionResult({ abi: decode.abi, functionName: decode.functionName, data: returnData } as never)
      : undefined;
    const logs = (r.execResult.logs ?? []).map(([address, topics, logData]) => {
      const a = getAddress(bytesToHex(address));
      const abi = this.abis.get(a.toLowerCase()) ?? this.allAbi();
      const ev = decodeEventLog({
        abi,
        data: bytesToHex(logData),
        topics: topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
      });
      return { address: a, eventName: String(ev.eventName), args: (ev.args ?? {}) as Record<string, unknown> };
    });
    return { ok: true, result, returnData, logs, gasUsed };
  }

  /** Read-only call: state changes are discarded. */
  async read<T = unknown>(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    await this.vm.stateManager.checkpoint();
    try {
      const r = await this.call(addr(0x01), to, abi, functionName, args);
      if (!r.ok) throw new Error(`read ${functionName} reverted: ${r.error ?? r.returnData}`);
      return r.result as T;
    } finally {
      await this.vm.stateManager.revert();
    }
  }

  async codeAt(address: Address): Promise<Hex> {
    return bytesToHex(await this.vm.stateManager.getCode(createAddressFromString(address)));
  }

  decodeRevert(data: Hex): { error?: string; errorArgs?: readonly unknown[] } {
    if (data === "0x") return {};
    try {
      const e = decodeErrorResult({ abi: this.allAbi(), data });
      return { error: e.errorName, errorArgs: e.args };
    } catch {
      return {};
    }
  }

  private describeRevert(data: Hex): string {
    const e = this.decodeRevert(data);
    return e.error ? `${e.error}(${(e.errorArgs ?? []).join(", ")})` : data;
  }
}

/** A deterministic test address: addr(0xaa) = 0x00..00aa, with a prefix so it never hits a precompile. */
export function addr(n: number): Address {
  return `0x${"be".repeat(2)}${n.toString(16).padStart(36, "0")}` as Address;
}

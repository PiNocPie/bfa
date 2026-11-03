import type { Abi, Hex } from "viem";

export interface CompiledContract {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  source: string;
}

export const COMPILER_SETTINGS: Record<string, unknown>;
export function compileContracts(opts?: { includeTests?: boolean }): Record<string, CompiledContract>;
export function solcVersion(): string;

import { describe, expect, it } from "vitest";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { treasurySigner, TreasuryRefusedError } from "./treasury.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const fields = [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] as const;

/** A fake treasury: rebuilds the digest from the structured request (as the contract does) and signs it. */
function fakeTreasury(key: Hex, opts: { refuse?: string } = {}) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    caller: {
      accountId: "alice.testnet",
      async callFunction(a: { contractId: string; methodName: string; args: Record<string, unknown> }) {
        calls.push(a as unknown as Record<string, unknown>);
        if (opts.refuse) throw new Error(`Smart contract panicked: ${opts.refuse}`);
        const r = a.args.request as Record<string, string | number>;
        const primaryType = r.kind === "transfer" ? "TransferWithAuthorization" : "ReceiveWithAuthorization";
        const digest = hashTypedData({
          domain: { name: String(r.domain_name), version: String(r.domain_version), chainId: Number(r.chain_id), verifyingContract: r.token as Hex },
          types: { [primaryType]: fields }, primaryType,
          message: { from: r.from as Hex, to: r.to as Hex, value: BigInt(r.value!), validAfter: BigInt(r.valid_after!), validBefore: BigInt(r.valid_before!), nonce: r.nonce as Hex },
        } as never);
        const sig = await sign({ hash: digest, privateKey: key });
        return { scheme: "Secp256k1", big_r: { affine_point: `02${sig.r.slice(2)}` }, s: { scalar: sig.s.slice(2) }, recovery_id: Number(sig.yParity) };
      },
    },
  };
}

function typed(from: Hex, primaryType: "TransferWithAuthorization" | "ReceiveWithAuthorization") {
  return {
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC as Hex },
    types: { [primaryType]: fields }, primaryType,
    message: { from, to: "0x11F4555ABdaa2BC5b39A172E39b69E8293ad4aA3" as Hex, value: 1000n, validAfter: 0n, validBefore: 1893456000n, nonce: `0x${"cd".repeat(32)}` as Hex },
  };
}

describe("treasury signer", () => {
  it("sends structured EIP-3009 requests and returns a signature from the vault address", async () => {
    const key = generatePrivateKey();
    const vault = privateKeyToAccount(key).address;
    const t = fakeTreasury(key);
    const signer = await treasurySigner({ caller: t.caller, treasuryId: "treasury.testnet", networkId: "testnet", mpc: { deriveEvmAddress: async (p, path) => { expect([p, path]).toEqual(["treasury.testnet", "vault/alice.testnet"]); return vault; } } });
    expect(signer.address).toBe(vault);
    for (const pt of ["TransferWithAuthorization", "ReceiveWithAuthorization"] as const) {
      const td = typed(vault, pt);
      const sig = await signer.signTypedData(td as never);
      expect(await recoverTypedDataAddress({ ...(td as never), signature: sig })).toBe(vault);
    }
    const req = (t.calls[0]!.args as { request: Record<string, unknown> }).request;
    expect(req).toMatchObject({ kind: "transfer", chain_id: 84532, value: "1000", valid_after: "0", domain_name: "USDC" });
    expect(t.calls[0]!.methodName).toBe("sign_eip3009");
  });

  it("refuses anything that is not a USDC authorization from this vault", async () => {
    const key = generatePrivateKey();
    const vault = privateKeyToAccount(key).address;
    const t = fakeTreasury(key);
    const signer = await treasurySigner({ caller: t.caller, treasuryId: "treasury.testnet", networkId: "testnet", mpc: { deriveEvmAddress: async () => vault } });
    await expect(signer.signTypedData({ ...typed(vault, "TransferWithAuthorization"), primaryType: "Permit" } as never)).rejects.toThrow(/only USDC EIP-3009/);
    await expect(signer.signTypedData(typed(privateKeyToAccount(generatePrivateKey()).address, "TransferWithAuthorization") as never)).rejects.toThrow(/not this vault/);
    expect(t.calls).toHaveLength(0);
  });

  it("turns contract policy panics into typed refusals", async () => {
    const key = generatePrivateKey();
    const vault = privateKeyToAccount(key).address;
    const t = fakeTreasury(key, { refuse: "limit_reached" });
    const signer = await treasurySigner({ caller: t.caller, treasuryId: "treasury.testnet", networkId: "testnet", mpc: { deriveEvmAddress: async () => vault } });
    const err = await signer.signTypedData(typed(vault, "TransferWithAuthorization") as never).catch((e) => e);
    expect(err).toBeInstanceOf(TreasuryRefusedError);
    expect(err.reason).toBe("limit_reached");
  });
});

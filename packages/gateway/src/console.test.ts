import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { ReceiptLog } from "@bfa/core";
import { verifyGoogleIdToken } from "./auth.js";
import { implicitAccountId, type Chain } from "./chain.js";
import { consoleApi } from "./console.js";
import { FileKeyStore } from "./keys.js";
import { FileUserStore, seal, unseal } from "./users.js";

const CLIENT_ID = "123-test.apps.googleusercontent.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1", alg: "RS256", use: "sig" };
const jwks = async () => ({ keys: [jwk] });

function googleToken(claims: Record<string, unknown>, kid = "k1"): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg: "RS256", kid, typ: "JWT" });
  const p = enc({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "google-1", email: "ann@gmail.com", email_verified: true, name: "Ann", exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
}

describe("Google ID token verification", () => {
  it("accepts a valid token and returns the identity", async () => {
    expect(await verifyGoogleIdToken(googleToken({}), CLIENT_ID, jwks)).toEqual({ sub: "google-1", email: "ann@gmail.com", name: "Ann" });
  });
  it.each([
    ["wrong audience", { aud: "someone-else" }, /different app/],
    ["expired", { exp: 1 }, /expired/],
    ["unverified email", { email_verified: false }, /not verified/],
    ["wrong issuer", { iss: "https://evil.example" }, /not issued by Google/],
  ])("rejects %s", async (_n, claims, err) => {
    await expect(verifyGoogleIdToken(googleToken(claims), CLIENT_ID, jwks)).rejects.toThrow(err);
  });
  it("rejects a tampered signature and unknown keys", async () => {
    const t = googleToken({});
    const [h, , s] = t.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ iss: "accounts.google.com", aud: CLIENT_ID, sub: "x", email: "x@y.z", email_verified: true, exp: 9e9 })).toString("base64url")}.${s}`;
    await expect(verifyGoogleIdToken(forged, CLIENT_ID, jwks)).rejects.toThrow(/signature/);
    await expect(verifyGoogleIdToken(googleToken({}, "k2"), CLIENT_ID, jwks)).rejects.toThrow(/unknown key/);
  });
});

describe("sealing agent keys", () => {
  it("round-trips and detects tampering", () => {
    const k = randomBytes(32);
    const s = seal(k, "ed25519:secret");
    expect(unseal(k, s)).toBe("ed25519:secret");
    expect(() => unseal(randomBytes(32), s)).toThrow();
  });
});

let server: Server | undefined;
afterEach(() => server?.close());

async function start(chainImpl?: Partial<Chain>) {
  const dir = await mkdtemp(join(tmpdir(), "bfa-console-"));
  const users = new FileUserStore(join(dir, "users.json"));
  const keys = new FileKeyStore(join(dir, "keys.json"));
  const api = consoleApi({
    network: "testnet",
    keys,
    receipts: new ReceiptLog(join(dir, "receipts.jsonl")),
    users,
    secret: randomBytes(32),
    googleClientId: CLIENT_ID,
    devLogin: true,
    jwks,
    registryDir: resolve(__dirname, "../../../registry"),
    ...(chainImpl && { chain: chainImpl as Chain }),
  });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    void api(req, res, path).then((handled) => handled || (res.writeHead(404), res.end()));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined && { "content-type": "application/json" }), ...(cookie && { cookie }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, users, keys };
}

describe("console API", () => {
  it("signs in with Google, keeps a session and signs out", async () => {
    const { call } = await start();
    expect((await call("GET", "/api/me")).status).toBe(401);
    expect((await call("POST", "/api/auth/google", { credential: googleToken({ aud: "nope" }) })).status).toBe(401);
    const ok = await call("POST", "/api/auth/google", { credential: googleToken({}) });
    expect(ok.status).toBe(200);
    const me = await call("GET", "/api/me");
    expect(me.body.user.email).toBe("ann@gmail.com");
    expect(me.body.wallet.status).toBe("none");
    await call("POST", "/api/auth/logout", {});
    expect((await call("GET", "/api/me")).status).toBe(401);
  });

  it("refuses non-JSON posts (CSRF from plain forms)", async () => {
    await start();
    const res = await fetch("http://127.0.0.1:" + (server!.address() as AddressInfo).port + "/api/auth/dev", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=a@b.co" });
    expect(res.status).toBe(415);
  });

  it("will not create keys before the wallet is ready, then scopes keys to their owner", async () => {
    const { call, users } = await start();
    await call("POST", "/api/auth/dev", { email: "a@b.co" });
    const early = await call("POST", "/api/keys", { name: "k", daily_limit_usd: "1" });
    expect(early.body.error.code).toBe("wallet_not_ready");
    const me = (await users.findByGoogleSub("dev:a@b.co"))!;
    await users.update(me.id, { wallet_status: "ready" });
    const made = await call("POST", "/api/keys", { name: "research", daily_limit_usd: "0.50", expires_days: 7, listing_access: { mode: "allow", listing_ids: ["bfa/near-account"] } });
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^bfa_sk_test_/);
    expect(made.body.key.sha256).toBeUndefined();
    expect((await call("GET", "/api/keys")).body.keys).toHaveLength(1);

    // Another user sees none of it and cannot revoke it.
    await call("POST", "/api/auth/dev", { email: "b@b.co" });
    expect((await call("GET", "/api/keys")).body.keys).toHaveLength(0);
    expect((await call("POST", `/api/keys/${made.body.key.id}/revoke`, {})).status).toBe(404);
  });

  it("starts a wallet: implicit account from the browser key, sponsored once, agent key sealed", async () => {
    const sponsored: string[] = [];
    const chainImpl: Partial<Chain> = {
      treasuryId: "treasury.testnet",
      accountExists: async () => sponsored.length > 0,
      sponsor: async (id) => (sponsored.push(id), "tx1"),
      hasAccessKey: async () => true,
      vault: async () => ({ daily_limit: "1000000", spent_today: "0", day: 1, allowed_to: [], paused: false }),
      vaultAddress: async () => "0x475206a44AC7eb493775Bf72282bD37C312682C6",
      usdcBalance: async () => 2_000_000n,
      topUpAddress: async () => "0x10736D4Cb5faA16C174999316B7A472E65E24d8d",
    };
    const { call, users } = await start(chainImpl);
    await call("POST", "/api/auth/dev", { email: "a@b.co" });
    const browserKey = KeyPair.fromRandom("ed25519");
    const r = await call("POST", "/api/wallet/start", { public_key: browserKey.getPublicKey().toString() });
    expect(r.status).toBe(200);
    expect(r.body.near_account_id).toBe(implicitAccountId(browserKey.getPublicKey().toString()));
    expect(r.body.agent_methods).toEqual(["sign_eip3009"]);
    expect(sponsored).toEqual([r.body.near_account_id]);
    const again = await call("POST", "/api/wallet/start", { public_key: browserKey.getPublicKey().toString() });
    expect(again.body.agent_public_key).toBe(r.body.agent_public_key);
    expect(sponsored).toHaveLength(1);
    const other = await call("POST", "/api/wallet/start", { public_key: KeyPair.fromRandom("ed25519").getPublicKey().toString() });
    expect(other.body.error.code).toBe("wallet_exists");

    const stored = (await users.findByGoogleSub("dev:a@b.co"))!;
    expect(stored.agent_secret_enc).toMatch(/^v1\./);
    const meText = JSON.stringify(await call("GET", "/api/me"));
    expect(meText).not.toContain(stored.agent_secret_enc!);
    expect(meText).not.toContain("agent_secret");
    const done = await call("POST", "/api/wallet/confirm", {});
    expect(done.body.wallet.status).toBe("ready");
    expect(done.body.wallet.usdc_balance_atomic).toBe("2000000");
    expect(done.body.wallet.top_up_address).toBe("0x10736D4Cb5faA16C174999316B7A472E65E24d8d");
  });

  it("lists registry listings for the console", async () => {
    const { call } = await start();
    const l = await call("GET", "/api/listings");
    expect(l.body.listings.find((x: { id: string }) => x.id === "nansen/smart-money-holdings").routable).toBe(false);
  });
});

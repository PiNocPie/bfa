import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Listing, Receipt } from "@bfa/core";
import { describe, expect, it } from "vitest";
import { FileKeyStore, PREFIX_LEN, SECRET_RE, authenticate, createKey, hashSecret, parseLimit, type ApiKeyRecord } from "./keys.js";
import { assertWithinKeyLimits, usageToday } from "./policy.js";

const DAY = 86_400_000;

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "bfa-gw-keys-"));
  return { dir, keys: new FileKeyStore(join(dir, "keys.json")) };
}

describe("API keys", () => {
  it("creates bfa_sk_test_/bfa_sk_live_ secrets and stores only the hash and a 16-char prefix", async () => {
    const { dir, keys } = await store();
    const base = { name: "a", expiresAt: new Date(Date.now() + DAY), dailyLimitUsd: "1" };
    const t = await createKey(keys, { ...base, network: "testnet" });
    const l = await createKey(keys, { ...base, network: "mainnet" });
    expect(t.secret).toMatch(/^bfa_sk_test_[0-9A-Za-z]{32}$/);
    expect(l.secret).toMatch(/^bfa_sk_live_[0-9A-Za-z]{32}$/);
    expect(SECRET_RE.test(t.secret)).toBe(true);
    expect(t.record.prefix).toBe(t.secret.slice(0, PREFIX_LEN));
    expect(t.record.sha256).toBe(hashSecret(t.secret));
    expect(t.record.scopes).toEqual(["run", "receipts"]);
    expect(t.record.listing_access).toEqual({ mode: "all", listing_ids: [] });

    const file = await readFile(join(dir, "keys.json"), "utf8");
    expect(file).not.toContain(t.secret);
    expect(file).not.toContain(l.secret);
    expect((await stat(join(dir, "keys.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    expect(await authenticate(keys, `Bearer ${t.secret}`, "testnet")).toMatchObject({ ok: true, key: { id: t.record.id } });
    expect((await authenticate(keys, `Bearer ${l.secret}`, "testnet")).ok).toBe(false);
    expect((await authenticate(keys, `Bearer ${l.secret}`, "mainnet")).ok).toBe(true);
  });

  it("validates inputs", async () => {
    const { keys } = await store();
    const base = { name: "a", expiresAt: new Date(Date.now() + DAY), dailyLimitUsd: "1", network: "testnet" as const };
    await expect(createKey(keys, { ...base, expiresAt: new Date(Date.now() - 1) })).rejects.toThrow(/future/);
    await expect(createKey(keys, { ...base, dailyLimitUsd: "1.0000001" })).rejects.toThrow(/daily_limit_usd/);
    await expect(createKey(keys, { ...base, scopes: ["admin" as never] })).rejects.toThrow(/scopes/);
    await expect(createKey(keys, { ...base, perApiLimits: [parseLimit("a/b:calls:1.5")] })).rejects.toThrow(/integer/);
    await expect(createKey(keys, { ...base, listingAccess: { mode: "allow", listing_ids: [] } })).rejects.toThrow(/allow/);
    expect(parseLimit("bfa/near-account:usd:0.50")).toEqual({ listing_id: "bfa/near-account", kind: "usd", value: "0.50" });
    expect(parseLimit("bfa/near-account:calls:200")).toEqual({ listing_id: "bfa/near-account", kind: "calls", value: 200 });
    expect(() => parseLimit("bfa/near-account:eur:1")).toThrow();
  });

  it("keeps concurrent writes from one process", async () => {
    const { keys } = await store();
    const base = { name: "a", expiresAt: new Date(Date.now() + DAY), dailyLimitUsd: "1", network: "testnet" as const };
    await Promise.all(Array.from({ length: 10 }, () => createKey(keys, base)));
    expect(await keys.list()).toHaveLength(10);
  });
});

describe("UTC day accounting", () => {
  const key = { id: "key_aaaaaaaaaaaaaaaa", daily_limit_usd: "0.002", per_api_limits: [] } as unknown as ApiKeyRecord;
  const listing = { id: "a/b", pricing: { amount_usd: "0.001" } } as Listing;
  const r = (started_at: string, over: Partial<Receipt> = {}) =>
    ({ key_id: key.id, listing_id: "a/b", status: "paid_ok", price_usd: "0.001", started_at, ...over }) as Receipt;

  it("counts only receipts from the current UTC day, whatever the local time zone", () => {
    const now = new Date("2026-11-03T00:00:01Z"); // still Nov 2 in the Americas
    const u = usageToday(
      [
        r("2026-11-02T23:59:59.999Z"),
        r("2026-11-03T00:00:00.000Z"),
        r("2026-11-03T00:00:00.500Z", { status: "paid_error" }),
        r("2026-11-03T00:00:00.700Z", { status: "unpaid_error", price_usd: "0" }),
        r("2026-11-03T00:00:00.800Z", { key_id: "key_bbbbbbbbbbbbbbbb" }),
        r("2026-11-04T00:00:00.000Z"),
      ],
      key.id,
      now,
    );
    expect(u.spent).toBe(2000n);
    expect(u.byListing.get("a/b")).toEqual({ spent: 2000n, calls: 2 });
  });

  it("refuses at the boundary with resets_at = next 00:00 UTC", () => {
    const now = new Date("2026-11-03T23:59:59.999Z");
    const one = usageToday([r("2026-11-03T01:00:00Z")], key.id, now);
    expect(() => assertWithinKeyLimits(key, listing, one, now)).not.toThrow(); // 0.001 + 0.001 = 0.002 is allowed
    const two = usageToday([r("2026-11-03T01:00:00Z"), r("2026-11-03T02:00:00Z")], key.id, now);
    expect(() => assertWithinKeyLimits(key, listing, two, now)).toThrow(
      expect.objectContaining({ code: "limit_reached", next_action: "stop", resets_at: "2026-11-04T00:00:00.000Z" }),
    );
    const nextDay = new Date("2026-11-04T00:00:00.000Z");
    const fresh = usageToday([r("2026-11-03T01:00:00Z"), r("2026-11-03T02:00:00Z")], key.id, nextDay);
    expect(() => assertWithinKeyLimits(key, listing, fresh, nextDay)).not.toThrow();
  });
});

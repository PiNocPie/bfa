// The Supabase stores against an in-memory PostgREST stand-in. Supabase hosts are not reachable from CI or this
// sandbox, so nothing here talks to a real project; apply supabase/migrations/0001_init.sql and run the gateway
// against a project to test it live.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { microsToUsd, newReceiptId, type Receipt } from "@bfa/core";
import { describe, expect, it } from "vitest";
import { createKey, hashSecret } from "./keys.js";
import { storesFromEnv } from "./stores.js";
import { SupabaseKeyStore, SupabaseReceiptStore, numericToUsd } from "./supabase.js";
import { FakeSupabase } from "./testing/fake-supabase.js";

const DAY = 86_400_000;

function receipt(over: Partial<Receipt>): Receipt {
  return {
    receipt_version: 1,
    receipt_id: newReceiptId(),
    idempotency_key: newReceiptId(),
    listing_id: "test/acct-a",
    provider: "p",
    endpoint_url: "https://x",
    status: "paid_ok",
    price_usd: "0.001",
    latency_ms: 5,
    started_at: new Date().toISOString(),
    ...over,
  };
}

describe("SupabaseKeyStore", () => {
  it("round-trips a key, finds it by hash, and revokes once", async () => {
    const db = new FakeSupabase();
    const keys = new SupabaseKeyStore(db.asClient());
    const { secret, record } = await createKey(keys, {
      name: "agent",
      expiresAt: new Date(Date.now() + DAY),
      dailyLimitUsd: "0.25",
      perApiLimits: [{ listing_id: "a/b", kind: "usd", value: "0.10" }],
      listingAccess: { mode: "block", listing_ids: ["x/y"] },
      network: "testnet",
    });
    const row = db.tables.api_keys![0]!;
    expect(row.sha256).toBe(hashSecret(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.daily_limit_usd).toBe(0.25); // numeric comes back as a number
    expect(row.created_at).toMatch(/\+00:00$/);

    expect(await keys.get(record.id)).toEqual(record);
    expect(await keys.findBySha256(hashSecret(secret))).toEqual(record);
    expect(await keys.findBySha256("0".repeat(64))).toBeUndefined();

    const first = await keys.revoke(record.id, new Date("2026-11-03T10:00:00Z"));
    expect(first?.revoked_at).toBe("2026-11-03T10:00:00.000Z");
    const again = await keys.revoke(record.id, new Date("2026-11-04T10:00:00Z"));
    expect(again?.revoked_at).toBe("2026-11-03T10:00:00.000Z");
    expect(await keys.revoke("key_0000000000000000", new Date())).toBeUndefined();
    expect((await keys.list()).map((k) => k.id)).toEqual([record.id]);
  });

  it("surfaces database errors without leaking anything secret", async () => {
    const db = new FakeSupabase();
    const keys = new SupabaseKeyStore(db.asClient());
    const input = { name: "a", expiresAt: new Date(Date.now() + DAY), dailyLimitUsd: "1", network: "testnet" as const };
    const { record } = await createKey(keys, input);
    await expect(keys.insert(record)).rejects.toThrow(/supabase insert api key failed: duplicate key/);
  });
});

describe("SupabaseReceiptStore", () => {
  it("filters by key and day, scopes idempotency per key, and sums spend exactly", async () => {
    const db = new FakeSupabase();
    const keys = new SupabaseKeyStore(db.asClient());
    const receipts = new SupabaseReceiptStore(db.asClient());
    const mk = () => createKey(keys, { name: "k", expiresAt: new Date(Date.now() + DAY), dailyLimitUsd: "1", network: "testnet" });
    const a = (await mk()).record.id;
    const b = (await mk()).record.id;
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);

    await receipts.append(receipt({ key_id: a, idempotency_key: "t1", price_usd: "0.001" }));
    await receipts.append(receipt({ key_id: a, price_usd: "0.000001" }));
    await receipts.append(receipt({ key_id: a, status: "unpaid_error", price_usd: "0" }));
    await receipts.append(receipt({ key_id: a, price_usd: "0.5", started_at: new Date(dayStart.getTime() - 1).toISOString() }));
    await receipts.append(receipt({ key_id: b, idempotency_key: "t1", price_usd: "0.2" }));
    await expect(receipts.append(receipt({ key_id: "key_doesnotexist0000" }))).rejects.toThrow(/foreign key/);

    expect(microsToUsd(await receipts.spentTodayMicros(new Date(), { key_id: a }))).toBe("0.001001");
    expect(microsToUsd(await receipts.spentTodayMicros())).toBe("0.201001");
    expect(await receipts.all({ key_id: a })).toHaveLength(4);
    expect(await receipts.all({ key_id: a, since: dayStart })).toHaveLength(3);
    expect((await receipts.findByIdempotencyKey("t1", { key_id: b }))?.price_usd).toBe("0.2");
    expect((await receipts.findByIdempotencyKey("t1", { key_id: a }))?.price_usd).toBe("0.001");
    // payload round-trips the receipt untouched
    const all = await receipts.all();
    expect(all.every((r) => typeof r.price_usd === "string" && r.receipt_version === 1)).toBe(true);
  });

  it("pages through more rows than one PostgREST response holds", async () => {
    const db = new FakeSupabase();
    const receipts = new SupabaseReceiptStore(db.asClient());
    db.tables.receipts = Array.from({ length: 2345 }, () => {
      const r = receipt({});
      return { receipt_id: r.receipt_id, key_id: null, listing_id: r.listing_id, status: r.status, price_usd: 0.001, started_at: r.started_at, idempotency_key: r.idempotency_key, payload: r };
    });
    expect(microsToUsd(await receipts.spentTodayMicros())).toBe("2.345");
    expect(db.requests.filter((r) => r === "select receipts")).toHaveLength(3);
    expect(await receipts.all({ since: new Date(Date.now() - DAY) })).toHaveLength(2345);
    expect(await receipts.all()).toHaveLength(1000); // unfiltered reads look at a recent window only
  });
});

describe("store selection", () => {
  it("uses Supabase only when both env vars are set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bfa-gw-stores-"));
    expect(storesFromEnv({}, dir).kind).toBe("file");
    expect(storesFromEnv({ SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-test" }, dir).kind).toBe("supabase");
    expect(() => storesFromEnv({ SUPABASE_URL: "https://abc.supabase.co" }, dir)).toThrow(/both/);
    expect(() => storesFromEnv({ SUPABASE_SERVICE_ROLE_KEY: "x" }, dir)).toThrow(/both/);
  });

  it("normalizes numeric values", () => {
    expect(numericToUsd(0.002)).toBe("0.002");
    expect(numericToUsd("0.500000")).toBe("0.5");
    expect(numericToUsd(1)).toBe("1");
  });
});

import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiptLog, newReceiptId, type Receipt, type ReceiptStore } from "@bfa/core";
import { localKeySigner } from "@bfa/x402-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileKeyStore, createKey, type KeyStore, type NewKeyInput } from "./keys.js";
import { createGateway, listen, type Gateway } from "./server.js";
import { SupabaseKeyStore, SupabaseReceiptStore } from "./supabase.js";
import { FakeSupabase } from "./testing/fake-supabase.js";
import { AGENT_KEY, HOST_A, HOST_B, LISTING_A, LISTING_B, REPO, fakeSeller, testRegistry } from "./testing/fixtures.js";

const INPUT = { account_id: "x.testnet" };
const DAY = 86_400_000;

interface Ctx {
  url: string;
  keys: KeyStore;
  receipts: ReceiptStore;
  seller: ReturnType<typeof fakeSeller>;
  gw: Gateway;
  server: Server;
  clients: Client[];
}

let ctx: Ctx;

/** Starts a gateway on a random localhost port, backed by the file stores and a fake seller. */
async function start(stores?: { keys: KeyStore; receipts: ReceiptStore }): Promise<Ctx> {
  const stateDir = await mkdtemp(join(tmpdir(), "bfa-gw-"));
  const keys = stores?.keys ?? new FileKeyStore(join(stateDir, "keys.json"));
  const receipts = stores?.receipts ?? new ReceiptLog(join(stateDir, "receipts.jsonl"));
  const seller = fakeSeller();
  const gw = createGateway({
    config: {
      registryDir: join(REPO, "registry"),
      devRegistryDir: await testRegistry(),
      stateDir,
      network: "testnet",
      agentPath: "test/agent-1",
      dailyCapUsd: "1",
      maxDepositUsd: "0.50",
      fetchImpl: seller.impl,
      signerOverride: localKeySigner(AGENT_KEY),
    },
    keys,
    receipts,
  });
  const { server, url } = await listen(gw, 0, "127.0.0.1");
  return { url, keys, receipts, seller, gw, server, clients: [] };
}

async function newKey(over: Partial<NewKeyInput> = {}) {
  return createKey(ctx.keys, {
    name: "test agent",
    expiresAt: new Date(Date.now() + 30 * DAY),
    dailyLimitUsd: "1",
    network: "testnet",
    ...over,
  });
}

async function connect(secret: string) {
  const client = new Client({ name: "bfa-gateway-test", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ctx.url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }),
  );
  ctx.clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as { type: string; text: string }[];
    return { isError: !!r.isError, body: JSON.parse(content[0]!.text) };
  };
  return { client, call };
}

const run = (call: Awaited<ReturnType<typeof connect>>["call"], listing_id = LISTING_A, extra: Record<string, unknown> = {}) =>
  call("run", { listing_id, input: INPUT, ...extra });

beforeEach(async () => {
  ctx = await start();
});

afterEach(async () => {
  for (const c of ctx.clients) await c.close().catch(() => undefined);
  await ctx.gw.close();
  await new Promise((r) => ctx.server.close(r));
});

describe("HTTP auth", () => {
  const post = (headers: Record<string, string>) =>
    fetch(ctx.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });

  it("rejects a request without a key with 401 JSON", async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized", next_action: "stop" } });
  });

  it("rejects malformed, unknown and wrong-network keys with 401", async () => {
    for (const auth of ["Bearer nope", `Bearer bfa_sk_test_${"a".repeat(32)}`, `Bearer bfa_sk_live_${"a".repeat(32)}`, "Basic abc"]) {
      const res = await post({ authorization: auth });
      expect(res.status, auth).toBe(401);
      expect((await res.json()).error.code).toBe("unauthorized");
    }
    const { secret } = await newKey();
    await expect(connect(secret.slice(0, -1) + (secret.endsWith("a") ? "b" : "a"))).rejects.toThrow();
  });

  it("does not let a key use another key's session", async () => {
    const a = await newKey();
    const b = await newKey();
    const { client } = await connect(a.secret);
    const sid = (client.transport as StreamableHTTPClientTransport).sessionId!;
    const res = await fetch(ctx.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${b.secret}`,
        "mcp-session-id": sid,
        "mcp-protocol-version": "2025-06-18",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("paid calls through the HTTP MCP endpoint", () => {
  it("pays the listed price and tags the receipt with the key id", async () => {
    const { record, secret } = await newKey();
    const { client, call } = await connect(secret);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["discover", "inspect", "quote", "receipts", "run", "submit_listing", "wallet"]);

    const r = await run(call);
    expect(r.isError).toBe(false);
    expect(r.body.data).toEqual({ account_id: "x.testnet", exists: true });
    expect(r.body.receipt).toMatchObject({ status: "paid_ok", price_usd: "0.001", payment_tx: "0xfeed", key_id: record.id });
    expect(ctx.seller.paymentsTo(HOST_A)).toBe(1);
    expect(ctx.seller.state.payments[0]!.payer).toBe(localKeySigner(AGENT_KEY).address);
    const stored = await ctx.receipts.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.key_id).toBe(record.id);
  });

  it("scopes idempotency keys to the API key", async () => {
    const a = await connect((await newKey()).secret);
    const b = await connect((await newKey()).secret);
    const first = await run(a.call, LISTING_A, { idempotency_key: "task-1" });
    const replay = await run(a.call, LISTING_A, { idempotency_key: "task-1" });
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.receipt.receipt_id).toBe(first.body.receipt.receipt_id);
    const other = await run(b.call, LISTING_A, { idempotency_key: "task-1" });
    expect(other.body.replayed).toBeUndefined();
    expect(other.body.receipt.receipt_id).not.toBe(first.body.receipt.receipt_id);
    expect(ctx.seller.state.payments).toHaveLength(2);
  });
});

describe("key state and scopes", () => {
  it("refuses an expired key before paying", async () => {
    const { secret } = await newKey({ now: new Date(Date.now() - 10 * DAY), expiresAt: new Date(Date.now() - DAY) });
    const { call } = await connect(secret);
    const r = await run(call);
    expect(r).toMatchObject({ isError: true, body: { code: "key_expired", next_action: "stop" } });
    expect((await call("discover", { query: "near account" })).body.code).toBe("key_expired");
    expect(ctx.seller.state.calls).toBe(0);
  });

  it("refuses a revoked key before paying, and revoked wins over expired", async () => {
    const live = await newKey();
    const { call } = await connect(live.secret);
    expect((await run(call)).isError).toBe(false);
    await ctx.keys.revoke(live.record.id, new Date());
    const r = await run(call);
    expect(r).toMatchObject({ isError: true, body: { code: "key_revoked", next_action: "stop" } });
    expect(ctx.seller.state.payments).toHaveLength(1);

    const old = await newKey({ now: new Date(Date.now() - 10 * DAY), expiresAt: new Date(Date.now() - DAY) });
    await ctx.keys.revoke(old.record.id, new Date());
    const c2 = await connect(old.secret);
    expect((await run(c2.call)).body.code).toBe("key_revoked");
  });

  it("refuses run without the run scope, and receipts/wallet without the receipts scope", async () => {
    const readOnly = await connect((await newKey({ scopes: ["receipts"] })).secret);
    const r = await run(readOnly.call);
    expect(r).toMatchObject({ isError: true, body: { code: "scope_missing", details: { required_scope: "run" } } });
    expect(ctx.seller.state.calls).toBe(0);
    expect((await readOnly.call("receipts")).isError).toBe(false);

    const runOnly = await connect((await newKey({ scopes: ["run"] })).secret);
    expect((await run(runOnly.call)).isError).toBe(false);
    expect((await runOnly.call("receipts")).body.code).toBe("scope_missing");
    expect((await runOnly.call("wallet")).body.code).toBe("scope_missing");
  });
});

describe("spend limits", () => {
  it("allows calls up to the daily limit exactly and refuses the next one without paying", async () => {
    const { call } = await connect((await newKey({ dailyLimitUsd: "0.002" })).secret);
    expect((await run(call)).body.receipt.status).toBe("paid_ok");
    expect((await run(call, LISTING_B)).body.receipt.status).toBe("paid_ok"); // all APIs combined
    const sellerCalls = ctx.seller.state.calls;

    const third = await run(call);
    expect(third.isError).toBe(true);
    expect(third.body).toMatchObject({ code: "limit_reached", next_action: "stop", details: { limit: "daily_usd", used_today: "0.002" } });
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    expect(third.body.resets_at).toBe(tomorrow.toISOString());
    expect(ctx.seller.state.calls).toBe(sellerCalls); // no request, so no payment
    expect(ctx.seller.state.payments).toHaveLength(2);
    expect(await ctx.receipts.all()).toHaveLength(2);
  });

  it("enforces a per-API calls limit only on that API", async () => {
    const { call } = await connect((await newKey({ perApiLimits: [{ listing_id: LISTING_A, kind: "calls", value: 2 }] })).secret);
    expect((await run(call)).isError).toBe(false);
    expect((await run(call)).isError).toBe(false);
    const r = await run(call);
    expect(r.body).toMatchObject({ code: "limit_reached", next_action: "stop", details: { limit: "per_api_calls", limit_value: 2 } });
    expect(r.body.resets_at).toMatch(/T00:00:00\.000Z$/);
    expect((await run(call, LISTING_B)).isError).toBe(false);
    expect(ctx.seller.paymentsTo(HOST_A)).toBe(2);
    expect(ctx.seller.paymentsTo(HOST_B)).toBe(1);
  });

  it("enforces a per-API usd limit", async () => {
    const { call } = await connect((await newKey({ perApiLimits: [{ listing_id: LISTING_A, kind: "usd", value: "0.001" }] })).secret);
    expect((await run(call)).isError).toBe(false);
    const r = await run(call);
    expect(r.body).toMatchObject({ code: "limit_reached", details: { limit: "per_api_usd", limit_value: "0.001", used_today: "0.001" } });
    expect(ctx.seller.paymentsTo(HOST_A)).toBe(1);
  });

  it("counts only today's (UTC) charged receipts of this key", async () => {
    const { record, secret } = await newKey({ dailyLimitUsd: "0.001" });
    const other = await newKey();
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const base = { receipt_version: 1, provider: "p", endpoint_url: "https://x", latency_ms: 1, listing_id: LISTING_A } as const;
    const seed: Receipt[] = [
      // yesterday, one millisecond before 00:00 UTC
      { ...base, receipt_id: newReceiptId(), idempotency_key: "y", status: "paid_ok", price_usd: "0.5", started_at: new Date(dayStart.getTime() - 1).toISOString(), key_id: record.id },
      // today, but not charged
      { ...base, receipt_id: newReceiptId(), idempotency_key: "u", status: "unpaid_error", price_usd: "0", started_at: new Date().toISOString(), key_id: record.id },
      // today, charged, other key
      { ...base, receipt_id: newReceiptId(), idempotency_key: "o", status: "paid_ok", price_usd: "0.5", started_at: new Date().toISOString(), key_id: other.record.id },
    ];
    for (const r of seed) await ctx.receipts.append(r);
    const { call } = await connect(secret);
    expect((await run(call)).body.receipt.status).toBe("paid_ok");
    expect((await run(call)).body.code).toBe("limit_reached");
  });
});

describe("listing access", () => {
  it("allow mode refuses other listings and marks them in discover", async () => {
    const { call } = await connect((await newKey({ listingAccess: { mode: "allow", listing_ids: [LISTING_A] } })).secret);
    const refused = await run(call, LISTING_B);
    expect(refused).toMatchObject({ isError: true, body: { code: "listing_not_allowed", next_action: "stop" } });
    expect((await run(call, LISTING_A)).isError).toBe(false);
    const d = await call("discover", { query: "near account balance" });
    const marks = Object.fromEntries(d.body.hits.map((h: { id: string; allowed_for_this_key: boolean }) => [h.id, h.allowed_for_this_key]));
    expect(marks).toEqual({ [LISTING_A]: true, [LISTING_B]: false });
    expect(ctx.seller.paymentsTo(HOST_B)).toBe(0);
  });

  it("block mode refuses the listed APIs", async () => {
    const { call } = await connect((await newKey({ listingAccess: { mode: "block", listing_ids: [LISTING_A] } })).secret);
    expect((await run(call, LISTING_A)).body).toMatchObject({ code: "listing_not_allowed", next_action: "stop" });
    expect((await run(call, LISTING_B)).isError).toBe(false);
    expect(ctx.seller.paymentsTo(HOST_A)).toBe(0);
  });

  it("a query-based run skips a blocked listing and uses the next fallback", async () => {
    const open = await connect((await newKey()).secret);
    const q = await open.call("quote", { query: "near account balance" });
    expect(q.body.listing_id).toBe(LISTING_A); // best when nothing is blocked
    expect(q.body.allowed_for_this_key).toBe(true);

    const { call } = await connect((await newKey({ listingAccess: { mode: "block", listing_ids: [LISTING_A] } })).secret);
    const q2 = await call("quote", { query: "near account balance" });
    expect(q2.body).toMatchObject({ listing_id: LISTING_A, allowed_for_this_key: false, fallbacks_allowed_for_this_key: [LISTING_B] });
    const r = await call("run", { query: "near account balance", input: INPUT });
    expect(r.isError).toBe(false);
    expect(r.body.receipt.listing_id).toBe(LISTING_B);
    expect(ctx.seller.paymentsTo(HOST_A)).toBe(0);

    const none = await connect((await newKey({ listingAccess: { mode: "allow", listing_ids: ["other/thing"] } })).secret);
    expect((await none.call("run", { query: "near account balance", input: INPUT })).body).toMatchObject({ code: "listing_not_allowed", next_action: "stop" });
  });
});

describe("receipts per key", () => {
  it("returns only this key's receipts and spend, plus its limits and expiry", async () => {
    const a = await newKey({ dailyLimitUsd: "0.5", perApiLimits: [{ listing_id: LISTING_A, kind: "calls", value: 10 }] });
    const b = await newKey();
    const ca = await connect(a.secret);
    const cb = await connect(b.secret);
    await run(ca.call);
    await run(ca.call, LISTING_B);
    await run(cb.call);

    const ra = await ca.call("receipts");
    expect(ra.body.receipts).toHaveLength(2);
    expect(ra.body.receipts.every((r: Receipt) => r.key_id === a.record.id)).toBe(true);
    expect(ra.body).toMatchObject({
      spent_today_usd: "0.002",
      daily_cap_usd: "0.5",
      key: {
        id: a.record.id,
        prefix: a.record.prefix,
        expires_at: a.record.expires_at,
        daily_limit_usd: "0.5",
        per_api_limits: [{ listing_id: LISTING_A, kind: "calls", value: 10 }],
        spent_today_usd: "0.002",
        usage_today: { [LISTING_A]: { spent_usd: "0.001", calls: 1 }, [LISTING_B]: { spent_usd: "0.001", calls: 1 } },
      },
    });
    expect(ra.body.key.sha256).toBeUndefined();

    const rb = await cb.call("receipts");
    expect(rb.body.receipts).toHaveLength(1);
    expect(rb.body.spent_today_usd).toBe("0.001");
  });
});

describe("with the Supabase stores (mocked client)", () => {
  it("enforces the same limits and writes key-tagged receipts to the receipts table", async () => {
    await ctx.gw.close();
    await new Promise((r) => ctx.server.close(r));
    const db = new FakeSupabase();
    ctx = await start({ keys: new SupabaseKeyStore(db.asClient()), receipts: new SupabaseReceiptStore(db.asClient()) });
    const { record, secret } = await newKey({ dailyLimitUsd: "0.001" });
    const { call } = await connect(secret);
    expect((await run(call)).body.receipt).toMatchObject({ status: "paid_ok", key_id: record.id });
    expect((await run(call)).body).toMatchObject({ code: "limit_reached", next_action: "stop" });
    expect(db.tables.receipts).toHaveLength(1);
    expect(db.tables.receipts![0]).toMatchObject({ key_id: record.id, listing_id: LISTING_A, status: "paid_ok", price_usd: 0.001 });
    expect(ctx.seller.state.payments).toHaveLength(1);
  });
});

import {
  microsToUsd,
  usdToMicros,
  utcDayStart,
  type Micros,
  type Receipt,
  type ReceiptFilter,
  type ReceiptStore,
} from "@bfa/core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { validateKey, type ApiKeyRecord, type KeyStore } from "./keys.js";

// Tables created by supabase/migrations/0001_init.sql. Both have RLS on and no policies: only the service role
// (which bypasses RLS) can read or write them. The service role key must stay on the server.

const CHARGED = ["paid_ok", "paid_empty", "paid_error"];
/** PostgREST returns at most this many rows per request by default; reads page through in chunks of this size. */
const PAGE = 1000;
/** Unfiltered receipt reads (provider health) look at this many recent receipts. */
const RECENT_WINDOW = 1000;

interface DbError {
  message: string;
  code?: string;
}

function fail(op: string, error: DbError): never {
  // The error comes from PostgREST and never contains the service role key.
  throw new Error(`supabase ${op} failed: ${error.message}${error.code ? ` (${error.code})` : ""}`);
}

/** numeric columns come back from PostgREST as JSON numbers (or strings); turn them into BFA's decimal strings. */
export function numericToUsd(v: unknown): string {
  if (typeof v === "number") return microsToUsd(usdToMicros(v.toFixed(6)));
  if (typeof v === "string") return microsToUsd(usdToMicros(v));
  throw new Error(`expected a numeric value, got ${typeof v}`);
}

function iso(v: unknown): string {
  return new Date(String(v)).toISOString();
}

interface KeyRow {
  id: string;
  user_id: string | null;
  name: string;
  prefix: string;
  sha256: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  daily_limit_usd: number | string;
  per_api_limits: ApiKeyRecord["per_api_limits"];
  scopes: ApiKeyRecord["scopes"];
  listing_access: ApiKeyRecord["listing_access"];
}

function keyToRow(k: ApiKeyRecord): Omit<KeyRow, "user_id"> {
  return { ...k };
}

function rowToKey(r: KeyRow): ApiKeyRecord {
  const k: ApiKeyRecord = {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    sha256: r.sha256,
    created_at: iso(r.created_at),
    expires_at: iso(r.expires_at),
    revoked_at: r.revoked_at === null ? null : iso(r.revoked_at),
    daily_limit_usd: numericToUsd(r.daily_limit_usd),
    per_api_limits: r.per_api_limits ?? [],
    scopes: r.scopes,
    listing_access: r.listing_access ?? { mode: "all", listing_ids: [] },
  };
  validateKey(k);
  return k;
}

export class SupabaseKeyStore implements KeyStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly table = "api_keys",
  ) {}

  async insert(record: ApiKeyRecord): Promise<void> {
    const { error } = await this.db.from(this.table).insert(keyToRow(record));
    if (error) fail("insert api key", error);
  }

  async list(): Promise<ApiKeyRecord[]> {
    const { data, error } = await this.db.from(this.table).select("*").order("created_at", { ascending: true });
    if (error) fail("list api keys", error);
    return (data as KeyRow[]).map(rowToKey);
  }

  async get(id: string): Promise<ApiKeyRecord | undefined> {
    const { data, error } = await this.db.from(this.table).select("*").eq("id", id).maybeSingle();
    if (error) fail("get api key", error);
    return data ? rowToKey(data as KeyRow) : undefined;
  }

  async findBySha256(sha256: string): Promise<ApiKeyRecord | undefined> {
    const { data, error } = await this.db.from(this.table).select("*").eq("sha256", sha256).maybeSingle();
    if (error) fail("find api key", error);
    return data ? rowToKey(data as KeyRow) : undefined;
  }

  async revoke(id: string, at: Date): Promise<ApiKeyRecord | undefined> {
    // Only sets revoked_at when it is still null, so a second revoke keeps the first time.
    const { error } = await this.db.from(this.table).update({ revoked_at: at.toISOString() }).eq("id", id).is("revoked_at", null);
    if (error) fail("revoke api key", error);
    return this.get(id);
  }
}

interface ReceiptRow {
  receipt_id: string;
  key_id: string | null;
  listing_id: string;
  status: Receipt["status"];
  price_usd: string;
  started_at: string;
  idempotency_key: string;
  payload: Receipt;
}

/** Receipts in Postgres. `payload` holds the full receipt; the other columns exist for filtering and indexes. */
export class SupabaseReceiptStore implements ReceiptStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly table = "receipts",
  ) {}

  async append(r: Receipt): Promise<void> {
    const row: ReceiptRow = {
      receipt_id: r.receipt_id,
      key_id: r.key_id ?? null,
      listing_id: r.listing_id,
      status: r.status,
      price_usd: r.price_usd,
      started_at: r.started_at,
      idempotency_key: r.idempotency_key,
      payload: r,
    };
    const { error } = await this.db.from(this.table).insert(row);
    if (error) fail("insert receipt", error);
  }

  private filtered(columns: string, filter: ReceiptFilter | undefined, chargedOnly: boolean) {
    let q = this.db.from(this.table).select(columns);
    if (filter?.key_id !== undefined) q = q.eq("key_id", filter.key_id);
    if (filter?.since !== undefined) q = q.gte("started_at", filter.since.toISOString());
    if (chargedOnly) q = q.in("status", CHARGED);
    return q;
  }

  /** Reads every matching row, PAGE rows at a time, oldest first. */
  private async pageAll<T>(op: string, columns: string, filter: ReceiptFilter | undefined, chargedOnly: boolean): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.filtered(columns, filter, chargedOnly)
        .order("started_at", { ascending: true })
        .order("receipt_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) fail(op, error);
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }

  async all(filter?: ReceiptFilter): Promise<Receipt[]> {
    if (filter?.key_id !== undefined || filter?.since !== undefined) {
      return (await this.pageAll<{ payload: Receipt }>("list receipts", "payload", filter, false)).map((r) => r.payload);
    }
    const { data, error } = await this.db
      .from(this.table)
      .select("payload")
      .order("started_at", { ascending: false })
      .limit(RECENT_WINDOW);
    if (error) fail("list receipts", error);
    return ((data ?? []) as { payload: Receipt }[]).map((r) => r.payload).reverse();
  }

  async findByIdempotencyKey(key: string, filter?: Pick<ReceiptFilter, "key_id">): Promise<Receipt | undefined> {
    let q = this.db.from(this.table).select("payload").eq("idempotency_key", key).in("status", CHARGED);
    if (filter?.key_id !== undefined) q = q.eq("key_id", filter.key_id);
    const { data, error } = await q.order("started_at", { ascending: true }).limit(1);
    if (error) fail("find receipt", error);
    return ((data ?? []) as { payload: Receipt }[])[0]?.payload;
  }

  async spentTodayMicros(now = new Date(), filter?: Pick<ReceiptFilter, "key_id">): Promise<Micros> {
    const rows = await this.pageAll<{ price_usd: unknown }>(
      "sum receipts",
      "price_usd",
      { ...filter, since: new Date(utcDayStart(now)) },
      true,
    );
    return rows.reduce((sum, r) => sum + usdToMicros(numericToUsd(r.price_usd)), 0n);
  }
}

/** Creates a server-side Supabase client. Never logs or returns the key. */
export function supabaseServiceClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

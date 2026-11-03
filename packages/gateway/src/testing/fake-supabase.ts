// Test-only: an in-memory stand-in for the slice of supabase-js the gateway uses (from/select/insert/update with
// eq/is/in/gte/order/limit/range/maybeSingle). It behaves like PostgREST over the 0001_init.sql schema where it
// matters: numeric columns come back as JSON numbers, timestamptz as "+00:00" strings, unique and foreign keys hold.
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null };

const NUMERIC: Record<string, string[]> = { api_keys: ["daily_limit_usd"], receipts: ["price_usd"] };
const TIMESTAMPS: Record<string, string[]> = { api_keys: ["created_at", "expires_at", "revoked_at"], receipts: ["started_at"] };
const UNIQUE: Record<string, string[]> = { api_keys: ["id", "sha256"], receipts: ["receipt_id"] };

function pgTimestamp(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  return new Date(String(v)).toISOString().replace("Z", "+00:00");
}

function toDb(table: string, row: Row): Row {
  const out: Row = { ...row };
  for (const c of NUMERIC[table] ?? []) if (c in out) out[c] = Number(out[c]);
  for (const c of TIMESTAMPS[table] ?? []) if (c in out) out[c] = pgTimestamp(out[c]);
  return structuredClone(out);
}

function compare(a: unknown, b: unknown): number {
  const ta = typeof a === "string" ? Date.parse(a) : NaN;
  const tb = typeof b === "string" ? Date.parse(b) : NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" = "select";
  private cols = "*";
  private payload: Row | Row[] | undefined;
  private filters: ((r: Row) => boolean)[] = [];
  private orders: [string, boolean][] = [];
  private max: number | undefined;
  private window: [number, number] | undefined;
  private single = false;

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select(cols = "*") {
    this.cols = cols;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = rows;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  is(c: string, v: null) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => compare(r[c], v) >= 0);
    return this;
  }
  order(c: string, o: { ascending: boolean }) {
    this.orders.push([c, o.ascending]);
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  range(from: number, to: number) {
    this.window = [from, to];
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, err?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve().then(() => this.exec()).then(ok, err);
  }

  private exec(): Result {
    this.db.requests.push(`${this.op} ${this.table}`);
    const rows = (this.db.tables[this.table] ??= []);
    if (this.op === "insert") {
      for (const raw of [this.payload as Row | Row[]].flat()) {
        const row = toDb(this.table, raw);
        for (const c of UNIQUE[this.table] ?? []) {
          if (rows.some((r) => r[c] === row[c])) return { data: null, error: { message: `duplicate key value violates unique constraint on ${c}`, code: "23505" } };
        }
        if (this.table === "receipts" && row.key_id != null && !(this.db.tables.api_keys ?? []).some((k) => k.id === row.key_id)) {
          return { data: null, error: { message: "insert violates foreign key constraint receipts_key_id_fkey", code: "23503" } };
        }
        rows.push(row);
      }
      return { data: null, error: null };
    }
    let hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of hit) Object.assign(r, toDb(this.table, this.payload as Row));
      return { data: null, error: null };
    }
    hit = [...hit].sort((a, b) => {
      for (const [c, asc] of this.orders) {
        const d = compare(a[c], b[c]);
        if (d) return asc ? d : -d;
      }
      return 0;
    });
    if (this.window) hit = hit.slice(this.window[0], this.window[1] + 1);
    if (this.max !== undefined) hit = hit.slice(0, this.max);
    const cols = this.cols.split(",").map((c) => c.trim());
    const out = hit.map((r) => structuredClone(cols.includes("*") ? r : Object.fromEntries(cols.map((c) => [c, r[c]]))));
    if (this.single) {
      if (out.length > 1) return { data: null, error: { message: "multiple rows returned", code: "PGRST116" } };
      return { data: out[0] ?? null, error: null };
    }
    return { data: out, error: null };
  }
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  requests: string[] = [];
  from(table: string) {
    return new Query(this, table);
  }
  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

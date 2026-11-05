import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { usdToMicros, type Routing } from "@bfa/core";

export const SCOPES = ["run", "receipts", "topups"] as const;
export type Scope = (typeof SCOPES)[number];
export const DEFAULT_SCOPES: Scope[] = ["run", "receipts"];

/** A per-API cap for one key: total USD or number of charged calls per UTC day. */
export type PerApiLimit =
  | { listing_id: string; kind: "usd"; value: string }
  | { listing_id: string; kind: "calls"; value: number };

/** Which listings a key may call. "allow": only these. "block": anything except these. */
export interface ListingAccess {
  mode: "all" | "allow" | "block";
  listing_ids: string[];
}
export const DEFAULT_LISTING_ACCESS: ListingAccess = { mode: "all", listing_ids: [] };
export const DEFAULT_ROUTING: Routing = { prefer: [], strict: false };
export const MAX_ROUTE_ENTRIES = 20;

/** What the gateway stores for an API key. The secret itself is never stored, only its sha256. */
export interface ApiKeyRecord {
  id: string;
  name: string;
  /** First 16 characters of the secret, for display (e.g. "bfa_sk_test_Ab12"). */
  prefix: string;
  /** Hex sha256 of the full secret. */
  sha256: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  /** All APIs combined, per UTC day, decimal string. */
  daily_limit_usd: string;
  per_api_limits: PerApiLimit[];
  scopes: Scope[];
  listing_access: ListingAccess;
  /** Which listings to try first when the agent asks by query. Missing on keys made before routing existed. */
  routing?: Routing;
  /** The signed-in user who owns this key; null for operator keys made with the CLI. Their payments come from that user's own vault. */
  user_id?: string | null;
}

/** Where API keys live: a JSON file (`FileKeyStore`) or Postgres via Supabase (`SupabaseKeyStore`). */
export interface KeyStore {
  insert(record: ApiKeyRecord): Promise<void>;
  /** Oldest first. */
  list(): Promise<ApiKeyRecord[]>;
  get(id: string): Promise<ApiKeyRecord | undefined>;
  findBySha256(sha256: string): Promise<ApiKeyRecord | undefined>;
  /** Marks a key revoked. Revoking twice keeps the first revoked_at. Returns undefined for an unknown id. */
  revoke(id: string, at: Date): Promise<ApiKeyRecord | undefined>;
  /** Replaces a key's routing. Returns undefined for an unknown id. */
  setRouting(id: string, routing: Routing): Promise<ApiKeyRecord | undefined>;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const SECRET_RE = /^bfa_sk_(test|live)_[0-9A-Za-z]{32}$/;
export const PREFIX_LEN = 16;

/** Uniform base62 string from the OS CSPRNG (rejection sampling, no modulo bias). */
export function randomBase62(len: number): string {
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += BASE62[b % 62];
    }
  }
  return out;
}

export function generateSecret(network: "testnet" | "mainnet"): string {
  return `bfa_sk_${network === "mainnet" ? "live" : "test"}_${randomBase62(32)}`;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function keyAllowsListing(key: Pick<ApiKeyRecord, "listing_access">, listingId: string): boolean {
  const { mode, listing_ids } = key.listing_access;
  if (mode === "allow") return listing_ids.includes(listingId);
  if (mode === "block") return !listing_ids.includes(listingId);
  return true;
}

/** Parses a CLI limit like `bfa/near-account:usd:0.50` or `bfa/near-account:calls:200`. */
export function parseLimit(spec: string): PerApiLimit {
  const parts = spec.split(":");
  if (parts.length < 3) throw new Error(`limit "${spec}" must look like <listing_id>:usd:<amount> or <listing_id>:calls:<n>`);
  const value = parts.pop()!;
  const kind = parts.pop()!;
  const listing_id = parts.join(":");
  if (kind === "usd") return { listing_id, kind, value };
  if (kind === "calls") return { listing_id, kind, value: Number(value) };
  throw new Error(`limit "${spec}": kind must be usd or calls`);
}

export interface NewKeyInput {
  name: string;
  expiresAt: Date;
  dailyLimitUsd: string;
  perApiLimits?: PerApiLimit[];
  scopes?: Scope[];
  listingAccess?: ListingAccess;
  routing?: Routing;
  userId?: string | null;
  network: "testnet" | "mainnet";
  /** Creation time; defaults to now. */
  now?: Date;
}

function validUsd(v: string): boolean {
  try {
    usdToMicros(v);
    return true;
  } catch {
    return false;
  }
}

/** Throws a plain Error naming the first invalid field. Used by createKey and by stores reading untrusted rows. */
export function validateKey(r: ApiKeyRecord): void {
  if (!/^key_[0-9A-Za-z]{16}$/.test(r.id)) throw new Error(`invalid key id "${r.id}"`);
  if (!r.name.trim() || r.name.length > 100) throw new Error("name must be 1-100 characters");
  if (!/^[0-9a-f]{64}$/.test(r.sha256)) throw new Error("sha256 must be 64 hex characters");
  for (const f of ["created_at", "expires_at"] as const) {
    if (Number.isNaN(Date.parse(r[f]))) throw new Error(`${f} must be an ISO date`);
  }
  if (r.revoked_at !== null && Number.isNaN(Date.parse(r.revoked_at))) throw new Error("revoked_at must be an ISO date or null");
  if (!validUsd(r.daily_limit_usd)) throw new Error(`daily_limit_usd "${r.daily_limit_usd}" must be a decimal string with up to 6 decimals`);
  for (const l of r.per_api_limits) {
    if (!l.listing_id) throw new Error("per-API limit needs a listing_id");
    if (l.kind === "usd" && !validUsd(l.value)) throw new Error(`per-API usd limit for ${l.listing_id} must be a decimal string`);
    if (l.kind === "calls" && !(Number.isInteger(l.value) && l.value >= 0)) {
      throw new Error(`per-API calls limit for ${l.listing_id} must be a non-negative integer`);
    }
    if (l.kind !== "usd" && l.kind !== "calls") throw new Error(`per-API limit kind must be usd or calls`);
  }
  if (r.scopes.length === 0 || r.scopes.some((s) => !SCOPES.includes(s))) {
    throw new Error(`scopes must be a non-empty subset of ${SCOPES.join(", ")}`);
  }
  const a = r.listing_access;
  if (!["all", "allow", "block"].includes(a.mode)) throw new Error("listing_access.mode must be all, allow or block");
  if (a.mode === "all" && a.listing_ids.length) throw new Error("listing_access mode all takes no listing_ids");
  if (a.mode === "allow" && a.listing_ids.length === 0) throw new Error("listing_access mode allow needs at least one listing id");
  if (a.listing_ids.some((id) => typeof id !== "string" || !id)) throw new Error("listing_access.listing_ids must be non-empty strings");
  if (r.routing) validateRouting(r.routing);
}

export function validateRouting(r: Routing): void {
  if (!r || !Array.isArray(r.prefer) || typeof r.strict !== "boolean") throw new Error("routing must be { prefer: string[], strict: boolean }");
  if (r.prefer.length > MAX_ROUTE_ENTRIES) throw new Error(`routing.prefer takes at most ${MAX_ROUTE_ENTRIES} entries`);
  for (const p of r.prefer) {
    if (typeof p !== "string" || !p.trim() || p.length > 120) throw new Error("routing.prefer entries must be listing ids or provider:<name>");
    if (p.startsWith("provider:") && !p.slice("provider:".length).trim()) throw new Error(`routing entry "${p}" names no provider`);
  }
}

/** Trims entries and drops duplicates, keeping the first occurrence (the order is the preference). */
export function normalizeRouting(r: Routing): Routing {
  if (!r || !Array.isArray(r.prefer)) return r;
  const seen = new Set<string>();
  const prefer = r.prefer.map((p) => (typeof p === "string" ? p.trim() : p)).filter((p) => !seen.has(p) && seen.add(p));
  return { prefer, strict: r.strict };
}

/** Creates a key, stores only its hash, and returns the secret. The secret cannot be recovered later. */
export async function createKey(store: KeyStore, input: NewKeyInput): Promise<{ secret: string; record: ApiKeyRecord }> {
  const now = input.now ?? new Date();
  if (Number.isNaN(input.expiresAt.getTime()) || input.expiresAt <= now) throw new Error("expires_at must be in the future");
  const secret = generateSecret(input.network);
  const record: ApiKeyRecord = {
    id: `key_${randomBase62(16)}`,
    name: input.name,
    prefix: secret.slice(0, PREFIX_LEN),
    sha256: hashSecret(secret),
    created_at: now.toISOString(),
    expires_at: input.expiresAt.toISOString(),
    revoked_at: null,
    daily_limit_usd: input.dailyLimitUsd,
    per_api_limits: input.perApiLimits ?? [],
    scopes: [...new Set(input.scopes?.length ? input.scopes : DEFAULT_SCOPES)],
    listing_access: input.listingAccess
      ? { mode: input.listingAccess.mode, listing_ids: [...new Set(input.listingAccess.listing_ids)] }
      : { ...DEFAULT_LISTING_ACCESS, listing_ids: [] },
    routing: input.routing ? normalizeRouting(input.routing) : { ...DEFAULT_ROUTING, prefer: [] },
    user_id: input.userId ?? null,
  };
  validateKey(record);
  await store.insert(record);
  return { secret, record };
}

export type AuthResult = { ok: true; key: ApiKeyRecord } | { ok: false; message: string };

/**
 * Resolves an `Authorization: Bearer <secret>` header to a stored key. Unknown or malformed → not ok (HTTP 401).
 * Revoked and expired keys still resolve: each tool call then refuses with key_revoked / key_expired, so the agent
 * gets a machine-readable reason.
 */
export async function authenticate(
  store: KeyStore,
  header: string | undefined,
  network: "testnet" | "mainnet",
): Promise<AuthResult> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (!m) return { ok: false, message: "missing Authorization: Bearer <BFA API key>" };
  const secret = m[1]!;
  const fmt = SECRET_RE.exec(secret);
  if (!fmt) return { ok: false, message: "malformed BFA API key" };
  const want = network === "mainnet" ? "live" : "test";
  if (fmt[1] !== want) return { ok: false, message: `this gateway runs on ${network} and only accepts bfa_sk_${want}_ keys` };
  const key = await store.findBySha256(hashSecret(secret));
  if (!key) return { ok: false, message: "unknown BFA API key" };
  return { ok: true, key };
}

interface KeyFile {
  version: 1;
  keys: ApiKeyRecord[];
}

/**
 * Keys in one JSON file (default `<state dir>/keys.json`, mode 0600). Every write goes to a temp file that is then
 * renamed over the original, so readers never see a half-written file. Reads hit the disk each time, so a key
 * revoked from the CLI stops working on the next call without restarting the gateway.
 */
export class FileKeyStore implements KeyStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  private async read(): Promise<KeyFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: [] };
      throw e;
    }
    const f = JSON.parse(text) as KeyFile;
    if (f.version !== 1 || !Array.isArray(f.keys)) throw new Error(`${this.path} is not a BFA key file`);
    return f;
  }

  private async write(f: KeyFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBase62(8)}.tmp`;
    await writeFile(tmp, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }

  /** Serializes read-modify-write cycles within this process. */
  private mutate<T>(fn: (f: KeyFile) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const f = await this.read();
      const out = await fn(f);
      await this.write(f);
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  insert(record: ApiKeyRecord): Promise<void> {
    return this.mutate((f) => {
      if (f.keys.some((k) => k.id === record.id || k.sha256 === record.sha256)) throw new Error("duplicate key");
      f.keys.push(record);
    });
  }

  async list(): Promise<ApiKeyRecord[]> {
    return (await this.read()).keys;
  }

  async get(id: string): Promise<ApiKeyRecord | undefined> {
    return (await this.read()).keys.find((k) => k.id === id);
  }

  async findBySha256(sha256: string): Promise<ApiKeyRecord | undefined> {
    return (await this.read()).keys.find((k) => k.sha256 === sha256);
  }

  setRouting(id: string, routing: Routing): Promise<ApiKeyRecord | undefined> {
    const next = normalizeRouting(routing);
    validateRouting(next);
    return this.mutate((f) => {
      const k = f.keys.find((x) => x.id === id);
      if (k) k.routing = next;
      return k;
    });
  }

  revoke(id: string, at: Date): Promise<ApiKeyRecord | undefined> {
    return this.mutate((f) => {
      const k = f.keys.find((x) => x.id === id);
      if (k && k.revoked_at === null) k.revoked_at = at.toISOString();
      return k;
    });
  }
}

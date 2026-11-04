import type { IncomingMessage, ServerResponse } from "node:http";
import { KeyPair } from "near-api-js";
import { loadRegistry, type ReceiptStore } from "@bfa/core";
import type { Hex } from "viem";
import { clearedSessionCookie, readSession, sessionCookie, signSession, verifyGoogleIdToken, type JwksFetcher } from "./auth.js";
import { implicitAccountId, type Chain } from "./chain.js";
import { createKey, type ApiKeyRecord, type KeyStore, type ListingAccess, type PerApiLimit, type Scope } from "./keys.js";
import { seal, type UserRecord, type UserStore } from "./users.js";

export interface ConsoleOptions {
  network: "testnet" | "mainnet";
  keys: KeyStore;
  receipts: ReceiptStore;
  users: UserStore;
  chain?: Chain;
  /** 32 bytes: signs session cookies and encrypts agent keys. */
  secret: Buffer;
  googleClientId?: string;
  /** Allow POST /api/auth/dev (sign in with just an email). Local development and tests only. */
  devLogin?: boolean;
  /** Set the cookie's Secure flag (behind https). */
  secureCookies?: boolean;
  registryDir: string;
  devRegistryDir?: string;
  /** NEAR sent to a new user's account on testnet so it can pay for its own setup (yoctoNEAR). */
  sponsorYocto?: bigint;
  /** Gas allowance of the gateway's function-call key (yoctoNEAR). */
  agentAllowanceYocto?: bigint;
  jwks?: JwksFetcher;
  now?: () => Date;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new ApiError(415, "bad_request", "send JSON");
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 256 * 1024) throw new ApiError(413, "bad_request", "body too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "bad_request", "body is not a JSON object");
  }
}

function publicKey(k: ApiKeyRecord) {
  const { sha256: _hash, ...rest } = k;
  return rest;
}

const ONE_NEAR = 10n ** 24n;

/** The signed-in console's JSON API under /api. Returns false when the path is not an /api route. */
export function consoleApi(o: ConsoleOptions) {
  const now = o.now ?? (() => new Date());
  // NEAR reserves the worst-case gas cost of each call against a key's allowance (~0.3 NEAR for 300 Tgas), though only
  // ~0.03 is burned, so the agent key needs well over 0.3 NEAR of allowance; the account is funded to cover it.
  const sponsorYocto = o.sponsorYocto ?? (ONE_NEAR * 3n) / 2n;
  const allowance = o.agentAllowanceYocto ?? ONE_NEAR;

  async function currentUser(req: IncomingMessage): Promise<UserRecord> {
    const uid = readSession(o.secret, req.headers.cookie, now());
    const u = uid ? await o.users.get(uid) : undefined;
    if (!u) throw new ApiError(401, "signed_out", "sign in first");
    return u;
  }

  async function wallet(u: UserRecord) {
    const out: Record<string, unknown> = { status: u.wallet_status, near_account_id: u.near_account_id, agent_public_key: u.agent_public_key };
    if (!o.chain || !u.near_account_id) return out;
    out.treasury_id = o.chain.treasuryId;
    try {
      const address = await o.chain.vaultAddress(u.near_account_id);
      out.vault_address = address;
      const [vault, usdc, topUp] = await Promise.all([
        o.chain.vault(u.near_account_id).catch(() => null),
        o.chain.usdcBalance(address).catch(() => null),
        o.chain.topUpAddress(address).catch(() => null),
      ]);
      out.vault = vault;
      out.usdc_balance_atomic = usdc === null ? null : usdc.toString();
      out.top_up_address = topUp;
    } catch (e) {
      out.chain_error = (e as Error).message;
    }
    return out;
  }

  async function userKeys(u: UserRecord) {
    return (await o.keys.list()).filter((k) => k.user_id === u.id);
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const m = req.method ?? "GET";

    if (m === "GET" && path === "/api/config") {
      return json(res, 200, {
        network: o.network,
        google_client_id: o.googleClientId ?? null,
        dev_login: !!o.devLogin,
        treasury_id: o.chain?.treasuryId ?? null,
        top_up_factory: o.chain?.topUpFactory ?? null,
        near_rpc_path: "/api/near/rpc",
        fee: { on_top_percent: "1.5" },
        agent_methods: ["sign_eip3009"],
        agent_allowance_yocto: allowance.toString(),
      });
    }

    if (m === "GET" && path === "/api/listings") {
      const main = await loadRegistry(o.registryDir);
      const dev = o.devRegistryDir ? (await loadRegistry(o.devRegistryDir, `${o.registryDir}/schema`)).entries : [];
      const ids = new Set(main.entries.map((e) => e.listing.id));
      const all = [...main.entries, ...dev.filter((e) => !ids.has(e.listing.id))];
      return json(res, 200, {
        listings: all.map((e) => ({
          id: e.listing.id,
          name: e.listing.name,
          provider: e.listing.provider.name,
          categories: e.listing.categories,
          price_usd: e.listing.pricing.amount_usd,
          charges_empty_results: e.listing.pricing.charges_empty_results,
          networks: e.listing.payment.networks,
          routable: e.routable,
          review_status: e.review?.status ?? "pending",
          not_routable_reason: e.not_routable_reason ?? null,
        })),
      });
    }

    if (m === "POST" && path === "/api/auth/google") {
      if (!o.googleClientId) throw new ApiError(503, "google_not_configured", "Google sign-in is not configured on this gateway (BFA_GOOGLE_CLIENT_ID)");
      const b = await body(req);
      if (typeof b.credential !== "string") throw new ApiError(400, "bad_request", "credential required");
      let id;
      try {
        id = await verifyGoogleIdToken(b.credential, o.googleClientId, o.jwks, now());
      } catch (e) {
        throw new ApiError(401, "google_rejected", (e as Error).message);
      }
      const u = await o.users.upsertGoogle({ google_sub: id.sub, email: id.email, name: id.name }, now());
      return json(res, 200, { ok: true, email: u.email }, { "set-cookie": sessionCookie(signSession(o.secret, u.id, now()), !!o.secureCookies) });
    }

    if (m === "POST" && path === "/api/auth/dev") {
      if (!o.devLogin) throw new ApiError(404, "not_found", "dev sign-in is off");
      const b = await body(req);
      const email = String(b.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, "bad_request", "enter an email like you@example.com");
      const u = await o.users.upsertGoogle({ google_sub: `dev:${email}`, email, name: null }, now());
      return json(res, 200, { ok: true, email: u.email, dev: true }, { "set-cookie": sessionCookie(signSession(o.secret, u.id, now()), !!o.secureCookies) });
    }

    if (m === "POST" && path === "/api/auth/logout") {
      return json(res, 200, { ok: true }, { "set-cookie": clearedSessionCookie(!!o.secureCookies) });
    }

    const u = await currentUser(req);

    if (m === "GET" && path === "/api/me") {
      return json(res, 200, { user: { email: u.email, name: u.name, created_at: u.created_at }, wallet: await wallet(u) });
    }

    if (m === "POST" && path === "/api/wallet/start") {
      if (!o.chain) throw new ApiError(503, "chain_not_configured", "this gateway has no treasury configured");
      const b = await body(req);
      if (typeof b.public_key !== "string" || !b.public_key.startsWith("ed25519:")) throw new ApiError(400, "bad_request", "public_key must be an ed25519:... key generated in your browser");
      const accountId = implicitAccountId(b.public_key);
      if (u.near_account_id && u.near_account_id !== accountId) throw new ApiError(409, "wallet_exists", "you already have a wallet; restore it from your recovery key");
      let agentPublic = u.agent_public_key;
      let patch: Partial<UserRecord> = {};
      if (!agentPublic) {
        const agent = KeyPair.fromRandom("ed25519");
        agentPublic = agent.getPublicKey().toString();
        patch = { agent_public_key: agentPublic, agent_secret_enc: seal(o.secret, agent.toString()) };
      }
      let sponsorTx: string | null = null;
      if (!(await o.chain.accountExists(accountId))) sponsorTx = await o.chain.sponsor(accountId, sponsorYocto);
      const updated = await o.users.update(u.id, { ...patch, near_account_id: accountId, wallet_status: u.wallet_status === "ready" ? "ready" : "funded" });
      return json(res, 200, {
        near_account_id: accountId,
        agent_public_key: updated.agent_public_key,
        treasury_id: o.chain.treasuryId,
        agent_methods: ["sign_eip3009"],
        agent_allowance_yocto: allowance.toString(),
        sponsor_tx: sponsorTx,
      });
    }

    if (m === "POST" && path === "/api/wallet/confirm") {
      if (!o.chain || !u.near_account_id || !u.agent_public_key) throw new ApiError(409, "wallet_not_started", "start your wallet first");
      const [hasKey, vault] = await Promise.all([o.chain.hasAccessKey(u.near_account_id, u.agent_public_key), o.chain.vault(u.near_account_id)]);
      if (!hasKey || !vault) {
        throw new ApiError(409, "wallet_incomplete", `${!vault ? "vault not created yet" : ""}${!vault && !hasKey ? "; " : ""}${!hasKey ? "agent key not added yet" : ""}`);
      }
      await o.users.update(u.id, { wallet_status: "ready" });
      return json(res, 200, { ok: true, wallet: await wallet({ ...u, wallet_status: "ready" }) });
    }

    if (m === "POST" && path === "/api/near/rpc") {
      if (!o.chain) throw new ApiError(503, "chain_not_configured", "no chain configured");
      const b = await body(req);
      try {
        return json(res, 200, await o.chain.rpc(String(b.method), b.params, b.id ?? "bfa"));
      } catch (e) {
        throw new ApiError(400, "rpc_refused", (e as Error).message);
      }
    }

    if (m === "GET" && path === "/api/keys") {
      return json(res, 200, { keys: (await userKeys(u)).map(publicKey) });
    }

    if (m === "POST" && path === "/api/keys") {
      if (u.wallet_status !== "ready") throw new ApiError(409, "wallet_not_ready", "set up your wallet before creating keys");
      const b = await body(req);
      const days = Number(b.expires_days ?? 30);
      const expiresAt = typeof b.expires_at === "string" ? new Date(b.expires_at) : new Date(now().getTime() + days * 86_400_000);
      try {
        const { secret, record } = await createKey(o.keys, {
          name: String(b.name ?? ""),
          expiresAt,
          dailyLimitUsd: String(b.daily_limit_usd ?? ""),
          perApiLimits: (b.per_api_limits as PerApiLimit[] | undefined) ?? [],
          ...(Array.isArray(b.scopes) && { scopes: b.scopes as Scope[] }),
          ...(b.listing_access ? { listingAccess: b.listing_access as ListingAccess } : {}),
          userId: u.id,
          network: o.network,
          now: now(),
        });
        return json(res, 201, { secret, key: publicKey(record) });
      } catch (e) {
        throw new ApiError(400, "invalid_key", (e as Error).message);
      }
    }

    const rv = /^\/api\/keys\/(key_[0-9A-Za-z]{16})\/revoke$/.exec(path);
    if (m === "POST" && rv) {
      const k = await o.keys.get(rv[1]!);
      if (!k || k.user_id !== u.id) throw new ApiError(404, "not_found", "no such key");
      const out = await o.keys.revoke(k.id, now());
      return json(res, 200, { key: out && publicKey(out) });
    }

    if (m === "GET" && path === "/api/receipts") {
      const keys = await userKeys(u);
      const lists = await Promise.all(keys.map((k) => o.receipts.all({ key_id: k.id })));
      const all = lists.flat().sort((a, b) => b.started_at.localeCompare(a.started_at));
      return json(res, 200, { receipts: all.slice(0, 200) });
    }

    throw new ApiError(404, "not_found", "no such API route");
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith("/api/")) return false;
    try {
      await route(req, res, path);
    } catch (e) {
      if (res.headersSent) res.end();
      else if (e instanceof ApiError) json(res, e.status, { error: { code: e.code, message: e.message } });
      else json(res, 500, { error: { code: "internal", message: "internal error" } });
    }
    return true;
  };
}

export type { Hex };

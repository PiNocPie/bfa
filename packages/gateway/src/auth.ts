import { createHmac, createPublicKey, timingSafeEqual, verify as verifySig, type JsonWebKey } from "node:crypto";

// ---- Google Sign-In ID tokens ----

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";

export type JwksFetcher = () => Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;

let cache: { at: number; keys: (JsonWebKey & { kid?: string })[] } | undefined;
export const googleJwks: JwksFetcher = async () => {
  if (cache && Date.now() - cache.at < 3600_000) return { keys: cache.keys };
  const res = await fetch(GOOGLE_JWKS, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`could not fetch Google signing keys: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] };
  cache = { at: Date.now(), keys: body.keys };
  return body;
};

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

/**
 * Verifies a Google Sign-In credential (an RS256 JWT) for this app's OAuth client id: signature against Google's
 * published keys, issuer, audience, expiry and a verified email. Returns who signed in.
 */
export async function verifyGoogleIdToken(token: string, clientId: string, jwks: JwksFetcher = googleJwks, now = new Date()): Promise<GoogleIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const [h, p, s] = parts as [string, string, string];
  const header = b64json(h);
  if (header.alg !== "RS256") throw new Error("unexpected token algorithm");
  const { keys } = await jwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("token signed by an unknown key");
  const ok = verifySig("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("bad token signature");
  const c = b64json(p);
  if (!GOOGLE_ISSUERS.has(String(c.iss))) throw new Error("token not issued by Google");
  if (c.aud !== clientId) throw new Error("token is for a different app");
  if (typeof c.exp !== "number" || c.exp * 1000 < now.getTime()) throw new Error("token expired");
  if (c.email_verified !== true || typeof c.email !== "string") throw new Error("Google account email is not verified");
  if (typeof c.sub !== "string" || !c.sub) throw new Error("token has no subject");
  return { sub: c.sub, email: c.email, name: typeof c.name === "string" ? c.name : null };
}

// ---- session cookies ----

export const SESSION_COOKIE = "bfa_session";
const SESSION_TTL_S = 7 * 24 * 3600;

export function signSession(secret: Buffer, userId: string, now = new Date()): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_S })).toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function readSession(secret: Buffer, cookieHeader: string | undefined, now = new Date()): string | null {
  const raw = (cookieHeader ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const want = createHmac("sha256", secret).update(payload).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { uid: string; exp: number };
    return exp * 1000 > now.getTime() ? uid : null;
  } catch {
    return null;
  }
}

export function sessionCookie(value: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

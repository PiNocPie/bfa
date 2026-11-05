import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * A person who signed in with Google. Their money lives in their own treasury vault, controlled by a NEAR account
 * whose full-access key is generated and kept in their browser. The gateway holds only `agent_key`: a function-call
 * key on that account that can call nothing but the treasury's `sign_eip3009`, so it can pay within the vault's
 * on-chain daily limit and never change that limit.
 */
export interface UserRecord {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  created_at: string;
  /** Implicit NEAR account (64 hex chars) derived from the browser-held public key. */
  near_account_id: string | null;
  /** Public key of the gateway's function-call key on that account. */
  agent_public_key: string | null;
  /** The function-call key's secret, AES-256-GCM encrypted with BFA_SECRET_KEY. Never returned by any API. */
  agent_secret_enc: string | null;
  /** none → no wallet yet; funded → account sponsored, waiting for the browser's setup transactions; ready → vault and agent key exist on-chain. */
  wallet_status: "none" | "funded" | "ready";
}

export interface UserStore {
  get(id: string): Promise<UserRecord | undefined>;
  findByGoogleSub(sub: string): Promise<UserRecord | undefined>;
  upsertGoogle(input: { google_sub: string; email: string; name: string | null }, now: Date): Promise<UserRecord>;
  update(id: string, patch: Partial<Omit<UserRecord, "id" | "google_sub" | "created_at">>): Promise<UserRecord>;
}

// ---- encryption of the agent key at rest ----

export function secretKeyFromEnv(raw: string | undefined): Buffer {
  // Tolerate what dashboards often add by accident: surrounding whitespace, quotes and a 0x prefix.
  const hex = (raw ?? "").trim().replace(/^["']|["']$/g, "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const why = !raw ? "it is not set" : `it has ${hex.length} characters${/[^0-9a-fA-F]/.test(hex) ? " including non-hex ones" : ""}; it needs exactly 64 hex characters`;
    throw new Error(`BFA_SECRET_KEY is invalid: ${why}. Generate one with: openssl rand -hex 32`);
  }
  return Buffer.from(hex, "hex");
}

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${body.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}

export function unseal(key: Buffer, sealed: string): string {
  const [v, iv, body, tag] = sealed.split(".");
  if (v !== "v1" || !iv || !body || !tag) throw new Error("unrecognized sealed value");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}

/** Stable short id for logs, never the email. */
export function userTag(u: Pick<UserRecord, "id">): string {
  return createHash("sha256").update(u.id).digest("hex").slice(0, 8);
}

// ---- file store ----

interface UserFile {
  version: 1;
  users: UserRecord[];
}

export class FileUserStore implements UserStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}

  private async read(): Promise<UserFile> {
    try {
      const f = JSON.parse(await readFile(this.path, "utf8")) as UserFile;
      if (f.version !== 1 || !Array.isArray(f.users)) throw new Error(`${this.path} is not a BFA user file`);
      return f;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, users: [] };
      throw e;
    }
  }

  private async write(f: UserFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }

  private mutate<T>(fn: (f: UserFile) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const f = await this.read();
      const out = fn(f);
      await this.write(f);
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get(id: string) {
    return (await this.read()).users.find((u) => u.id === id);
  }

  async findByGoogleSub(sub: string) {
    return (await this.read()).users.find((u) => u.google_sub === sub);
  }

  upsertGoogle(input: { google_sub: string; email: string; name: string | null }, now: Date): Promise<UserRecord> {
    return this.mutate((f) => {
      const found = f.users.find((u) => u.google_sub === input.google_sub);
      if (found) {
        found.email = input.email;
        found.name = input.name;
        return found;
      }
      const u: UserRecord = {
        id: randomUUID(),
        google_sub: input.google_sub,
        email: input.email,
        name: input.name,
        created_at: now.toISOString(),
        near_account_id: null,
        agent_public_key: null,
        agent_secret_enc: null,
        wallet_status: "none",
      };
      f.users.push(u);
      return u;
    });
  }

  update(id: string, patch: Partial<Omit<UserRecord, "id" | "google_sub" | "created_at">>): Promise<UserRecord> {
    return this.mutate((f) => {
      const u = f.users.find((x) => x.id === id);
      if (!u) throw new Error("unknown user");
      Object.assign(u, patch);
      return u;
    });
  }
}

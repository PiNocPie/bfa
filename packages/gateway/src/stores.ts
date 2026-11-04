import { join } from "node:path";
import { ReceiptLog, type ReceiptStore } from "@bfa/core";
import { FileKeyStore, type KeyStore } from "./keys.js";
import { SupabaseKeyStore, SupabaseReceiptStore, SupabaseUserStore, supabaseServiceClient } from "./supabase.js";
import { FileUserStore, type UserStore } from "./users.js";

export interface Stores {
  kind: "file" | "supabase";
  keys: KeyStore;
  receipts: ReceiptStore;
  users: UserStore;
}

/**
 * Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both set; otherwise files in `stateDir`
 * (keys.json and receipts.jsonl), which is what tests and local development use.
 */
export function storesFromEnv(env: NodeJS.ProcessEnv, stateDir: string): Stores {
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && serviceKey) {
    const db = supabaseServiceClient(url, serviceKey);
    return { kind: "supabase", keys: new SupabaseKeyStore(db), receipts: new SupabaseReceiptStore(db), users: new SupabaseUserStore(db) };
  }
  if (url || serviceKey) throw new Error("set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to use Supabase, or neither for the file store");
  return {
    kind: "file",
    keys: new FileKeyStore(join(stateDir, "keys.json")),
    receipts: new ReceiptLog(join(stateDir, "receipts.jsonl")),
    users: new FileUserStore(join(stateDir, "users.json")),
  };
}

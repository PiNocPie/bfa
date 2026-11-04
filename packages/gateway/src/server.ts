import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ReceiptStore } from "@bfa/core";
import { registerTools, tools, type BfaConfig } from "@bfa/mcp/lib";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { authenticate, type KeyStore } from "./keys.js";
import { SerialQueue, keyPolicy } from "./policy.js";
import { unseal, type UserStore } from "./users.js";

export interface GatewayOptions {
  /** Same configuration as the stdio server (registry, NEAR signer, session key, gateway-wide daily cap). */
  config: BfaConfig;
  keys: KeyStore;
  receipts: ReceiptStore;
  /** Clock for key expiry and UTC-day limits. Injected for tests. */
  now?: () => Date;
  /** Largest accepted POST body. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Signed-in users. Keys with a user_id pay from that user's own treasury vault. */
  users?: UserStore;
  /** Decrypts users' agent keys (BFA_SECRET_KEY). Required with `users`. */
  secret?: Buffer;
  /** The console's /api handler (see consoleApi). */
  consoleApi?: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
  /** Directory with the website (index.html, app.js, ...), served at /. */
  webDir?: string;
}

export interface Gateway {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Number of open MCP sessions. */
  sessionCount(): number;
  close(): Promise<void>;
}

interface Session {
  keyId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

const MCP_PATH = "/v1";

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, `request body over ${max} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not JSON");
  }
}

/**
 * The hosted MCP endpoint: Streamable HTTP at /v1 (POST, GET, DELETE), one MCP session per client, each bound to the
 * BFA API key that opened it. All sessions share one tools(cfg) instance: one payer wallet and one receipt store.
 */
export function createGateway(opts: GatewayOptions): Gateway {
  const now = opts.now ?? (() => new Date());
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const t = tools({ ...opts.config, receiptStore: opts.receipts });
  const perUser = new Map<string, ReturnType<typeof tools>>();

  /** Operator keys pay from the gateway's wallet; a user's keys pay from that user's own vault, via their agent key. */
  async function toolsForKey(keyId: string): Promise<ReturnType<typeof tools>> {
    const key = await opts.keys.get(keyId);
    if (!key?.user_id) return t;
    const cached = perUser.get(key.user_id);
    if (cached) return cached;
    const user = await opts.users?.get(key.user_id);
    if (!user || user.wallet_status !== "ready" || !user.near_account_id || !user.agent_secret_enc || !opts.secret) {
      throw new HttpError(403, "this key's owner has not finished wallet setup");
    }
    if (!opts.config.treasuryId) throw new HttpError(503, "gateway has no treasury configured (BFA_TREASURY_ID)");
    const ut = tools({
      ...opts.config,
      receiptStore: opts.receipts,
      nearAccountId: user.near_account_id,
      nearPrivateKey: unseal(opts.secret, user.agent_secret_enc),
      stateDir: join(opts.config.stateDir, "users", user.id),
    });
    perUser.set(key.user_id, ut);
    return ut;
  }

  const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };
  async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
    if (!opts.webDir) return false;
    const rel = normalize(path === "" || path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    if (rel.includes("..")) return false;
    try {
      const data = await readFile(join(opts.webDir, rel));
      res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
  const payQueue = new SerialQueue();
  const sessions = new Map<string, Session>();

  async function openSession(keyId: string, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const server = new McpServer({ name: "bfa-gateway", version: "0.1.0" });
    registerTools(server, await toolsForKey(keyId), keyPolicy({ keyId, keys: opts.keys, receipts: opts.receipts, payQueue, now }));
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { keyId, transport, server });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url ?? "/", "http://gateway").pathname.replace(/\/+$/, "");
      if (req.method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
      if (opts.consoleApi && (await opts.consoleApi(req, res, path))) return;
      if (req.method === "GET" && path !== MCP_PATH && (await serveStatic(path, res))) return;
      if (path !== MCP_PATH) return sendJson(res, 404, { error: { code: "not_found", message: `the MCP endpoint is ${MCP_PATH}` } });
      if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
        return sendJson(res, 405, { error: { code: "method_not_allowed", message: "use POST, GET or DELETE" } }, { allow: "POST, GET, DELETE" });
      }

      const auth = await authenticate(opts.keys, req.headers.authorization, opts.config.network);
      if (!auth.ok) {
        return sendJson(
          res,
          401,
          { error: { code: "unauthorized", message: auth.message, next_action: "stop" } },
          { "www-authenticate": 'Bearer realm="bfa"' },
        );
      }

      const body = req.method === "POST" ? await readJson(req, maxBody) : undefined;
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") {
        const s = sessions.get(sid);
        if (!s) return rpcError(res, 404, "session not found; initialize a new one");
        if (s.keyId !== auth.key.id) return rpcError(res, 403, "this session belongs to a different API key");
        return await s.transport.handleRequest(req, res, body);
      }
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return rpcError(res, 400, "no mcp-session-id: send an initialize request first");
      }
      return await openSession(auth.key.id, req, res, body);
    } catch (e) {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return rpcError(res, e.status, e.message);
      return rpcError(res, 500, "internal gateway error");
    }
  }

  return {
    handle,
    sessionCount: () => sessions.size,
    async close() {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((s) => s.server.close()));
    },
  };
}

/** Serves the gateway over node:http. Returns the server and the URL of its MCP endpoint. */
export async function listen(gw: Gateway, port: number, host: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => void gw.handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const h = addr.family === "IPv6" ? `[${addr.address}]` : addr.address;
  return { server, url: `http://${h}:${addr.port}${MCP_PATH}` };
}

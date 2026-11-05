import { addAgentKey, createVault, loadKey, newKey, parseRecovery, pauseVault, recoveryBlob, saveKey, setDailyLimit, waitForAccount, type StoredKey } from "./wallet.js";

declare const google: any;

type Config = {
  network: string; google_client_id: string | null; dev_login: boolean; treasury_id: string | null;
  top_up_factory: string | null; agent_allowance_yocto: string;
};
type Vault = { daily_limit: string; spent_today: string; allowed_to: string[]; paused: boolean };
type Wallet = {
  status: "none" | "funded" | "ready"; near_account_id: string | null; agent_public_key: string | null; treasury_id?: string;
  vault_address?: string; vault?: Vault | null; usdc_balance_atomic?: string | null; top_up_address?: string | null;
};
type Me = { user: { email: string; name: string | null }; wallet: Wallet };
type Listing = { id: string; name: string; provider: string; categories: string[]; price_usd: string; charges_empty_results: boolean; routable: boolean; review_status: string; not_routable_reason: string | null };
type Key = { id: string; name: string; prefix: string; created_at: string; expires_at: string; revoked_at: string | null; daily_limit_usd: string; per_api_limits: { listing_id: string; kind: string; value: string | number }[]; scopes: string[]; listing_access: { mode: string; listing_ids: string[] } };
type Receipt = { receipt_id: string; started_at: string; listing_id: string; status: string; price_usd: string; latency_ms?: number; payment_tx?: string; key_id?: string; scheme?: string };

const $ = (s: string) => document.querySelector(s) as HTMLElement | null;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const usd = (atomic: string | bigint | null | undefined) => (atomic == null ? "—" : `$${(Number(BigInt(atomic)) / 1e6).toFixed(2)}`);
const atomic = (usdStr: string) => {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(usdStr.trim());
  if (!m) throw new Error("enter an amount like 1.00");
  return (BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"))).toString();
};
const short = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h);
const MCP_URL = `${location.origin}/v1`;

const state: {
  cfg?: Config; me?: Me | null; listings: Listing[]; keys: Key[]; receipts: Receipt[];
  newSecret: string | null; busy: string | null; err: string | null; setupLog: string[]; keyForm: boolean;
} = { listings: [], keys: [], receipts: [], newSecret: null, busy: null, err: null, setupLog: [], keyForm: false };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
  return j as T;
}

function toast(msg: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- views ----------
const CONSOLE = ["overview", "wallet", "keys", "usage"];

function home() {
  return `<section class="hero"><div>
    <p class="label">Built for agents · an open API market</p>
    <h1 style="margin-top:14px">Built for agents. Paid one call at a time.</h1>
    <p class="lede">Sign in with Google and get your own wallet: its key stays in your browser, its money stays in your vault on NEAR. Give each agent an API key with an expiry date and daily limits. It finds an API, sees the price, pays for one call and gets a receipt.</p>
    <div class="cta"><button class="btn accent" data-go="${state.me ? "wallet" : "signin"}">${state.me ? "Open your wallet" : "Sign in with Google"}</button><button class="btn" data-go="apis">See every API</button></div>
  </div>
  <figure class="ticket" style="margin:0"><svg class="cat perch" width="118" height="118" role="img" aria-label="BB, the BFA cat"><use href="#bfa-cat"/></svg>
    <header><span>HOW A PAID CALL WORKS</span><span>${esc(state.cfg?.network ?? "testnet").toUpperCase()}</span></header>
    <ol>
      <li><b>discover</b><span>agent asks for data, BFA lists reviewed APIs</span><span>free</span></li>
      <li><b>inspect</b><span>exact price, empty and failed calls are free</span><span>free</span></li>
      <li><b>key check</b><span>expiry, allowlist, daily and per-API limits</span><span>BFA</span></li>
      <li><b>vault check</b><span>your on-chain daily limit, signed by NEAR</span><span>NEAR</span></li>
      <li><b>run</b><span>pays the seller in USDC, returns data + receipt</span><span>x402</span></li>
    </ol>
    <footer><span>MCP endpoint</span><span class="mono">${esc(MCP_URL)}</span></footer>
  </figure></section>`;
}

function apis() {
  return `<div class="page-head"><div><p class="label">APIs &amp; calls</p><h1 style="font-size:clamp(1.6rem,3.4vw,2.3rem);margin-top:10px">Everything your agent can call</h1>
    <p>Live from this gateway's registry. Only reviewed listings take payment.</p></div></div>
  <div class="tbox"><table style="min-width:720px"><thead><tr><th>API</th><th>Provider</th><th class="r">Price per call</th><th>If empty</th><th>Status</th></tr></thead><tbody>
  ${state.listings.map((l) => `<tr><td><b style="font-weight:600">${esc(l.name)}</b><div class="tid">${esc(l.id)}</div></td><td class="sub">${esc(l.provider)}</td><td class="r mono">$${esc(l.price_usd)}</td><td class="sub">${l.charges_empty_results ? "charged" : "not charged"}</td>
    <td>${l.routable ? '<span class="pill ok">Live</span>' : `<span class="pill info">${esc(l.review_status)}</span><div class="sub" style="margin-top:4px">${esc(l.not_routable_reason ?? "")}</div>`}</td></tr>`).join("") || `<tr><td colspan="5" class="sub">Loading…</td></tr>`}
  </tbody></table></div>`;
}

function agents() {
  return `<div class="page-head"><div><p class="label">Connect an agent</p><h1 style="font-size:clamp(1.6rem,3.4vw,2.3rem);margin-top:10px">Paste one config, then ask for data</h1>
    <p>Create a key in the console first. The agent sends it as a Bearer token; it never sees your Google account or your wallet key.</p></div></div>
  <div class="grid2"><div class="stack">
    <p class="label">Claude Code</p>
    <pre id="cfg1">claude mcp add --transport http bfa ${esc(MCP_URL)} \\
  --header "Authorization: Bearer $BFA_API_KEY"</pre><div><button class="btn small ghost" data-copy="cfg1">Copy</button></div>
    <p class="label" style="margin-top:8px">Any MCP client</p>
    <pre id="cfg2">{ "mcpServers": { "bfa": { "type": "http",
  "url": "${esc(MCP_URL)}",
  "headers": { "Authorization": "Bearer \${BFA_API_KEY}" } } } }</pre><div><button class="btn small ghost" data-copy="cfg2">Copy</button></div>
  </div><div class="stack"><p class="label">Try this prompt</p>
    <pre id="prompt">Use BFA to check the NEAR testnet account
nen-testnet.testnet. Inspect the price first,
and don't spend more than $0.01.</pre><div><button class="btn small ghost" data-copy="prompt">Copy prompt</button></div>
    <div><button class="btn accent small" data-go="${state.me ? "keys" : "signin"}">${state.me ? "Create a key" : "Sign in to create a key"}</button></div></div></div>`;
}

function signin() {
  const c = state.cfg;
  return `<div class="signin">
    <svg class="cat" width="76" height="76" aria-hidden="true" style="justify-self:center"><use href="#bfa-cat"/></svg>
    <p class="sub" style="text-align:center;margin-top:-8px">Hi, I'm BB. I keep your receipts.</p>
    <div><p class="label">BFA console</p><h2 style="margin-top:10px">Sign in</h2><p class="sub" style="margin-top:6px">New here? Signing in creates your account.</p></div>
    ${c?.google_client_id ? `<div id="gbtn" style="min-height:44px"></div>` : `<p class="sub">Google sign-in is not configured on this gateway yet.</p>`}
    ${c?.dev_login ? `<div class="or">or, for local testing</div><label class="field"><span>Email (dev sign-in)</span><input class="input" id="devemail" type="email" placeholder="you@example.com"></label><button class="btn gbtn" id="devlogin">Sign in without Google</button>` : ""}
    ${state.err ? `<p class="sub" style="color:var(--bad)">${esc(state.err)}</p>` : ""}
  </div>`;
}

function consoleWrap(cur: string, body: string) {
  const titles: Record<string, string> = { overview: "Overview", wallet: "Wallet", keys: "API keys", usage: "Usage" };
  const w = state.me!.wallet;
  return `<div class="console"><nav class="rail" aria-label="Console">
    <div class="who"><b>${esc(state.me!.user.email)}</b><span>${w.near_account_id ? `NEAR ${esc(short(w.near_account_id))}` : "no wallet yet"}</span></div>
    ${CONSOLE.map((v) => `<a href="#${v}" data-go="${v}" ${v === cur ? 'aria-current="page"' : ""}>${titles[v]}${v === "keys" ? `<span class="sub">${state.keys.filter((k) => !k.revoked_at).length}</span>` : ""}</a>`).join("")}
    <a href="#home" id="signout">Sign out</a></nav>
    <div style="min-width:0"><h1 style="font-size:1.6rem;margin-bottom:20px">${titles[cur]}</h1>${state.err ? `<div class="preview-note" style="border-color:var(--bad)">${esc(state.err)}</div>` : ""}${body}</div></div>`;
}

function overview() {
  const w = state.me!.wallet;
  if (w.status !== "ready") return consoleWrap("overview", setupPanel());
  const v = w.vault!;
  return consoleWrap("overview", `<div class="tiles">
    <div><p class="label">In your vault</p><b>${usd(w.usdc_balance_atomic)}</b><p class="sub">USDC on Base, controlled by your NEAR account</p></div>
    <div><p class="label">Spent today (on-chain)</p><b>${usd(v.spent_today)}</b><div class="bar"><i style="width:${Math.min(100, (Number(v.spent_today) / Math.max(1, Number(v.daily_limit))) * 100)}%"></i></div><p class="sub">of ${usd(v.daily_limit)} vault limit${v.paused ? " · paused" : ""}</p></div>
    <div><p class="label">Active keys</p><b>${state.keys.filter((k) => !k.revoked_at && Date.parse(k.expires_at) > Date.now()).length}</b><p class="sub">each with its own limits</p></div>
  </div>
  <div class="section"><div class="hd"><h3>Recent calls</h3><button class="btn small ghost" data-go="usage">All usage</button></div>${receiptsTable(5)}</div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:20px"><button class="btn accent" data-go="keys">Create API key</button><button class="btn" data-go="wallet">Top up</button><button class="btn" data-go="agents">Connect an agent</button></div>`);
}

function setupPanel() {
  const w = state.me!.wallet;
  const local = loadKey(state.me!.user.email);
  const needRestore = w.near_account_id && (!local || local.account_id !== w.near_account_id);
  return `<div class="panel"><div class="ph"><h3>Set up your wallet</h3><span class="sub">about 30 seconds</span></div><div class="pb">
    <ol class="steps" style="gap:10px">
      <li><span><b>Your browser creates a NEAR key.</b> <span class="muted">It never leaves this device. You download a recovery file.</span></span></li>
      <li><span><b>BFA creates your NEAR account</b> <span class="muted">and pays its testnet setup costs.</span></span></li>
      <li><span><b>You sign two transactions:</b> <span class="muted">create your vault with your daily limit, and give BFA's gateway a key that can only call <span class="mono">sign_eip3009</span>.</span></span></li>
    </ol>
    ${needRestore ? `<label class="field"><span>Restore from your recovery file</span><input type="file" id="restore" accept="application/json"><small>This account already has a wallet. Load its recovery file to continue on this device.</small></label>` :
      `<label class="field"><span>Vault daily limit</span><div class="money"><span>$</span><input id="vlimit" inputmode="decimal" value="1.00"></div><small>The most your agents can spend per day, enforced by the treasury contract. Only your browser key can change it.</small></label>`}
    ${state.setupLog.length ? `<pre>${state.setupLog.map(esc).join("\n")}</pre>` : ""}
  </div><div class="pf"><button class="btn accent" id="setup" ${state.busy ? "disabled" : ""}>${state.busy ? esc(state.busy) : needRestore ? "Continue setup" : "Create my wallet"}</button></div></div>`;
}

function walletView() {
  const w = state.me!.wallet;
  if (w.status !== "ready") return consoleWrap("wallet", setupPanel());
  const v = w.vault!;
  return consoleWrap("wallet", `<div class="tiles">
    <div><p class="label">Balance</p><b>${usd(w.usdc_balance_atomic)}</b><p class="sub">USDC in your own vault. BFA can't move it.</p></div>
    <div><p class="label">Vault daily limit</p><b>${usd(v.daily_limit)}</b><p class="sub">spent today ${usd(v.spent_today)}${v.paused ? " · paused" : ""}</p></div>
    <div><p class="label">Vault address (Base)</p><b style="font-size:.95rem;overflow-wrap:anywhere">${esc(w.vault_address)}</b><p class="sub">derived from your NEAR account by Chain Signatures</p></div>
  </div>
  <div class="panel"><div class="ph"><h3>Top up</h3><span class="sub">USDC on Base ${state.cfg?.network === "testnet" ? "Sepolia" : ""} · 1.5% fee on top</span></div><div class="pb">
    ${w.top_up_address ? `<div class="field"><span>Your top-up address</span><div class="addr"><code id="dep">${esc(w.top_up_address)}</code><button class="btn small ghost" data-copy="dep">Copy</button></div>
      <small>Send USDC only. A public contract splits each deposit: to add $10.00 send $10.15; $10.00 goes to your vault and $0.15 to BFA. Nobody, including BFA, can send it anywhere else. Anyone can trigger the split; BFA does it within minutes.</small></div>` : `<p class="sub">Top-up contract not configured on this gateway.</p>`}
    ${state.cfg?.network === "testnet" ? `<p class="sub">Test USDC: <a href="https://faucet.circle.com">faucet.circle.com</a> → Base Sepolia.</p>` : ""}
  </div>${w.top_up_address ? `<div class="pf"><span class="sub" style="margin-right:auto;align-self:center">Sent something? BFA moves it into your vault automatically, or do it now.</span><button class="btn small solid" id="sweep" ${state.busy ? "disabled" : ""}>${state.busy === "Sweeping…" ? "Sweeping…" : "Move it to my vault now"}</button></div>` : ""}</div>
  <div class="panel"><div class="ph"><h3>On-chain limits</h3><span class="sub">signed by your browser key</span></div><div class="pb">
    <label class="field"><span>Daily limit for all agents</span><div class="money"><span>$</span><input id="newlimit" inputmode="decimal" value="${(Number(v.daily_limit) / 1e6).toFixed(2)}"></div></label>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn solid small" id="savelimit">Save limit</button><button class="btn small" id="pause">${v.paused ? "Resume spending" : "Pause all spending"}</button><button class="btn small ghost" id="recovery">Download recovery file</button></div>
  </div></div>`);
}

function keysView() {
  if (state.me!.wallet.status !== "ready") return consoleWrap("keys", `<p class="muted">Set up your wallet first.</p><div style="margin-top:12px"><button class="btn accent" data-go="wallet">Set up wallet</button></div>`);
  const live = state.listings.filter((l) => l.routable || l.review_status !== "pending");
  return consoleWrap("keys", `${state.newSecret ? `<div class="secret" role="status"><h3>Copy your new key now</h3><p class="sub" style="color:inherit">BFA shows it once. Store it as BFA_API_KEY where your agent runs.</p>
      <div class="val"><code id="secretval">${esc(state.newSecret)}</code><button class="btn small solid" data-copy="secretval">Copy</button><button class="btn small" id="dismiss">I saved it</button></div>
      <pre id="secretcfg">claude mcp add --transport http bfa ${esc(MCP_URL)} \\
  --header "Authorization: Bearer ${esc(state.newSecret)}"</pre></div>` : ""}
  ${state.keyForm ? `<div class="panel" id="keyform"><div class="ph"><h3>New API key</h3><button class="btn small ghost" id="cancelkey">Cancel</button></div><div class="pb">
    <div class="grid2"><label class="field"><span>Name</span><input class="input" id="kname" placeholder="research-agent"></label>
      <label class="field"><span>Expires in (days)</span><input class="input" id="kdays" inputmode="numeric" value="30"></label></div>
    <label class="field"><span>Daily limit, all APIs</span><div class="money"><span>$</span><input id="kdaily" inputmode="decimal" value="0.50"></div><small>Also capped by your vault's on-chain limit.</small></label>
    <div class="grid2"><label class="field"><span>Per-API limit (optional)</span><select id="lapi"><option value="">none</option>${state.listings.map((l) => `<option value="${esc(l.id)}">${esc(l.id)}</option>`).join("")}</select></label>
      <label class="field"><span>Calls per day</span><input class="input" id="lcalls" inputmode="numeric" placeholder="200"></label></div>
    <div class="field"><span>APIs this key can call</span><select id="amode"><option value="all">All reviewed APIs</option><option value="allow">Only these (allowlist)</option><option value="block">All except these (blocklist)</option></select>
      <div class="picklist">${live.map((l) => `<label><input type="checkbox" data-aid="${esc(l.id)}"><span class="mono">${esc(l.id)}</span></label>`).join("")}</div></div>
    <div class="scopes"><label><input type="checkbox" data-scope="run" checked><span><code>run</code> · pay for calls within the limits</span></label><label><input type="checkbox" data-scope="receipts" checked><span><code>receipts</code> · read this key's receipts and spend</span></label></div>
  </div><div class="pf"><button class="btn solid" id="createkey" ${state.busy ? "disabled" : ""}>Create key</button></div></div>` :
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap"><p class="muted">Each key has its own expiry, limits and allowed APIs.</p><button class="btn accent" id="newkey">Create API key</button></div>`}
  <div class="tbox"><table style="min-width:760px"><thead><tr><th>Key</th><th>Expires</th><th>Daily limit</th><th>Per-API</th><th>APIs</th><th>Status</th><th></th></tr></thead><tbody>
  ${state.keys.map((k) => { const expired = Date.parse(k.expires_at) <= Date.now(); return `<tr><td><b style="font-weight:600">${esc(k.name)}</b><div class="tid">${esc(k.prefix)}…</div></td><td class="sub">${esc(k.expires_at.slice(0, 10))}</td><td class="mono">$${esc(k.daily_limit_usd)}</td>
    <td class="sub">${k.per_api_limits.map((l) => `${esc(l.listing_id.split("/")[1])}: ${esc(l.value)} ${l.kind === "calls" ? "calls" : "USD"}`).join("<br>") || "none"}</td>
    <td class="sub">${k.listing_access.mode === "all" ? "All reviewed" : `${k.listing_access.mode === "allow" ? "Only" : "All except"} ${k.listing_access.listing_ids.map(esc).join(", ")}`}</td>
    <td>${k.revoked_at ? '<span class="pill bad">Revoked</span>' : expired ? '<span class="pill plain">Expired</span>' : '<span class="pill ok">Active</span>'}</td>
    <td class="r">${!k.revoked_at && !expired ? `<button class="btn small ghost" data-revoke="${esc(k.id)}">Revoke</button>` : ""}</td></tr>`; }).join("") || `<tr><td colspan="7" class="sub">No keys yet.</td></tr>`}
  </tbody></table></div>`);
}

function receiptsTable(n: number) {
  const rows = state.receipts.slice(0, n);
  return `<div class="tbox"><table style="min-width:680px"><thead><tr><th>Time (UTC)</th><th>API</th><th>Status</th><th class="r">Charged</th><th class="r">Latency</th><th>Settlement</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td class="tid">${esc(r.started_at.slice(5, 19).replace("T", " "))}</td><td class="tid">${esc(r.listing_id)}</td><td><span class="pill ${r.status.startsWith("paid") ? "ok" : "plain"}">${esc(r.status)}</span></td><td class="r mono">$${esc(r.price_usd)}</td><td class="r sub">${r.latency_ms ?? "—"} ms</td>
    <td class="tid">${r.payment_tx ? `<a href="https://sepolia.basescan.org/tx/${esc(r.payment_tx)}">deposit ${esc(short(r.payment_tx))}</a>` : r.scheme === "batch-settlement" ? "voucher" : "—"}</td></tr>`).join("") || `<tr><td colspan="6" class="sub">No calls yet. Connect an agent and ask it for data.</td></tr>`}
  </tbody></table></div>`;
}

const usage = () => consoleWrap("usage", receiptsTable(200));

const VIEWS: Record<string, () => string> = { home, apis, agents, signin, overview, wallet: walletView, keys: keysView, usage };

// ---------- router ----------
function current(): string {
  const h = location.hash.slice(1);
  let v = VIEWS[h] ? h : "home";
  if (CONSOLE.includes(v) && !state.me) v = "signin";
  if (v === "signin" && state.me) v = "overview";
  return v;
}

function render() {
  const v = current();
  $("#app")!.innerHTML = `<div class="view">${VIEWS[v]!()}</div>`;
  document.querySelectorAll<HTMLAnchorElement>(".navlinks a[data-go]").forEach((a) => (a.dataset.go === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  const ab = $("#authbtn")!;
  ab.textContent = state.me ? "Console" : "Sign in";
  ab.dataset.go = state.me ? "overview" : "signin";
  $("#net")!.textContent = (state.cfg?.network ?? "testnet").toUpperCase();
  if (v === "signin" && state.cfg?.google_client_id && typeof google !== "undefined") {
    google.accounts.id.initialize({ client_id: state.cfg.google_client_id, callback: onGoogle });
    google.accounts.id.renderButton($("#gbtn"), { theme: "filled_black", size: "large", text: "continue_with", shape: "pill", width: 320 });
  }
}

function go(v: string) {
  state.err = null;
  if (location.hash.slice(1) !== v) location.hash = v;
  else render();
}

window.addEventListener("hashchange", () => {
  render();
  window.scrollTo(0, 0);
});

// ---------- data ----------
async function refresh() {
  try {
    state.me = await api<Me>("GET", "/api/me");
  } catch {
    state.me = null;
  }
  if (state.me) {
    const [k, r] = await Promise.all([api<{ keys: Key[] }>("GET", "/api/keys"), api<{ receipts: Receipt[] }>("GET", "/api/receipts")]);
    state.keys = k.keys.reverse();
    state.receipts = r.receipts;
  }
  render();
}

async function onGoogle(resp: { credential: string }) {
  try {
    await api("POST", "/api/auth/google", { credential: resp.credential });
    await refresh();
    go("overview");
  } catch (e) {
    state.err = (e as Error).message;
    render();
  }
}

function log(line: string) {
  state.setupLog.push(line);
  render();
}

async function runSetup() {
  const email = state.me!.user.email;
  const w = state.me!.wallet;
  const cfg = state.cfg!;
  state.busy = "Working…";
  state.err = null;
  state.setupLog = [];
  try {
    let k = loadKey(email);
    if (!k || (w.near_account_id && k.account_id !== w.near_account_id)) {
      if (w.near_account_id) throw new Error("load your recovery file first");
      k = newKey();
      log("✓ created a NEAR key in this browser");
      download(recoveryBlob(email, k), "bfa-recovery-key.json");
      log("✓ downloaded bfa-recovery-key.json: keep it offline");
    }
    const limit = atomic(($("#vlimit") as HTMLInputElement | null)?.value ?? (Number(w.vault?.daily_limit ?? 1_000_000) / 1e6).toFixed(2));
    const start = await api<{ near_account_id: string; agent_public_key: string; treasury_id: string; agent_allowance_yocto: string; sponsor_tx: string | null }>("POST", "/api/wallet/start", { public_key: k.public_key });
    k.account_id = start.near_account_id;
    saveKey(email, k);
    log(`✓ NEAR account ${short(start.near_account_id)}${start.sponsor_tx ? " created and funded by BFA" : ""}`);
    state.busy = "Waiting for your account…";
    await waitForAccount(k);
    const me = await api<Me>("GET", "/api/me");
    if (!me.wallet.vault) {
      state.busy = "Creating your vault…";
      render();
      await createVault(k, start.treasury_id, limit);
      log(`✓ you signed create_vault with a ${usd(limit)} daily limit`);
    }
    state.busy = "Adding the agent key…";
    render();
    try {
      await addAgentKey(k, start.agent_public_key, start.treasury_id, start.agent_allowance_yocto ?? cfg.agent_allowance_yocto);
      log("✓ you gave BFA's gateway a key limited to sign_eip3009");
    } catch (e) {
      if (!/already exists/i.test((e as Error).message)) throw e;
      log("✓ agent key already present");
    }
    await api("POST", "/api/wallet/confirm", {});
    log("✓ wallet ready");
    toast("Wallet ready");
    await refresh();
  } catch (e) {
    state.err = (e as Error).message;
  } finally {
    state.busy = null;
    render();
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function keyOrThrow(): StoredKey {
  const k = loadKey(state.me!.user.email);
  if (!k || k.account_id !== state.me!.wallet.near_account_id) throw new Error("this browser doesn't have your wallet key; load your recovery file on the Wallet page");
  return k;
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("button, a");
  if (!t) return;
  if (t.id === "signout") {
    e.preventDefault();
    await api("POST", "/api/auth/logout", {});
    state.me = null;
    go("home");
    return;
  }
  if (t.dataset.go) {
    e.preventDefault();
    go(t.dataset.go);
    return;
  }
  if (t.dataset.copy) {
    const el = document.getElementById(t.dataset.copy);
    if (el) navigator.clipboard?.writeText(el.textContent ?? "").then(() => toast("Copied"), () => toast("Select the text and copy it"));
    return;
  }
  try {
    if (t.id === "devlogin") {
      await api("POST", "/api/auth/dev", { email: ($("#devemail") as HTMLInputElement).value });
      await refresh();
      go("overview");
    } else if (t.id === "setup") {
      await runSetup();
    } else if (t.id === "newkey") {
      state.keyForm = true;
      state.newSecret = null;
      render();
    } else if (t.id === "cancelkey") {
      state.keyForm = false;
      render();
    } else if (t.id === "dismiss") {
      state.newSecret = null;
      render();
    } else if (t.id === "createkey") {
      const mode = ($("#amode") as HTMLSelectElement).value;
      const ids = [...document.querySelectorAll<HTMLInputElement>("[data-aid]")].filter((c) => c.checked).map((c) => c.dataset.aid!);
      const lapi = ($("#lapi") as HTMLSelectElement).value;
      const lcalls = ($("#lcalls") as HTMLInputElement).value.trim();
      const r = await api<{ secret: string }>("POST", "/api/keys", {
        name: ($("#kname") as HTMLInputElement).value.trim(),
        expires_days: Number(($("#kdays") as HTMLInputElement).value),
        daily_limit_usd: ($("#kdaily") as HTMLInputElement).value.trim(),
        per_api_limits: lapi && lcalls ? [{ listing_id: lapi, kind: "calls", value: Number(lcalls) }] : [],
        scopes: [...document.querySelectorAll<HTMLInputElement>("[data-scope]")].filter((c) => c.checked).map((c) => c.dataset.scope),
        listing_access: mode === "all" ? { mode: "all", listing_ids: [] } : { mode, listing_ids: ids },
      });
      state.newSecret = r.secret;
      state.keyForm = false;
      await refresh();
    } else if (t.dataset.revoke) {
      await api("POST", `/api/keys/${t.dataset.revoke}/revoke`, {});
      toast("Key revoked. Calls with it now fail with key_revoked.");
      await refresh();
    } else if (t.id === "savelimit") {
      state.busy = "Signing…";
      const v = state.me!.wallet.vault!;
      await setDailyLimit(keyOrThrow(), state.me!.wallet.treasury_id!, atomic(($("#newlimit") as HTMLInputElement).value), v.allowed_to);
      toast("Daily limit saved on-chain");
      await refresh();
    } else if (t.id === "pause") {
      await pauseVault(keyOrThrow(), state.me!.wallet.treasury_id!, !state.me!.wallet.vault!.paused);
      toast(state.me!.wallet.vault!.paused ? "Spending resumed" : "All spending paused");
      await refresh();
    } else if (t.id === "sweep") {
      state.busy = "Sweeping…";
      render();
      const r = await api<{ swept: boolean; message?: string; received_atomic?: string }>("POST", "/api/wallet/sweep", {});
      state.busy = null;
      toast(r.swept ? `Moved ${usd(r.received_atomic!)} received; your vault is updated` : r.message ?? "Nothing to move yet");
      await refresh();
    } else if (t.id === "recovery") {
      download(recoveryBlob(state.me!.user.email, keyOrThrow()), "bfa-recovery-key.json");
    }
  } catch (err) {
    state.err = (err as Error).message;
    state.busy = null;
    render();
  }
});

document.addEventListener("change", async (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id !== "restore" || !t.files?.[0]) return;
  try {
    const k = parseRecovery(await t.files[0].text());
    if (k.account_id && k.account_id !== state.me!.wallet.near_account_id) throw new Error("this recovery file belongs to a different wallet");
    saveKey(state.me!.user.email, { ...k, account_id: state.me!.wallet.near_account_id! });
    toast("Recovery key loaded");
    render();
  } catch (err) {
    state.err = (err as Error).message;
    render();
  }
});

// ---------- boot ----------
(async () => {
  state.cfg = await api<Config>("GET", "/api/config");
  api<{ listings: Listing[] }>("GET", "/api/listings").then((l) => {
    state.listings = l.listings;
    render();
  });
  await refresh();
})();

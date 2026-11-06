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
type Listing = { id: string; name: string; provider: string; categories: string[]; price_usd: string; charges_empty_results: boolean; networks?: string[]; routable: boolean; review_status: string; not_routable_reason: string | null; description?: string; example_input?: Record<string, unknown> };
type Routing = { prefer: string[]; strict: boolean };
type Key = { id: string; name: string; prefix: string; routing?: Routing; created_at: string; expires_at: string; revoked_at: string | null; daily_limit_usd: string; per_api_limits: { listing_id: string; kind: string; value: string | number }[]; scopes: string[]; listing_access: { mode: string; listing_ids: string[] } };
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
  routeEdit: string | null; routeDraft: Routing; basket: Line[]; budget: string; keyMore: boolean;
} = { listings: [], keys: [], receipts: [], newSecret: null, busy: null, err: null, setupLog: [], keyForm: false, routeEdit: null, routeDraft: { prefer: [], strict: false }, basket: [], budget: "", keyMore: false };

// ---------- basket (kept in this browser only) ----------
type Line = { id: string; n: number };
const BASKET = "bfa.basket";
function loadBasket(): Line[] {
  try {
    const b = JSON.parse(localStorage.getItem(BASKET) ?? "[]") as Line[];
    return Array.isArray(b) ? b.filter((l) => typeof l.id === "string" && Number.isInteger(l.n) && l.n > 0).slice(0, 20) : [];
  } catch {
    return [];
  }
}
function saveBasket() {
  try {
    localStorage.setItem(BASKET, JSON.stringify(state.basket));
  } catch {
    /* private mode: the basket lives until reload */
  }
}
const lineCount = () => state.basket.reduce((a, l) => a + l.n, 0);

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
const usdFine = (atomic: string | bigint | null | undefined) => {
  if (atomic == null) return "—";
  const s = (Number(BigInt(atomic)) / 1e6).toFixed(6).replace(/0{1,4}$/, "");
  return `$${s}`;
};
const pct = (a: string, b: string) => Math.min(100, (Number(a) / Math.max(1, Number(b))) * 100);
const routeLabel = (p: string) => (p.startsWith("provider:") ? `any API from <b>${esc(p.slice(9))}</b>` : `<span class="mono">${esc(p)}</span>`);

function home() {
  const net = state.cfg?.network ?? "testnet";
  const menu = state.listings.slice(0, 6);
  return `<section class="hero">
    <div class="hero-copy">
      <h1>The convenience store for <em>AI agents.</em><span class="sm">Open 24 hours, for every agent.</span></h1>
      <p class="lede">Your agent walks in, finds the API it needs, reads the price on the tag, pays for one call and leaves with a receipt. You give it a key with a budget; your money stays in your own vault on NEAR.</p>
      <div class="cta"><button class="btn accent" data-go="${state.me ? "overview" : "signin"}">${state.me ? "Open your dashboard" : "Sign in with Google"}</button><button class="btn" data-go="apis">Walk the aisles</button></div>
    </div>
    <div class="slab"><img class="big-guy" src="/guide.svg" width="220" height="234" alt="Nibs, the BFA guide"><div class="rcpt">
      <div class="receipt" aria-label="Example receipt">
        <div class="rh"><b>bfa</b><span>open 24h · ${esc(net)}</span></div>
        <dl>
          <dt>1 × near-account</dt><dd>$0.001000</dd>
          <dt>key</dt><dd>research-agent</dd>
          <dt>left today</dt><dd>$0.497000</dd>
          <dt>paid from</dt><dd>your vault</dd>
          <dt>signed by</dt><dd>NEAR Chain Signatures</dd>
        </dl>
        <div class="tot"><span>TOTAL</span><span>$0.001000</span></div>
        <p class="ft">empty or failed call? you pay $0<br>thank you, come again</p>
      </div>
    </div></div>
  </section>
  <section class="points">
    <div><h3>Your key, your vault.</h3><p>The wallet key is made in your browser and never sent to us. USDC sits in a vault only that key can change.</p></div>
    <div><h3>A limit on every key.</h3><p>Expiry, a daily cap, caps per API, an allowlist, and which provider to try first. All checked before anything is paid.</p></div>
    <div><h3>1.5% on top. That's it.</h3><p>To add $10.00 you send $10.15. A public contract splits it, so the fee can't change behind your back.</p></div>
  </section>
  <section class="menu">
    <div class="mh"><h2>On the shelves</h2><p>Live from this gateway's registry. Every API has its price on the tag. Only reviewed ones take payment; anyone can stock one by pull request.</p><button class="btn small" data-go="apis">Walk the aisles</button></div>
    <ul class="leaders">${menu.map((l) => `<li><span class="nm">${esc(l.name)}<small>${esc(l.id)}</small></span><i></i><b>$${esc(l.price_usd)}</b><span class="st">${l.routable ? "in stock" : "coming soon"}</span></li>`).join("") || `<li><span class="nm muted">Stocking the shelves…</span></li>`}</ul>
  </section>
  <section class="band">
    <div><h2>One line for Claude Code.</h2><p>Any MCP client works the same way: point it at the endpoint and send your key as a Bearer token.</p><button class="btn small" data-go="agents">Other agents</button></div>
    <pre>claude mcp add --transport http bfa ${esc(MCP_URL)} \\
  --header "Authorization: Bearer $BFA_API_KEY"</pre>
  </section>`;
}

const AISLE: Record<string, string> = { "onchain-data": "Onchain data", "market-data": "Markets", social: "Social", web: "Web & search", company: "Companies", "ai-inference": "AI models", "near-native": "NEAR", other: "Everything else" };
const aisleName = (c: string) => AISLE[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
const onTestnet = (l: Listing) => !l.networks || l.networks.some((n) => n === "eip155:84532");

function shelfItem(l: Listing) {
  const inBasket = state.basket.find((x) => x.id === l.id)?.n ?? 0;
  const stock = l.routable ? (state.cfg?.network === "testnet" && !onTestnet(l) ? "mainnet only" : "in stock") : l.review_status === "pending" ? "coming soon" : esc(l.review_status);
  const buyable = l.routable && !(state.cfg?.network === "testnet" && !onTestnet(l));
  return `<article class="item">
    <div class="box"><b>${esc(l.name)}</b><span class="tid">${esc(l.id)}</span>${l.description ? `<p>${esc(l.description)}</p>` : `<p>${esc(l.provider)}</p>`}</div>
    <div class="tag${buyable ? "" : " off"}"><span class="p">$${esc(l.price_usd)}<small>/call</small></span><span class="s">${stock}${l.charges_empty_results ? "" : "<br>empty = free"}</span></div>
    <button class="btn small ${inBasket ? "solid" : "ghost"}" data-add="${esc(l.id)}" ${buyable ? "" : "disabled"}>${!buyable ? (l.routable ? "Mainnet only" : "Coming soon") : inBasket ? `In basket (${inBasket}) · add one` : "Add to basket"}</button>
  </article>`;
}

function basketPanel() {
  const lines = state.basket.map((x) => ({ x, l: state.listings.find((l) => l.id === x.id) })).filter((r) => r.l);
  if (!lines.length) return `<aside class="basket" aria-label="Basket"><h3>Basket <span>0 items</span></h3><p class="empty-b">Add a few APIs to see what a task would cost. BFA gives your agent a cart tool that quotes the whole basket first, then pays once within your budget.</p></aside>`;
  let total = 0n;
  for (const r of lines) total += BigInt(atomic(r.l!.price_usd)) * BigInt(r.x.n);
  const budget = state.budget || (Number(total) / 1e6).toFixed(Math.max(2, (Number(total) / 1e6).toString().split(".")[1]?.length ?? 2));
  const prompt = `Use BFA's cart tool. Put these calls in a basket and show me the itemized total first:\n${lines.map((r, i) => `${i + 1}. ${r.l!.id} × ${r.x.n} ($${r.l!.price_usd} each)`).join("\n")}\nCheck out only if the total is at most $${budget}. Fill in each call's input for my task.`;
  return `<aside class="basket" aria-label="Basket"><h3>Basket <span>${lineCount()} item${lineCount() === 1 ? "" : "s"}</span></h3>
    <ul>${lines.map((r) => `<li><span><b style="font-weight:600">${esc(r.l!.name)}</b><br><span class="tid">$${esc(r.l!.price_usd)} each</span></span>
      <span class="q"><button data-dec="${esc(r.x.id)}" aria-label="One less">−</button>${r.x.n}<button data-add="${esc(r.x.id)}" aria-label="One more">+</button></span></li>`).join("")}</ul>
    <div class="sum"><span>Total</span><span>${usdFine(total)}</span></div>
    <label class="field"><span>Your agent's budget for this</span><div class="money"><span>$</span><input id="budget" inputmode="decimal" value="${esc(budget)}"></div></label>
    <div class="stack"><span class="label">Tell your agent</span><pre id="bprompt">${esc(prompt)}</pre><button class="btn small solid" data-copy="bprompt">Copy prompt</button></div>
    <button class="btn link" id="emptybasket">Empty the basket</button>
  </aside>`;
}

function apis() {
  const groups = new Map<string, Listing[]>();
  for (const l of state.listings) {
    const c = l.categories?.[0] ?? "other";
    groups.set(c, [...(groups.get(c) ?? []), l]);
  }
  const aisles = [...groups].sort((a, b) => b[1].filter((l) => l.routable).length - a[1].filter((l) => l.routable).length || a[0].localeCompare(b[0]));
  return `<div class="page-head"><div><h1>The aisles</h1>
    <p>Everything your agent can buy here, with the price on the tag. Live from this gateway's registry: only reviewed APIs take payment, the rest are coming soon.</p></div></div>
  <div class="store"><div>${aisles.map(([c, ls], i) => `<section class="aisle"><h2>${esc(aisleName(c))} <small>aisle ${i + 1}</small></h2><div class="shelf">${ls.map(shelfItem).join("")}</div></section>`).join("") || `<p class="muted">Stocking the shelves…</p>`}</div>
  ${basketPanel()}</div>`;
}

function agents() {
  return `<div class="page-head"><div><h1>Paste one config, then ask for data</h1>
    <p>Create a key in the console first. The agent sends it as a Bearer token; it never sees your Google account or your wallet key.</p></div></div>
  <div class="grid2"><div class="stack">
    <h3>Claude Code</h3>
    <pre id="cfg1">claude mcp add --transport http bfa ${esc(MCP_URL)} \\
  --header "Authorization: Bearer $BFA_API_KEY"</pre><div><button class="btn small ghost" data-copy="cfg1">Copy</button></div>
    <h3>Any MCP client</h3>
    <pre id="cfg2">{ "mcpServers": { "bfa": { "type": "http",
  "url": "${esc(MCP_URL)}",
  "headers": { "Authorization": "Bearer \${BFA_API_KEY}" } } } }</pre><div><button class="btn small ghost" data-copy="cfg2">Copy</button></div>
  </div><div class="stack"><h3>Then try this prompt</h3>
    <pre id="prompt">Use BFA to check the NEAR testnet account
nen-testnet.testnet. Inspect the price first,
and don't spend more than $0.01.</pre><div><button class="btn small ghost" data-copy="prompt">Copy prompt</button></div>
    <div style="margin-top:12px"><button class="btn accent" data-go="${state.me ? "keys" : "signin"}">${state.me ? "Create a key" : "Sign in to create a key"}</button></div></div></div>`;
}

function signin() {
  const c = state.cfg;
  return `<div class="signin">
    <div class="bb"><img src="/guide.svg" width="160" height="170" alt=""><p>Hi, I'm Nibs. I'll show you around.</p></div>
    <div class="form"><h2>Sign in</h2><p class="muted">New here? Signing in creates your account. We only see your email and name.</p>
    ${c?.google_client_id ? `<div class="gwrap"><div id="gbtn"></div></div>` : `<p class="sub">Google sign-in is not configured on this gateway yet.</p>`}
    ${c?.dev_login ? `<div class="or">or, for local testing</div><label class="field"><span>Email (dev sign-in)</span><input class="input" id="devemail" type="email" placeholder="you@example.com"></label><button class="btn gbtn" id="devlogin">Sign in without Google</button>` : ""}
    ${state.err ? `<p class="sub" style="color:var(--bad)">${esc(state.err)}</p>` : ""}
    </div></div>`;
}

function consoleWrap(cur: string, body: string) {
  const titles: Record<string, string> = { overview: "Overview", wallet: "Wallet", keys: "API keys", usage: "Usage" };
  const w = state.me!.wallet;
  return `<div class="console"><nav class="rail" aria-label="Console">
    <div class="who"><b>${esc(state.me!.user.name ?? state.me!.user.email)}</b><span>${w.near_account_id ? `NEAR ${esc(short(w.near_account_id))}` : "no wallet yet"}</span></div>
    ${CONSOLE.map((v) => `<a href="#${v}" data-go="${v}" ${v === cur ? 'aria-current="page"' : ""}>${titles[v]}${v === "keys" ? `<span class="sub">${state.keys.filter((k) => !k.revoked_at).length}</span>` : ""}</a>`).join("")}
    <a href="#home" id="signout">Sign out</a></nav>
    <div style="min-width:0"><h1>${titles[cur]}</h1>${state.err ? `<div class="preview-note">${esc(state.err)}</div>` : ""}${body}</div></div>`;
}

function notReady(cur: string, what: string) {
  return consoleWrap(cur, `<div class="empty"><h3>Set up your wallet first</h3><p>${what}</p><button class="btn accent" data-go="wallet">Set up wallet</button></div>`);
}

function statement(w: Wallet, v: Vault, mode: "overview" | "wallet") {
  const active = state.keys.filter((k) => !k.revoked_at && Date.parse(k.expires_at) > Date.now()).length;
  const p = pct(v.spent_today, v.daily_limit);
  return `<section class="statement">
    <div><span class="label">In your vault</span><b class="big">${usd(w.usdc_balance_atomic)}<small>USDC</small></b><p class="sub">On Base, controlled by your NEAR account. BFA can't move it.</p></div>
    <dl class="facts">
      <div><dt>Spent today</dt><dd>${usdFine(v.spent_today)} of ${usd(v.daily_limit)}${v.paused ? " · paused" : ""}</dd><div class="bar${p > 85 ? " hot" : ""}"><i style="width:${p}%"></i></div></div>
      ${mode === "overview" ? `<div><dt>Active keys</dt><dd>${active}</dd></div>` : `<div><dt>Vault address (Base)</dt><dd>${esc(w.vault_address)}</dd></div>`}
      <div><dt>NEAR account</dt><dd>${esc(short(w.near_account_id ?? ""))}</dd></div>
    </dl></section>`;
}

function overview() {
  const w = state.me!.wallet;
  if (w.status !== "ready") return notReady("overview", "It takes about 30 seconds: your browser makes a NEAR key, BFA creates the account, and you sign two transactions.");
  return consoleWrap("overview", `${statement(w, w.vault!, "overview")}
  <div class="section"><div class="hd"><h3>Recent calls</h3><button class="btn link" data-go="usage">All usage</button></div>${receiptsTable(5)}</div>
  <div class="actions"><button class="btn accent" data-go="keys">Create API key</button><button class="btn" data-go="wallet">Top up</button><button class="btn" data-go="agents">Connect an agent</button></div>`);
}

function setupPanel() {
  const w = state.me!.wallet;
  const local = loadKey(state.me!.user.email);
  const needRestore = w.near_account_id && (!local || local.account_id !== w.near_account_id);
  return `<div class="panel"><div class="ph"><h3>Set up your wallet</h3><span class="sub">about 30 seconds</span></div><div class="pb">
    <ol class="steps">
      <li><span><b>Your browser makes a NEAR key.</b> <span class="muted">It stays in this browser.</span></span></li>
      <li><span><b>BFA creates your NEAR account</b> <span class="muted">and pays its testnet setup costs.</span></span></li>
      <li><span><b>You sign two transactions:</b> <span class="muted">your vault with its daily limit, and a gateway key that can only call <span class="mono">sign_eip3009</span>.</span></span></li>
    </ol>
    ${needRestore ? `<label class="field"><span>This account's key isn't in this browser</span><input type="file" id="restore" accept="application/json"><small>Load the recovery file you saved, or sign in from the browser you set it up in.</small></label>` :
      `<label class="field"><span>Vault daily limit</span><div class="money"><span>$</span><input id="vlimit" inputmode="decimal" value="1.00"></div><small>The most all your agents together can spend per day. The treasury contract enforces it; only your browser key can change it.</small></label>`}
    ${state.setupLog.length ? `<ul class="log">${state.setupLog.map((l) => `<li class="${l.startsWith("✗") ? "bad" : ""}">${esc(l)}</li>`).join("")}</ul>` : ""}
  </div><div class="pf"><button class="btn accent" id="setup" ${state.busy ? "disabled" : ""}>${state.busy ? esc(state.busy) : needRestore ? "Continue setup" : state.setupLog.some((l) => l.startsWith("✗")) ? "Try again" : "Create my wallet"}</button></div></div>`;
}

function walletView() {
  const w = state.me!.wallet;
  if (w.status !== "ready") return consoleWrap("wallet", setupPanel());
  const v = w.vault!;
  return consoleWrap("wallet", `${statement(w, v, "wallet")}
  <div class="panel"><div class="ph"><h3>Top up</h3><span class="sub">USDC on Base${state.cfg?.network === "testnet" ? " Sepolia" : ""} · 1.5% on top</span></div><div class="pb">
    ${w.top_up_address ? `<div class="field"><span>Your top-up address</span><div class="addr"><code id="dep">${esc(w.top_up_address)}</code><button class="btn small ghost" data-copy="dep">Copy</button></div>
      <small>Send USDC only. A public contract splits each deposit: to add $10.00 send $10.15, and $10.00 goes to your vault, $0.15 to BFA. Nobody, BFA included, can send it anywhere else.</small></div>` : `<p class="sub">Top-up contract not configured on this gateway.</p>`}
    ${state.cfg?.network === "testnet" ? `<p class="sub">Test USDC: <a href="https://faucet.circle.com">faucet.circle.com</a>, pick Base Sepolia.</p>` : ""}
  </div>${w.top_up_address ? `<div class="pf"><button class="btn small solid" id="sweep" ${state.busy ? "disabled" : ""}>${state.busy === "Sweeping…" ? "Sweeping…" : "Move it to my vault now"}</button><span class="sub">BFA also does this on its own within a minute or two.</span></div>` : ""}</div>
  <div class="panel"><div class="ph"><h3>Limits</h3><span class="sub">signed by your browser key, enforced on NEAR</span></div><div class="pb">
    <label class="field"><span>Daily limit for all agents</span><div class="money"><span>$</span><input id="newlimit" inputmode="decimal" value="${(Number(v.daily_limit) / 1e6).toFixed(2)}"></div></label>
  </div><div class="pf"><button class="btn solid small" id="savelimit">Save limit</button><button class="btn small" id="pause">${v.paused ? "Resume spending" : "Pause all spending"}</button><button class="btn link" id="recovery">Download a copy of the wallet key</button></div></div>`);
}

function routeEditor() {
  const d = state.routeDraft;
  const providers = [...new Set(state.listings.map((l) => l.provider))].filter((p) => !d.prefer.includes(`provider:${p}`));
  const ids = state.listings.map((l) => l.id).filter((id) => !d.prefer.includes(id));
  return `<div class="route">
    ${d.prefer.length ? `<ol class="route-list">${d.prefer.map((p, i) => `<li><span class="n">${i + 1}</span><span class="what">${routeLabel(p)}</span>
      <span class="ops"><button class="btn small ghost" data-rup="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button><button class="btn small ghost" data-rdel="${i}">Remove</button></span></li>`).join("")}</ol>`
      : `<p class="sub">No order set: BFA picks the most reliable, cheapest one.</p>`}
    <div class="route-add"><select id="radd" aria-label="Add a provider or API"><option value="">Add a provider or API…</option>
      ${providers.length ? `<optgroup label="Providers">${providers.map((p) => `<option value="provider:${esc(p)}">${esc(p)}</option>`).join("")}</optgroup>` : ""}
      ${ids.length ? `<optgroup label="APIs">${ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("")}</optgroup>` : ""}</select>
      <input class="input" id="rcustom" placeholder="or type a provider, e.g. Gemini"><button class="btn small" id="raddbtn">Add</button></div>
    <label class="check"><input type="checkbox" id="rstrict" ${d.strict ? "checked" : ""}><span>Never use other providers when one of these can do the job.</span></label>
  </div>`;
}

function keysView() {
  if (state.me!.wallet.status !== "ready") return notReady("keys", "Keys pay from your vault, so the vault has to exist first.");
  const live = state.listings.filter((l) => l.routable || l.review_status !== "pending");
  const editing = state.routeEdit ? state.keys.find((k) => k.id === state.routeEdit) : undefined;
  return consoleWrap("keys", `${state.newSecret ? `<div class="secret" role="status"><h3>Copy your new key now</h3><p class="sub">BFA shows it once. Store it as BFA_API_KEY where your agent runs.</p>
      <div class="val"><code id="secretval">${esc(state.newSecret)}</code><button class="btn small solid" data-copy="secretval">Copy</button><button class="btn small" id="dismiss">I saved it</button></div>
      <pre id="secretcfg">claude mcp add --transport http bfa ${esc(MCP_URL)} \\
  --header "Authorization: Bearer ${esc(state.newSecret)}"</pre></div>` : ""}
  ${editing ? `<div class="panel" id="routeform"><div class="ph"><h3>Provider order for ${esc(editing.name)}</h3><span class="sub">tried first, top to bottom</span></div><div class="pb">${routeEditor()}</div>
    <div class="pf"><button class="btn solid" id="saveroute">Save</button><button class="btn ghost" id="cancelroute">Cancel</button></div></div>` : ""}
  ${state.keyForm ? `<div class="panel" id="keyform"><div class="ph"><h3>New API key</h3><button class="btn link" id="cancelkey">Cancel</button></div><div class="pb">
    <div class="grid2"><label class="field"><span>Name</span><input class="input" id="kname" placeholder="research-agent"><small>One key per agent, so you can stop each one on its own.</small></label>
      <label class="field"><span>Daily limit</span><div class="money"><span>$</span><input id="kdaily" inputmode="decimal" value="0.50"></div><small>The most this agent can spend per day.</small></label></div>
    <details id="kmore" ${state.keyMore ? "open" : ""}><summary class="btn link">More options</summary><div class="pb" style="padding-top:18px">
      <label class="field"><span>Expires in (days)</span><input class="input" id="kdays" inputmode="numeric" value="30" style="max-width:12rem"></label>
      <div class="field"><span>Which provider to try first</span><small>For example Gemini before Wan. Leave empty and BFA picks the most reliable, cheapest one.</small>${routeEditor()}</div>
      <div class="field"><span>APIs this key can call</span><select id="amode"><option value="all">All reviewed APIs</option><option value="allow">Only these</option><option value="block">All except these</option></select>
        <div class="picklist">${live.map((l) => `<label><input type="checkbox" data-aid="${esc(l.id)}"><span class="mono">${esc(l.id)}</span></label>`).join("")}</div></div>
      <div class="grid2"><label class="field"><span>Cap one API (optional)</span><select id="lapi"><option value="">none</option>${state.listings.map((l) => `<option value="${esc(l.id)}">${esc(l.id)}</option>`).join("")}</select></label>
        <label class="field"><span>Calls per day for it</span><input class="input" id="lcalls" inputmode="numeric" placeholder="200"></label></div>
    </div></details>
  </div><div class="pf"><button class="btn solid" id="createkey" ${state.busy ? "disabled" : ""}>Create key</button></div></div>` :
    editing ? "" : `<div class="keys-hd"><p class="muted">${state.keys.length ? "One key per agent. Stop any key at any time." : "No keys yet. Make one per agent, so you can cap and revoke each one on its own."}</p><button class="btn accent" id="newkey">Create API key</button></div>`}
  ${state.keys.length ? `<div class="tbox"><table style="min-width:640px"><thead><tr><th>Key</th><th>Daily limit</th><th>Rules</th><th>Status</th><th></th></tr></thead><tbody>
  ${state.keys.map((k) => { const expired = Date.parse(k.expires_at) <= Date.now(); const usable = !k.revoked_at && !expired; const r = k.routing;
    const rules = [
      r?.prefer.length ? `tries ${r.prefer.map((p) => esc(p.replace(/^provider:/, ""))).join(" → ")} first${r.strict ? ", nothing else" : ""}` : "",
      k.listing_access.mode === "all" ? "" : `${k.listing_access.mode === "allow" ? "only" : "not"} ${k.listing_access.listing_ids.map(esc).join(", ")}`,
      ...k.per_api_limits.map((l) => `${esc(l.listing_id.split("/")[1])}: ${esc(l.value)} ${l.kind === "calls" ? "calls" : "USD"}/day`),
    ].filter(Boolean);
    return `<tr><td><b style="font-weight:600">${esc(k.name)}</b><div class="tid">${esc(k.prefix)}… · until ${esc(k.expires_at.slice(0, 10))}</div></td><td class="mono">$${esc(k.daily_limit_usd)}</td>
    <td class="sub">${rules.join("<br>") || "none"}${usable ? `<div><button class="btn link" data-route="${esc(k.id)}">${r?.prefer.length ? "Change provider order" : "Set provider order"}</button></div>` : ""}</td>
    <td>${k.revoked_at ? '<span class="pill bad">Stopped</span>' : expired ? '<span class="pill plain">Expired</span>' : '<span class="pill ok">Active</span>'}</td>
    <td class="r">${usable ? `<button class="btn small ghost" data-revoke="${esc(k.id)}">Stop key</button>` : ""}</td></tr>`; }).join("")}
  </tbody></table></div>` : ""}`);
}

function receiptsTable(n: number) {
  const rows = state.receipts.slice(0, n);
  if (!rows.length) return `<div class="empty"><p>No calls yet. Connect an agent and ask it for data; each call shows up here with its price and receipt.</p></div>`;
  return `<div class="tbox"><table style="min-width:680px"><thead><tr><th>Time (UTC)</th><th>API</th><th>Status</th><th class="r">Charged</th><th class="r">Latency</th><th>Settlement</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td class="tid">${esc(r.started_at.slice(5, 19).replace("T", " "))}</td><td class="tid">${esc(r.listing_id)}</td><td><span class="pill ${r.status.startsWith("paid") ? "ok" : "plain"}">${esc(r.status.replace("_", " "))}</span></td><td class="r mono">$${esc(r.price_usd)}</td><td class="r sub">${r.latency_ms ?? "—"} ms</td>
    <td class="tid">${r.payment_tx ? `<a href="https://sepolia.basescan.org/tx/${esc(r.payment_tx)}">deposit ${esc(short(r.payment_tx))}</a>` : r.scheme === "batch-settlement" ? "voucher" : "—"}</td></tr>`).join("")}
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

// render() replaces #app wholesale; carry over what the user typed in the key form (the routing editor re-renders it).
type Field = HTMLInputElement | HTMLSelectElement;
const fieldKey = (f: Field) => f.id || (f.dataset.aid ? `aid:${f.dataset.aid}` : f.dataset.scope ? `scope:${f.dataset.scope}` : "");
const TRANSIENT = new Set(["rcustom", "radd", "rstrict"]);
function snapshotKeyForm(): Map<string, string | boolean> | null {
  const form = $("#keyform");
  if (!form) return null;
  const m = new Map<string, string | boolean>();
  form.querySelectorAll<Field>("input, select").forEach((f) => {
    const k = fieldKey(f);
    if (k && !TRANSIENT.has(k)) m.set(k, f instanceof HTMLInputElement && f.type === "checkbox" ? f.checked : f.value);
  });
  return m;
}
function restoreKeyForm(m: Map<string, string | boolean> | null) {
  const form = $("#keyform");
  if (!m || !form) return;
  form.querySelectorAll<Field>("input, select").forEach((f) => {
    const v = m.get(fieldKey(f));
    if (v === undefined) return;
    if (f instanceof HTMLInputElement && f.type === "checkbox") f.checked = v as boolean;
    else f.value = v as string;
  });
}

// ---------- guide ----------
// One tip per page. "Got it" hides that page's tip; "Hide guide" hides them all. Remembered in this browser only.
const GUIDE = "bfa.guide";
function guideState(): { off: boolean; seen: string[] } {
  try {
    const g = JSON.parse(localStorage.getItem(GUIDE) ?? "{}");
    return { off: g.off === true, seen: Array.isArray(g.seen) ? g.seen.filter((x: unknown) => typeof x === "string") : [] };
  } catch {
    return { off: false, seen: [] };
  }
}
function saveGuide(g: { off: boolean; seen: string[] }) {
  try {
    localStorage.setItem(GUIDE, JSON.stringify(g));
  } catch {
    /* private mode: tips come back on reload */
  }
}

function tipFor(v: string): { id: string; text: string } | null {
  const w = state.me?.wallet;
  switch (v) {
    case "home":
      return state.me ? { id: "home-in", text: "You're signed in. Open your dashboard to see your money and keys." } : { id: "home", text: "Hi, I'm Nibs. Sign in with Google and I'll walk you through it. It takes about a minute." };
    case "signin":
      return { id: "signin", text: "Use your Gmail. We only see your email and name, nothing else." };
    case "overview":
    case "wallet":
      if (w?.status !== "ready") return { id: "setup", text: "First, press Create my wallet. Your browser does the signing for you; it takes about 30 seconds." };
      if (v === "wallet") return { id: "wallet", text: "To add money, copy your top-up address and send USDC on Base. On testnet, get free test USDC at faucet.circle.com." };
      return { id: "overview", text: "This is your money and what your agents spent today. Next: make an API key for your agent." };
    case "keys":
      return state.newSecret ? { id: "keys-new", text: "Copy this key now and paste it into your agent's settings. You won't see it again." } : { id: "keys", text: "Make one key per agent. A name and a daily limit are enough; the agent can't spend more than that." };
    case "agents":
      return { id: "agents", text: "Copy the line into your terminal and swap $BFA_API_KEY for your key. Then just ask your agent for data." };
    case "apis":
      return { id: "apis", text: "Add APIs to the basket to see what a task costs, then copy the prompt for your agent." };
    case "usage":
      return { id: "usage", text: "Every call your agents made, with its price. Empty or failed calls cost $0." };
    default:
      return null;
  }
}

function renderGuide(v: string) {
  const el = $("#guide")!;
  const g = guideState();
  const tip = tipFor(v);
  if (!tip || g.off || g.seen.includes(tip.id)) {
    el.innerHTML = `<button class="guide-ask" id="guideon" aria-label="Show tips again" title="Show tips again"><img src="/guide.svg" alt=""></button>`;
    return;
  }
  el.innerHTML = `<div class="guide-card" role="note"><img src="/guide.svg" alt="Nibs" width="80" height="85">
    <div class="bubble"><p>${esc(tip.text)}</p><div class="gb"><button class="btn small solid" id="guidegot" data-tip="${esc(tip.id)}">Got it</button><button class="btn link" id="guideoff">Hide tips</button></div></div></div>`;
}

function render() {
  const v = current();
  const typed = snapshotKeyForm();
  $("#app")!.innerHTML = `<div class="view">${VIEWS[v]!()}</div>`;
  restoreKeyForm(typed);
  renderGuide(v);
  document.querySelectorAll<HTMLAnchorElement>(".navlinks a[data-go]").forEach((a) => (a.dataset.go === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  const ab = $("#authbtn")!;
  ab.textContent = state.me ? "Dashboard" : "Sign in";
  ab.dataset.go = state.me ? "overview" : "signin";
  ab.hidden = v === "signin" || CONSOLE.includes(v);
  $("#net")!.textContent = state.cfg?.network ?? "testnet";
  if (v === "signin" && state.cfg?.google_client_id && typeof google !== "undefined") {
    google.accounts.id.initialize({ client_id: state.cfg.google_client_id, callback: onGoogle });
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const box = $("#gbtn")!.parentElement!;
    google.accounts.id.renderButton($("#gbtn"), {
      theme: dark ? "filled_black" : "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      logo_alignment: "left",
      locale: "en",
      width: Math.min(400, Math.max(220, box.clientWidth)),
    });
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
      saveKey(email, k);
      log("✓ made a NEAR key in this browser");
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
    // Kept in the setup log (not state.err) so it survives switching pages.
    log(`✗ ${(e as Error).message}`);
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
  if (t.id === "guidegot" || t.id === "guideoff" || t.id === "guideon") {
    const g = guideState();
    if (t.id === "guidegot") g.seen = [...new Set([...g.seen, t.dataset.tip!])];
    if (t.id === "guideoff") g.off = true;
    if (t.id === "guideon") {
      g.off = false;
      g.seen = [];
    }
    saveGuide(g);
    renderGuide(current());
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
      state.routeEdit = null;
      state.routeDraft = { prefer: [], strict: false };
      $("#keyform")?.remove();
      render();
    } else if (t.dataset.add) {
      const line = state.basket.find((x) => x.id === t.dataset.add);
      if (line) line.n = Math.min(20, line.n + 1);
      else if (state.basket.length < 20) state.basket.push({ id: t.dataset.add, n: 1 });
      saveBasket();
      render();
    } else if (t.dataset.dec) {
      const line = state.basket.find((x) => x.id === t.dataset.dec);
      if (line && --line.n <= 0) state.basket = state.basket.filter((x) => x !== line);
      saveBasket();
      render();
    } else if (t.id === "emptybasket") {
      state.basket = [];
      state.budget = "";
      saveBasket();
      render();
    } else if (t.dataset.route) {
      const k = state.keys.find((x) => x.id === t.dataset.route);
      state.routeEdit = t.dataset.route;
      state.keyForm = false;
      state.routeDraft = { prefer: [...(k?.routing?.prefer ?? [])], strict: k?.routing?.strict ?? false };
      render();
      $("#routeform")?.scrollIntoView({ block: "start" });
    } else if (t.id === "cancelroute") {
      state.routeEdit = null;
      render();
    } else if (t.id === "raddbtn") {
      const typed = ($("#rcustom") as HTMLInputElement).value.trim();
      const picked = ($("#radd") as HTMLSelectElement).value;
      const v = typed ? (typed.includes("/") || typed.startsWith("provider:") ? typed : `provider:${typed}`) : picked;
      if (v && !state.routeDraft.prefer.includes(v)) state.routeDraft.prefer.push(v);
      render();
    } else if (t.dataset.rup) {
      const i = Number(t.dataset.rup);
      const p = state.routeDraft.prefer;
      if (i > 0) [p[i - 1], p[i]] = [p[i]!, p[i - 1]!];
      render();
    } else if (t.dataset.rdel) {
      state.routeDraft.prefer.splice(Number(t.dataset.rdel), 1);
      render();
    } else if (t.id === "saveroute") {
      await api("POST", `/api/keys/${state.routeEdit}/routing`, state.routeDraft);
      state.routeEdit = null;
      toast("Saved. It applies to the agent's next call.");
      await refresh();
    } else if (t.id === "cancelkey") {
      state.keyForm = false;
      render();
    } else if (t.id === "dismiss") {
      state.newSecret = null;
      render();
    } else if (t.id === "createkey") {
      const mode = ($("#amode") as HTMLSelectElement | null)?.value ?? "all";
      const ids = [...document.querySelectorAll<HTMLInputElement>("[data-aid]")].filter((c) => c.checked).map((c) => c.dataset.aid!);
      const lapi = ($("#lapi") as HTMLSelectElement | null)?.value ?? "";
      const lcalls = ($("#lcalls") as HTMLInputElement | null)?.value.trim() ?? "";
      const r = await api<{ secret: string }>("POST", "/api/keys", {
        name: ($("#kname") as HTMLInputElement).value.trim(),
        expires_days: Number(($("#kdays") as HTMLInputElement | null)?.value || 30),
        daily_limit_usd: ($("#kdaily") as HTMLInputElement).value.trim(),
        per_api_limits: lapi && lcalls ? [{ listing_id: lapi, kind: "calls", value: Number(lcalls) }] : [],
        scopes: ["run", "receipts"],
        listing_access: mode === "all" ? { mode: "all", listing_ids: [] } : { mode, listing_ids: ids },
        ...(state.routeDraft.prefer.length && { routing: state.routeDraft }),
      });
      state.newSecret = r.secret;
      state.keyForm = false;
      render();
      window.scrollTo(0, 0);
      await refresh();
    } else if (t.dataset.revoke) {
      await api("POST", `/api/keys/${t.dataset.revoke}/revoke`, {});
      toast("Key stopped. The agent can't spend with it anymore.");
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

// <details> state survives re-renders (toggle doesn't bubble, so listen in the capture phase).
document.addEventListener("toggle", (e) => {
  if ((e.target as HTMLElement).id === "kmore") state.keyMore = (e.target as HTMLDetailsElement).open;
}, true);

document.addEventListener("change", async (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "budget") {
    try {
      atomic(t.value);
      state.budget = t.value.trim();
    } catch {
      toast("Enter a budget like 0.05");
    }
    render();
    return;
  }
  if (t.id === "rstrict") {
    state.routeDraft.strict = t.checked;
    return;
  }
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
  state.basket = loadBasket();
  state.cfg = await api<Config>("GET", "/api/config");
  api<{ listings: Listing[] }>("GET", "/api/listings").then((l) => {
    state.listings = l.listings;
    render();
  });
  await refresh();
})();

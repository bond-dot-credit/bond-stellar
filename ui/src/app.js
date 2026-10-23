// Pool console for the Stellar pooled vault. Layout and styling follow the console design.
// Bundled with esbuild (scripts/build-ui.mjs) so the Wallets Kit and its wallet modules share one instance.
import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { WalletConnectModule, WalletConnectTargetChain } from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import { arg, createChain, formatUsdc, payXlm, toBaseUnits, vault, xlmBalance } from "../lib/soroban.js";

const $ = (id) => document.getElementById(id);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
const fmt = (raw) => Number(formatUsdc(raw ?? 0n)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (part, whole) => (whole > 0n ? `${(Number((part * 10000n) / whole) / 100).toFixed(1)}%` : "—");
const explorerTx = (hash) => `https://stellar.expert/explorer/${config.network}/tx/${hash}`;
const FEED_LIMIT = 300;
const TOP_UP_XLM = "5";
const views = ["dashboard", "venues", "activity", "transactions", "admin"];

let config = null;
let chain = null;
let roles = null;                    // { admin, agent, usdc, aggregator }
let pool = null;                     // vault.state()
let deployed = 0n;                   // value in the aggregator
let price = 0n;                      // aggregator share price, 1.0 = 10_000_000
let pending = null;                  // { amount, unlock } or null
let ledger = 0;
let user = null;                     // connected wallet address
let position = { shares: 0n, value: 0n };
let wallet = 0n;                     // connected wallet USDC, base units
let verified = false;
let busy = false;
let eventsFrom;                      // next ledger to poll for events
let events = [];                     // newest first
const seenEvents = new Set();
let opcfg = { tick: 60, minMove: 1 };

// ----- helpers -----

function toast(msg, kind = "info", ms = 6500) {
  const el = document.createElement("div");
  el.className = `toast${kind === "err" ? " err" : ""}`;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, ms);
}

function txlog(label, status, hash) {
  const box = $("txlog");
  box.querySelector(".empty")?.remove();
  const row = document.createElement("div");
  row.className = "txrow";
  row.innerHTML = `<span class="tlabel">${label}</span>
    <span class="thash">${hash ? `<a href="${explorerTx(hash)}" target="_blank" rel="noopener">${short(hash)}</a>` : ""}</span>
    <span class="chip ${status}">${status}</span>`;
  box.prepend(row);
  while (box.children.length > 8) box.lastChild.remove();
  return row;
}

function saveConn() {
  try {
    // Only the RPC URL is remembered. The vault comes from the deployment config, so a
    // redeploy can't be overridden by an address saved in an older session.
    localStorage.setItem("stellarui.conn", JSON.stringify({ rpc: $("rpcUrl").value }));
  } catch {}
}

function loadConn() {
  try {
    const c = JSON.parse(localStorage.getItem("stellarui.conn") || "{}");
    if (c.rpc) $("rpcUrl").value = c.rpc;
    // vault is intentionally not restored; see saveConn.
  } catch {}
}

const roleOf = () => {
  if (!user) return "viewer";
  if (roles && user === roles.admin) return "owner";
  if (roles && user === roles.agent) return "agent";
  return "user";
};

const claimable = () => Boolean(pending && Date.now() / 1000 >= pending.unlock);
const room = () => (pool && pool.cap > pool.totalAssets ? pool.cap - pool.totalAssets : 0n);

// ----- wallet -----

function setupWallet() {
  const modules = defaultModules();
  if (config.walletConnectProjectId) {
    modules.push(
      new WalletConnectModule({
        projectId: config.walletConnectProjectId,
        metadata: { name: "Bond Stellar", description: "Pooled USDC vault on Stellar", url: location.origin, icons: [] },
        allowedChains: [WalletConnectTargetChain.TESTNET],
      }),
    );
  }
  StellarWalletsKit.init({
    modules,
    network: config.network === "testnet" ? Networks.TESTNET : Networks.PUBLIC,
  });
}

function signerFor(address) {
  return async (xdr) => {
    // The wallet may have switched accounts since connect. Never sign for an address the user isn't showing.
    const { address: current } = await StellarWalletsKit.getAddress();
    if (current !== address) throw new Error("Wallet account changed. Reconnect to continue.");
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
      networkPassphrase: config.networkPassphrase,
      address,
    });
    return signedTxXdr;
  };
}

async function connect() {
  try {
    const { address } = await StellarWalletsKit.authModal();
    const { networkPassphrase } = await StellarWalletsKit.getNetwork();
    if (networkPassphrase !== config.networkPassphrase) {
      StellarWalletsKit.disconnect().catch(() => {});
      throw new Error(`Wallet is on a different network. Switch it to ${config.network} and try again.`);
    }
    user = address;
    $("walletBtn").textContent = `${short(address)} · disconnect`;
    saveConn();
    await refresh();
    show("dashboard");
    toast(`Connected · ${short(address)}`);
    let toured = true;
    try { toured = !!localStorage.getItem("stellarui.toured"); } catch {}
    if (!toured && !connect.tourShown) {
      connect.tourShown = true;
      setTimeout(startTour, 700);
    }
  } catch (e) {
    toast(`Wallet connection failed: ${e.message ?? e}`, "err", 10000);
  }
}

function disconnect() {
  user = null;
  position = { shares: 0n, value: 0n };
  wallet = 0n;
  verified = false;
  $("walletBtn").textContent = "Connect wallet";
  StellarWalletsKit.disconnect().catch(() => {});
  refresh();
  toast("Wallet disconnected");
}

// ----- data -----

async function refresh() {
  if (!chain) return;
  try {
    roles = await vault.roles(chain);
    const [state, dep, pend, px] = await Promise.all([
      vault.state(chain),
      vault.deployed(chain),
      vault.pendingRedeem(chain),
      vault.sharePrice(chain),
    ]);
    pool = state;
    deployed = dep;
    pending = pend;
    price = px;
    if (user) {
      const [pos, bal, ver] = await Promise.all([
        vault.position(chain, user),
        vault.usdcBalance(chain, user),
        vault.isVerified(chain, user),
      ]);
      position = pos;
      wallet = bal;
      verified = ver;
    }
    ledger = (await chain.server.getLatestLedger()).sequence;
    renderAll();
    await Promise.all([loadEvents(), loadAgentStats()]);
  } catch (e) {
    toast(`Could not read the vault: ${e.message}`, "err", 9000);
  }
}

async function loadEvents() {
  try {
    const { events: fresh, latestLedger } = await vault.events(chain, { fromLedger: eventsFrom });
    eventsFrom = latestLedger;
    for (const e of fresh) {
      if (seenEvents.has(e.id)) continue;
      seenEvents.add(e.id);
      events.unshift(e);
    }
    events.sort((a, b) => b.ledger - a.ledger);
    events = events.slice(0, FEED_LIMIT);
    renderFeed();
    renderTxs();
  } catch (e) {
    console.warn("events unavailable", e);
  }
}

async function loadAgentStats() {
  if (!roles) return;
  try {
    const [gas, agentUsdc] = await Promise.all([xlmBalance(chain, roles.agent), vault.usdcBalance(chain, roles.agent)]);
    $("cfgAgent").textContent = short(roles.agent);
    $("cfgAgent").title = roles.agent;
    $("cfgGas").innerHTML = gas === null ? `—` : `${Number(gas).toFixed(2)}<small> XLM</small>`;
    $("cfgUsdc").innerHTML = `${fmt(agentUsdc)}<small> USDC</small>`;
  } catch {}
}

// ----- rendering -----

function renderAll() {
  const total = pool.totalAssets;
  $("tbTotal").innerHTML = `${fmt(total)}<small>USDC</small>`;
  $("tbIdle").textContent = fmt(pool.idle);
  $("tbDeployed").textContent = fmt(deployed);
  const st = $("tbStatus");
  st.textContent = pool.paused ? "PAUSED" : "ACTIVE";
  st.style.color = pool.paused ? "var(--red)" : "var(--green)";

  const role = roleOf();
  const chip = $("roleChip");
  chip.className = "rolechip" + (role === "owner" ? " owner" : role === "agent" ? " agent" : user ? " user" : "");
  chip.hidden = !user;
  $("roleText").textContent = role === "owner" ? "Admin" : role === "agent" ? "Agent" : "User";

  $("stTotal").innerHTML = `${fmt(total)}<small> USDC</small>`;
  $("stIdle").innerHTML = `${fmt(pool.idle)}<small> USDC</small>`;
  $("stDeployed").innerHTML = `${fmt(deployed)}<small> USDC</small>`;
  $("stVenueCount").textContent = pending
    ? `aggregator · redeeming ${fmt(pending.amount)} USDC`
    : "aggregator · nothing pending";
  $("stYou").innerHTML = user ? `${fmt(wallet)}<small> USDC</small>` : "—";
  $("stAddr").textContent = user ? short(user) : "connect a wallet";
  $("stOwner").textContent = short(roles.admin);
  $("stAgent").textContent = short(roles.agent);

  $("friendbotLink").href = user ? `https://friendbot.stellar.org/?addr=${user}` : "https://friendbot.stellar.org";
  $("faucetBtn").disabled = !user || busy;
  $("depRoom").textContent =
    !pool.kycOpen && user && !verified
      ? "Your address is not verified. Deposits are closed to verified accounts."
      : `Room left under the cap: ${fmt(room())} USDC`;

  $("wdHint").textContent = user
    ? `Your position: ${fmt(position.value)} USDC · ${position.shares.toLocaleString("en-US")} shares · idle ${fmt(pool.idle)} USDC`
    : "Connect a wallet to see your position";

  renderVenues(total);

  $("navAdmin").classList.toggle("disabled", role !== "owner");
  if (role !== "owner") $("admin").classList.add("hidden");
  $("recallCard").style.opacity = role === "agent" ? 1 : 0.45;
  $("kycToggleBtn").textContent = pool.kycOpen ? "Close to verified only" : "Open to everyone";
  $("cfgGate").textContent = pool.paused ? "paused" : "open";
  $("cfgGate").style.color = pool.paused ? "var(--red)" : "var(--green)";

  $("footVault").textContent = short(config.vault);
  $("footAsset").textContent = short(roles.usdc);
  $("footBlock").textContent = "#" + ledger;

  $("feedCount").textContent = events.length;
  $("txCount").textContent = groupTxs().length;

  genCfg();
  gate();
}

function renderVenues(total) {
  const row = `
    <tr class="vrow" data-vdetail="${roles.aggregator}">
      <td>
        <span class="vname">Soroban RWA aggregator</span>
        <div class="mono muted" style="font-size:10px" title="${roles.aggregator}">${short(roles.aggregator)}</div>
      </td>
      <td><span class="pill ok"><span class="dot"></span>pinned</span></td>
      <td class="mono" style="font-size:11px">${(Number(price) / 1e7).toFixed(4)}</td>
      <td>${fmt(deployed)}</td>
      <td class="mono" style="font-size:11px">${pct(deployed, total)}</td>
      <td class="mono" style="font-size:11px">${pending ? fmt(pending.amount) : "—"}</td>
      <td class="mono" style="font-size:11px">${pending ? new Date(pending.unlock * 1000).toLocaleTimeString() : "—"}</td>
      <td class="vchev">▾</td>
    </tr>
    <tr class="vdetail hidden" id="vd-${roles.aggregator}"><td colspan="8">${venueDetailHtml(total)}</td></tr>`;
  $("venuesBody").innerHTML = row;
}

function venueDetailHtml(total) {
  return `<div>
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
      <h3 style="font-size:20px">Soroban RWA aggregator</h3>
      <span class="pill ok"><span class="dot"></span>pinned</span>
      <div style="margin-left:auto"><button class="maxbtn" data-copyfull="${roles.aggregator}">copy address</button></div>
    </div>
    <div class="mono muted" style="font-size:10.5px;margin:4px 0 12px">${roles.aggregator}</div>
    <p class="muted" style="font-size:12.5px;margin-bottom:14px">Mock aggregator on testnet. It issues share units at the price above and settles redemptions after a delay. A real RWA aggregator plugs in with the same four functions.</p>
    <div class="stat-grid">
      <div class="stat"><div class="k">Position</div><div class="v" style="font-size:20px">${fmt(deployed)}</div><div class="s">USDC held for this pool</div></div>
      <div class="stat"><div class="k">Share of NAV</div><div class="v" style="font-size:20px">${pct(deployed, total)}</div><div class="s">NAV ${fmt(total)} USDC</div></div>
      <div class="stat"><div class="k">Share price</div><div class="v" style="font-size:20px">${(Number(price) / 1e7).toFixed(4)}</div><div class="s">1.0000 at deployment</div></div>
      <div class="stat"><div class="k">Pending</div><div class="v" style="font-size:20px">${pending ? fmt(pending.amount) : "0"}</div><div class="s">${pending ? "unlocks " + new Date(pending.unlock * 1000).toLocaleTimeString() : "nothing settling"}</div></div>
    </div>
  </div>`;
}

function describe(e) {
  const parts = [];
  if (e.actor) parts.push(short(e.actor));
  for (const [key, value] of Object.entries(e.args)) {
    if (typeof value === "bigint") {
      // Share units are internal (virtual offset); show USDC amounts only.
      if (key !== "shares") parts.push(`${fmt(value)} USDC`);
    } else if (typeof value === "boolean") {
      parts.push(`${key} ${value}`);
    } else if (typeof value === "string" && value.startsWith("G")) {
      parts.push(short(value));
    }
  }
  return parts.join(" · ");
}

function renderFeed() {
  $("feed").innerHTML = events.length
    ? events.slice(0, 50).map((e) => `
        <div class="feed-item">
          <a class="blk" href="#transactions" data-tx="${e.txHash}">#${e.ledger}</a>
          <b>${e.label}</b><span>${describe(e)}</span>
        </div>`).join("")
    : `<div class="empty">No vault events in the last ~11 hours.</div>`;
  $("feedCount").textContent = events.length;
}

function groupTxs() {
  const groups = new Map();
  for (const e of events) {
    const g = groups.get(e.txHash) ?? { hash: e.txHash, ledger: e.ledger, closedAt: e.closedAt, events: [] };
    g.events.push(e);
    groups.set(e.txHash, g);
  }
  return [...groups.values()];
}

function renderTxs() {
  const txs = groupTxs();
  $("txCount").textContent = txs.length;
  $("txBody").innerHTML = txs.length
    ? txs.slice(0, 100).map((g) => {
        const actions = [...new Set(g.events.map((e) => e.label))].join(" + ");
        const actor = g.events.find((e) => e.actor)?.actor;
        const amount = g.events.find((e) => typeof Object.values(e.args)[0] === "bigint");
        const amountText = amount ? describe({ ...amount, actor: null }) : "—";
        return `
      <tr class="vrow" data-txrow="${g.hash}">
        <td class="mono" style="font-size:11.5px">${short(g.hash)}</td>
        <td class="mono" style="font-size:11px">#${g.ledger}</td>
        <td><span class="pill ok"><span class="dot"></span>${actions}</span></td>
        <td class="mono" style="font-size:11px">${short(actor)}</td>
        <td class="mono" style="font-size:11px">${amountText}</td>
        <td class="vchev">▾</td>
      </tr>
      <tr class="vdetail hidden" id="txd-${g.hash}"><td colspan="6"></td></tr>`;
      }).join("")
    : `<tr><td colspan="6"><div class="empty">No transactions yet</div></td></tr>`;
}

function fillTxDetail(detail, hash) {
  const g = groupTxs().find((t) => t.hash === hash);
  if (!g) return;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  detail.querySelector("td").innerHTML = `<div>
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
      <h3 style="font-size:17px">Transaction</h3>
      <div style="margin-left:auto"><button class="maxbtn" data-copytx="${g.hash}">copy hash</button></div>
    </div>
    <div class="adesc mono" style="font-size:11px">${g.hash}</div>
    <dl class="dgrid">
      ${row("Status", `<span class="pill ok"><span class="dot"></span>success</span>`)}
      ${row("Ledger", `#${g.ledger} · ${g.closedAt ? new Date(g.closedAt).toLocaleString() : "—"}`)}
      ${row("Explorer", `<a href="${explorerTx(g.hash)}" target="_blank" rel="noopener">stellar.expert ↗</a>`)}
    </dl>
    <div class="devents">
      <div class="adesc" style="margin-bottom:4px">Events (${g.events.length})</div>
      ${g.events.map((e) => `<div class="devent"><span class="tag vault">vault</span><span class="ename">${e.label}</span><span class="eargs">${describe(e)}</span></div>`).join("")}
    </div>
    <div class="small muted" style="margin-top:10px">Failed transactions emit no events, so they are not listed here.</div>
  </div>`;
}

// ----- actions -----

async function run(label, action) {
  if (busy) return toast("Another transaction is in flight", "err");
  busy = true;
  gate();
  const row = txlog(label, "pending", null);
  try {
    const { hash } = await action();
    row.querySelector(".thash").innerHTML = `<a href="${explorerTx(hash)}" target="_blank" rel="noopener">${short(hash)}</a>`;
    row.querySelector(".chip").className = "chip mined";
    row.querySelector(".chip").textContent = "mined";
    toast(`${label} — confirmed`);
  } catch (e) {
    const msg = String(e.message ?? e).slice(0, 240);
    row.querySelector(".chip").className = "chip failed";
    row.querySelector(".chip").textContent = "failed";
    toast(`${label} failed — ${msg}`, "err", 12000);
  } finally {
    busy = false;
    await refresh();
  }
}

const requireUser = () => {
  if (!user) throw new Error("Connect a wallet first");
};

function sharesFor(usdcBase) {
  const sh = (usdcBase * (pool.totalSupply + 1_000_000n)) / (pool.totalAssets + 1n);
  return sh > position.shares ? position.shares : sh;
}

function onDeposit() {
  let amount;
  try {
    amount = toBaseUnits($("depAmt").value);
  } catch (e) {
    return toast(e.message, "err");
  }
  if (amount <= 0n) return toast("Amount must be above zero", "err");
  if (amount > wallet) return toast("Amount is more than your wallet balance", "err");
  if (amount > room()) return toast(`Only ${fmt(room())} USDC fits under the cap`, "err");
  run("Deposit", async () => {
    requireUser();
    return vault.deposit(chain, { user, amount, signTx: signerFor(user) });
  });
}

function onWithdraw(sharesOverride) {
  let shares = sharesOverride;
  if (shares === undefined) {
    let amount;
    try {
      amount = toBaseUnits($("wdAmt").value);
    } catch (e) {
      return toast(e.message, "err");
    }
    if (amount <= 0n) return toast("Amount must be above zero", "err");
    shares = amount >= position.value ? position.shares : sharesFor(amount);
  }
  if (shares <= 0n) return toast("Nothing to withdraw", "err");
  run("Withdraw", async () => {
    requireUser();
    return vault.withdraw(chain, { user, shares, signTx: signerFor(user) });
  });
}

function onRecallRequest() {
  let amount;
  try {
    amount = toBaseUnits($("recallAmt").value);
  } catch (e) {
    return toast(e.message, "err");
  }
  if (amount <= 0n) return toast("Amount must be above zero", "err");
  run("Request redemption", async () => {
    requireUser();
    return vault.agentRequestRedeem(chain, { agent: user, amount, signTx: signerFor(user) });
  });
}

function onAdmin(label, method, args) {
  run(label, async () => {
    requireUser();
    return vault.admin(chain, { admin: user, method, args: args(), signTx: signerFor(user) });
  });
}

function parseUsdc(id) {
  return toBaseUnits($(id).value);
}

// ----- gating (buttons follow on-chain state and the connected role) -----

function gate() {
  if (!pool) return;
  const role = roleOf();
  const paused = pool.paused;
  const canDeposit = Boolean(user) && !paused && room() > 0n && (pool.kycOpen || verified);
  const canWithdraw = Boolean(user) && position.shares > 0n;
  const enable = (id, on) => { $(id).disabled = !on || busy; };
  enable("depBtn", canDeposit);
  enable("wdBtn", canWithdraw);
  enable("exitBtn", canWithdraw && position.value <= pool.idle);
  enable("recallBtn", role === "agent");
  enable("claimBtn", role === "agent" && claimable());
  enable("deployBtn", role === "agent");
  enable("opsRecallBtn", role === "agent");
  enable("pauseBtn", role === "owner" && !paused);
  enable("unpauseBtn", role === "owner" && paused);
  for (const id of ["setAgentBtn", "setCapBtn", "setBufBtn", "kycToggleBtn", "verifyBtn", "revokeBtn", "agentTopup"]) {
    enable(id, role === "owner");
  }
}

// ----- navigation -----

function show(id) {
  views.forEach((v) => { const el = $(v); if (el) el.classList.toggle("hidden", v !== id); });
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === id));
  window.scrollTo({ top: 0 });
}

// ----- operator configuration -----

function genCfg() {
  if (!$("cfgEnv") || !roles) return;
  opcfg.tick = Number($("cfgTick").value) || opcfg.tick;
  opcfg.minMove = Number($("cfgMinMove").value) || 0;
  $("cfgEnv").textContent = [
    `# agent/.env — generated by the pool console`,
    `NETWORK=${config.network}`,
    `AGENT_SECRET=S…   # agent key: deploy, request redemption, claim only`,
    `MIN_MOVE_USDC=${opcfg.minMove}`,
    `TICK_SECONDS=${opcfg.tick}`,
    `# vault ${config.vault} · aggregator ${roles.aggregator} · buffer ${fmt(pool.buffer)} USDC (on-chain)`,
  ].join("\n");
  $("cfgJson").textContent = JSON.stringify({
    network: config.network,
    rpcUrl: config.rpcUrl,
    horizonUrl: config.horizonUrl,
    networkPassphrase: config.networkPassphrase,
    usdc: roles.usdc,
    vault: config.vault,
    aggregator: roles.aggregator,
    admin: roles.admin,
    agent: roles.agent,
  }, null, 2);
}

function initOpCfg() {
  try {
    const c = JSON.parse(localStorage.getItem("stellarui.opcfg") || "null");
    if (c) opcfg = { ...opcfg, ...c };
  } catch {}
  $("cfgTick").value = opcfg.tick;
  $("cfgMinMove").value = opcfg.minMove;
  $("cfgTick").oninput = genCfg;
  $("cfgMinMove").oninput = genCfg;
  $("cfgSave").onclick = () => {
    localStorage.setItem("stellarui.opcfg", JSON.stringify(opcfg));
    toast("Runner configuration saved on this machine");
  };
  const copy = (id, what) => { navigator.clipboard?.writeText($(id).textContent); toast(`${what} copied`, "info", 2500); };
  $("cfgCopyEnv").onclick = () => copy("cfgEnv", ".env");
  $("cfgCopyJson").onclick = () => copy("cfgJson", "Deployment");
}

// ----- first-visit walkthrough -----

const TOUR = [
  { title: "Welcome to the pool console", body: "This console runs the pooled USDC vault on Stellar. Anyone can deposit up to the cap and receive shares. An agent deploys the pooled USDC into an RWA aggregator, and you can withdraw from idle USDC at any time. This short tour shows the moving parts." },
  { sel: ".sidebar", title: "Navigation", body: "Dashboard, Venues, Activity, and Transactions are open to everyone. Operator → Admin holds the owner controls and is only enabled for the admin wallet. The footer shows the vault, the USDC asset, and the current ledger." },
  { sel: "#walletBtn", title: "Connect", body: "Connect a Stellar wallet set to the same network as the console (testnet here). The wallet picker lists the installed wallets. WalletConnect appears when a Reown project ID is configured. Once connected, the top-right shows your role, read from the contract: Admin, Agent, or User. The console never stores your keys." },
  { sel: ".topbar", title: "Live pool status", body: "Always visible: total assets, idle USDC in the vault, USDC deployed in the aggregator, and whether deposits are paused." },
  { view: "dashboard", sel: "#dashboard .stat-grid", title: "Dashboard", body: "Total assets is everything the pool holds. Idle is undeployed USDC that covers withdrawals. Deployed is working in the aggregator. Your wallet shows the connected wallet's test USDC." },
  { view: "dashboard", sel: "#dashboard .agrid", title: "Actions", body: "Deposit sends USDC into the pool, up to the cap. Withdraw burns your shares from idle USDC. The agent's recall card requests a redemption and claims it once it settles. Full exit burns every share in one transaction when idle covers it." },
  { view: "venues", sel: "#venues table", title: "Venues", body: "The aggregator the pool deploys into: its position, share of NAV, share price, and any redemption still settling. Click the row for the full detail card." },
  { view: "activity", sel: "#activity", title: "Activity", body: "Every vault event on-chain, newest first: deposits, withdrawals, deploys, redemptions, and admin changes. Clicking a ledger opens the transaction in the Transactions view. Your own pending transactions appear at the top." },
  { view: "transactions", sel: "#transactions table", title: "Transactions", body: "Vault transactions grouped by hash. Click a row for its events and a link to stellar.expert. Failed transactions emit no events, so they only appear in your local log." },
  { view: "activity", sel: "#activity", title: "Running the agent", body: "The agent is the Node runner in agent/. npm run agent:once executes one tick: it claims settled redemptions, deploys idle USDC above the buffer, and requests a redemption when idle falls short. Every action is a vault event, so it shows up here." },
  { view: "admin", sel: "#admin", adminOnly: true, title: "Operator admin — owner only", body: "Pause deposits (withdrawals stay live), rotate the agent, set the pool cap and idle buffer, control KYC (simulated for now), and top up the agent's XLM for fees. The runner section generates the agent's .env." },
  { title: "You're set", body: "Connect a wallet with test USDC and deposit. Then run the agent and watch the deposit deploy. Replay this tour from the sidebar footer." },
];
let tourIdx = -1;

const tourSteps = () => {
  const isOwner = roleOf() === "owner";
  return TOUR.filter((s) => !s.adminOnly || isOwner);
};

function startTour() { tourIdx = 0; renderTourStep(); }

function endTour(markDone = true) {
  tourIdx = -1;
  $("tourBlock").style.display = "none";
  $("tourSpot").style.display = "none";
  $("tourTip").style.display = "none";
  if (markDone) { try { localStorage.setItem("stellarui.toured", "1"); } catch {} }
}

function renderTourStep() {
  const steps = tourSteps();
  const s = steps[tourIdx];
  if (!s) return endTour();
  if (s.view) show(s.view);
  requestAnimationFrame(() => {
    try {
      const spot = $("tourSpot"), tip = $("tourTip"), block = $("tourBlock");
      block.style.display = "block";
      spot.style.display = "block";
      tip.style.display = "block";
      let rect = { top: innerHeight * 0.28, left: innerWidth / 2 - 110, width: 220, height: 90, bottom: innerHeight * 0.28 + 90 };
      if (s.sel) {
        const el = document.querySelector(s.sel);
        if (el && el.offsetParent !== null) rect = el.getBoundingClientRect();
      }
      const pad = 6;
      spot.style.top = `${Math.max(4, rect.top - pad)}px`;
      spot.style.left = `${Math.max(4, rect.left - pad)}px`;
      spot.style.width = `${rect.width + pad * 2}px`;
      spot.style.height = `${rect.height + pad * 2}px`;
      tip.style.visibility = "hidden";
      tip.innerHTML = `
        <h3>${s.title}</h3><p>${s.body}</p>
        <div class="tourbar">
          <span class="cnt">${tourIdx + 1} / ${steps.length}</span>
          ${tourIdx > 0 ? `<button class="tbtn ghost" data-tour="back">Back</button>` : ""}
          <button class="tbtn ghost" data-tour="skip">Skip</button>
          <button class="tbtn next" data-tour="next">${tourIdx === steps.length - 1 ? "Finish" : "Next"}</button>
        </div>`;
      const th = tip.offsetHeight || 190;
      let top = rect.bottom + 18;
      if (top + th > innerHeight - 12) top = Math.max(12, rect.top - th - 14);
      tip.style.top = `${top}px`;
      tip.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - tip.offsetWidth - 12))}px`;
      tip.style.visibility = "visible";
      tip.querySelector("[data-tour='next']").onclick = () => {
        if (tourIdx >= steps.length - 1) return endTour();
        tourIdx++; renderTourStep();
      };
      const back = tip.querySelector("[data-tour='back']");
      if (back) back.onclick = () => { tourIdx--; renderTourStep(); };
      tip.querySelector("[data-tour='skip']").onclick = () => endTour();
    } catch (err) {
      console.error("tour step failed", err);
    }
  });
}

// ----- wiring -----

function bind() {
  $("walletBtn").onclick = () => (user ? disconnect() : connect());
  $("faucetBtn").onclick = () => run("Get test USDC", async () => {
    requireUser();
    return vault.faucet(chain, { user, amount: toBaseUnits("100"), signTx: signerFor(user) });
  });
  $("rpcUrl").onchange = () => { config.rpcUrl = $("rpcUrl").value.trim(); chain = createChain(config); saveConn(); refresh(); };
  $("vaultAddr").onchange = () => { config.vault = $("vaultAddr").value.trim(); saveConn(); refresh(); };
  $("refreshBtn").onclick = () => refresh();

  document.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => {
    if (!user) return;
    const percent = Number(b.dataset.q.split(":")[1]);
    $("depAmt").value = (Number(formatUsdc(wallet)) * percent / 100).toFixed(2);
  }));
  $("depMaxBtn").onclick = () => { if (user) $("depAmt").value = formatUsdc(wallet); };
  $("wdMaxBtn").onclick = () => { if (user) $("wdAmt").value = formatUsdc(position.value); };

  $("depBtn").onclick = onDeposit;
  $("wdBtn").onclick = () => onWithdraw();
  $("recallBtn").onclick = onRecallRequest;
  $("claimBtn").onclick = () => run("Claim settled", async () => {
    requireUser();
    return vault.agentClaim(chain, { agent: user, signTx: signerFor(user) });
  });
  $("exitBtn").onclick = () => {
    if (!user || position.shares <= 0n) return;
    onWithdraw(position.shares);
  };

  $("pauseBtn").onclick = () => onAdmin("Pause deposits", "set_paused", () => [arg.bool(true)]);
  $("unpauseBtn").onclick = () => onAdmin("Unpause deposits", "set_paused", () => [arg.bool(false)]);
  $("setAgentBtn").onclick = () => {
    try { onAdmin("Rotate agent", "set_agent", () => [arg.address($("newAgent").value.trim())]); } catch (e) { toast(e.message, "err"); }
  };
  $("setCapBtn").onclick = () => {
    try { const cap = parseUsdc("capAmt"); onAdmin("Set cap", "set_cap", () => [arg.i128(cap)]); } catch (e) { toast(e.message, "err"); }
  };
  $("setBufBtn").onclick = () => {
    try { const buffer = parseUsdc("bufAmt"); onAdmin("Set buffer", "set_buffer", () => [arg.i128(buffer)]); } catch (e) { toast(e.message, "err"); }
  };
  $("kycToggleBtn").onclick = () => onAdmin(pool.kycOpen ? "Close KYC" : "Open KYC", "set_kyc_open", () => [arg.bool(!pool.kycOpen)]);
  $("verifyBtn").onclick = () => onAdmin("Verify address", "set_verified", () => [arg.address($("veriAddr").value.trim()), arg.bool(true)]);
  $("revokeBtn").onclick = () => onAdmin("Revoke address", "set_verified", () => [arg.address($("veriAddr").value.trim()), arg.bool(false)]);
  $("deployBtn").onclick = () => {
    try {
      const amount = parseUsdc("opsAmt");
      run("Deploy", async () => { requireUser(); return vault.agentDeploy(chain, { agent: user, amount, signTx: signerFor(user) }); });
    } catch (e) { toast(e.message, "err"); }
  };
  $("opsRecallBtn").onclick = () => {
    try {
      const amount = parseUsdc("opsAmt");
      run("Request redemption", async () => { requireUser(); return vault.agentRequestRedeem(chain, { agent: user, amount, signTx: signerFor(user) }); });
    } catch (e) { toast(e.message, "err"); }
  };
  $("agentTopup").onclick = () => run(`Top up agent ${TOP_UP_XLM} XLM`, async () => {
    requireUser();
    return payXlm(chain, { from: user, to: roles.agent, amount: TOP_UP_XLM, signTx: signerFor(user) });
  });

  document.querySelectorAll("[data-nav]").forEach((a) => {
    a.addEventListener("click", (e) => {
      if (a.classList.contains("disabled")) {
        e.preventDefault();
        toast("Admin requires the owner wallet. Connect it to continue.", "err", 8000);
        return;
      }
      e.preventDefault();
      show(a.dataset.nav);
    });
  });

  document.addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copyfull]");
    if (copyBtn) { navigator.clipboard?.writeText(copyBtn.dataset.copyfull); toast("Address copied", "info", 2500); return; }
    const copyTx = e.target.closest("[data-copytx]");
    if (copyTx) { navigator.clipboard?.writeText(copyTx.dataset.copytx); toast("Hash copied", "info", 2500); return; }
    const txRow = e.target.closest("tr[data-txrow]");
    if (txRow) {
      const detail = $(`txd-${txRow.dataset.txrow}`);
      if (detail) {
        if (!detail.dataset.filled) { detail.dataset.filled = "1"; fillTxDetail(detail, txRow.dataset.txrow); }
        const closed = detail.classList.toggle("hidden");
        const chev = txRow.querySelector(".vchev");
        if (chev) chev.textContent = closed ? "▾" : "▴";
      }
      return;
    }
    const rowEl = e.target.closest("tr[data-vdetail]");
    if (rowEl) {
      const detail = $(`vd-${rowEl.dataset.vdetail}`);
      if (detail) {
        const closed = detail.classList.toggle("hidden");
        const chev = rowEl.querySelector(".vchev");
        if (chev) chev.textContent = closed ? "▾" : "▴";
      }
      return;
    }
    const a = e.target.closest("[data-tx]");
    if (a) {
      e.preventDefault();
      show("transactions");
      requestAnimationFrame(() => {
        const detail = $(`txd-${a.dataset.tx}`);
        const rowEl = document.querySelector(`tr[data-txrow="${a.dataset.tx}"]`);
        if (!detail || !rowEl) return;
        if (!detail.dataset.filled) { detail.dataset.filled = "1"; fillTxDetail(detail, a.dataset.tx); }
        detail.classList.remove("hidden");
        const chev = rowEl.querySelector(".vchev");
        if (chev) chev.textContent = "▴";
        setTimeout(() => detail.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
      });
    }
  });

  $("tourBlock").onclick = () => endTour();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tourIdx >= 0) endTour(); });
  window.addEventListener("resize", () => { if (tourIdx >= 0) renderTourStep(); });
  $("replayTour").onclick = () => { endTour(false); startTour(); };
}

// ----- boot -----

async function boot() {
  config = await (await fetch("./config.json", { cache: "no-store" })).json();
  // Optional wallet settings, kept apart from the deploy output so redeploys don't overwrite them.
  const wallet = await fetch("./wallet.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  config.walletConnectProjectId = wallet.walletConnectProjectId || "";
  loadConn();
  if (!$("rpcUrl").value) $("rpcUrl").value = config.rpcUrl;
  $("vaultAddr").value = config.vault;
  config.rpcUrl = $("rpcUrl").value.trim();
  config.vault = $("vaultAddr").value.trim();
  chain = createChain(config);
  $("networkName").textContent = config.network;

  setupWallet();
  initOpCfg();
  bind();
  const requested = new URLSearchParams(location.search).get("view");
  show(views.includes(requested) ? requested : "dashboard");
  await refresh();
  setInterval(refresh, 15_000);
}

boot().catch((e) => toast(`Startup failed: ${e.message}`, "err", 12000));

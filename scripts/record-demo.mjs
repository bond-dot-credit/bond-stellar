// Records the pool console demo as scene-by-scene takes for docs/console-demo.mp4.
//
//   node scripts/record-demo.mjs --rehearse   run all scenes headless, no recorder (default)
//   node scripts/record-demo.mjs              headed + --start-fullscreen, waits for the go
//                                             file before each scene (recorder runs outside)
//
// A scene take works like this: the driver prints "READY <scene>", then waits for
// /tmp/bond-demo-scenes/go-<scene> to appear (the orchestrator starts `screencapture`
// first), performs the scene, prints "SCENE_DONE <scene>", and moves to the next.
// Markers (timestamps inside each take) land in /tmp/bond-demo-scenes/markers.json.
//
// The mock wallet is injected with the built bundle because modern Chrome ignores
// --load-extension; the extension sources in demo/mock-wallet stay loadable by hand.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_URL = process.env.DEMO_URL ?? "http://localhost:8080";
const PROFILE = "/tmp/bond-demo-profile";
const WALLET_BUNDLE = new URL("../demo/mock-wallet/build/inject.js", import.meta.url).pathname;
const SCENES_DIR = process.env.SCENES_DIR ?? "/tmp/bond-demo-scenes";
const HEADED = !process.argv.includes("--rehearse");

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const S = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SCENES_DIR, { recursive: true });
for (const f of [...goFiles(SCENES_DIR), `${SCENES_DIR}/markers.json`]) rmSync(f, { force: true });

function goFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.startsWith("go-") || f === "markers.json").map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }
}
const markers = {};
let takeStart = 0;
const mark = (scene, label) => {
  (markers[scene] ??= []).push({ t: Date.now() - takeStart, at: Date.now(), label });
};
const sceneNum = Object.create(null);

async function waitGo(scene) {
  log(`READY ${scene}`);
  const file = `${SCENES_DIR}/go-${scene}`;
  while (!existsSync(file)) await S(200);
  takeStart = Date.now();
  mark(scene, "take-start");
  sceneNum[scene] = (sceneNum[scene] ?? 0) + 1;
  await S(600); // recorder spin-up
}

const shot = (page, name) =>
  page.screenshot({ path: `${SCENES_DIR}/${name}.png` }).catch(() => {});

const osascript = (...args) => {
  try {
    return execFileSync("osascript", args.map((a) => ["-e", a]).flat(), { encoding: "utf8" }).trim();
  } catch (e) {
    log(`osascript failed: ${String(e.message).slice(0, 160)}`);
    return "";
  }
};

/** Move the visible cursor over the element (for the recording), then click it
 *  synthetically: the console binds onclick handlers directly, so synthetic clicks
 *  always fire, and they can't be eaten by a transient toast/overlay. */
/** Move the visible cursor over the element (for the recording), then click it
 *  synthetically. Every step re-queries the selector, because the console re-renders
 *  table rows on each 15s auto-refresh and a stale handle dies mid-click. */
async function click(page, sel, timeout = 9000) {
  const deadline = Date.now() + timeout;
  let point = null;
  while (Date.now() < deadline) {
    point = await page
      .evaluate((s) => {
        const el = document.querySelector(s);
        if (!el || !el.offsetParent) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, sel)
      .catch(() => null);
    if (point) break;
    await S(400);
  }
  if (!point) throw new Error(`not clickable: ${sel}`);
  await page.mouse.move(point.x, point.y, { steps: 14 });
  await S(400);
  await page.evaluate((s) => document.querySelector(s)?.click(), sel);
  await S(300);
}

/** Real mouse click (down/up at the element). Needed where a user activation is
 *  required, e.g. target=_blank links opening a new tab. */
/** Real mouse click (down/up). Needed where a user activation is required, e.g.
 *  target=_blank links opening a new tab. Re-queries the selector like click(). */
async function clickReal(page, sel, timeout = 9000) {
  const deadline = Date.now() + timeout;
  let point = null;
  while (Date.now() < deadline) {
    point = await page
      .evaluate((s) => {
        const el = document.querySelector(s);
        if (!el || !el.offsetParent) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, sel)
      .catch(() => null);
    if (point) break;
    await S(400);
  }
  if (!point) throw new Error(`not clickable: ${sel}`);
  await page.mouse.move(point.x, point.y, { steps: 14 });
  await S(400);
  await page.mouse.down();
  await S(90);
  await page.mouse.up();
  await S(300);
}

async function smoothScroll(page, to, ms) {
  await page.evaluate(
    ({ to, ms }) => new Promise((resolve) => {
      const from = window.scrollY;
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / ms);
        const e = 0.5 - Math.cos(Math.PI * k) / 2;
        window.scrollTo(0, Math.round(from + (to - from) * e));
        k < 1 ? requestAnimationFrame(step) : resolve();
      };
      requestAnimationFrame(step);
    }),
    { to, ms },
  );
}

async function waitForData(page) {
  await page.waitForFunction(
    () => document.getElementById("footBlock")?.textContent.trim().length > 1,
    { timeout: 120_000 },
  );
  // events load right after the first render; the feed drives two scenes
  await page
    .waitForFunction(() => Number(document.getElementById("feedCount")?.textContent) > 0, { timeout: 60_000 })
    .catch(() => log("WARN: feed stayed empty"));
}

/** Click a wallet entry (Freighter) inside the wallets-kit modal. Needs real mouse
 *  events: the kit's list items don't respond to synthetic clicks. */
async function clickWalletInModal(page, name) {
  await page.waitForSelector("section.stellar-wallets-kit", { visible: true, timeout: 10000 });
  await S(1400); // let the modal paint
  const box = await page.evaluate((n) => {
    const el = [...document.querySelectorAll("section.stellar-wallets-kit *")]
      .find((e) => e.children.length === 0 && e.textContent.trim() === n);
    if (!el) return null;
    const li = el.closest("li") ?? el.parentElement;
    const r = li.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name);
  if (!box) throw new Error(`wallet entry not found in modal: ${name}`);
  await page.mouse.move(box.x, box.y, { steps: 12 });
  await S(400);
  await page.mouse.down();
  await S(100);
  await page.mouse.up();
}

async function connect(page, identity) {
  await page.evaluate((id) => {
    localStorage.setItem("demo.identity", id);
    localStorage.setItem("stellarui.toured", "1"); // the storyboard drives itself; no first-visit tour
  }, identity);
  await page.evaluate(() => document.getElementById("walletBtn").click());
  await clickWalletInModal(page, "Freighter");
  // connect() then awaits refresh() against testnet RPC, which is slow; wait until
  // the deposit button is actually enabled — that means position + wallet are loaded
  await page.waitForSelector("#depBtn:not([disabled])", { timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById("roleChip").hidden, { timeout: 10_000 });
  await S(1200);
}

async function disconnect(page) {
  await page.evaluate(() => document.getElementById("walletBtn").click());
  await page.waitForFunction(() => document.getElementById("walletBtn").textContent === "Connect wallet", { timeout: 10000 });
  await S(800);
}

/** Wait for the tx submitted in this scene to mine; return its explorer href.
 *  Matches the row element, so a previous scene's "mined" row can't satisfy it. */
async function waitMined(page, scene, timeout = 120_000) {
  const row =
    (await page
      .waitForSelector("#txlog .txrow:has(.chip.pending)", { timeout: 15000 })
      .catch(() => null)) ?? (await page.waitForSelector("#txlog .txrow", { timeout: 5000 }));
  if (!row) throw new Error("no tx row appeared in the log");
  await page.waitForFunction(
    (el) => el.querySelector(".chip")?.classList.contains("mined"),
    { timeout },
    row,
  );
  mark(scene, "mined");
  return page.evaluate((el) => el.querySelector("a")?.href ?? null, row);
}

// ----- scenes (times = storyboard slots; takes may run longer and get trimmed) -----

async function sceneDashboard(page) {
  await S(2500);
  mark("dashboard", "settled");
  const maxScroll = await page.evaluate(() => document.body.scrollHeight - innerHeight);
  await smoothScroll(page, Math.min(maxScroll, 850), 5200);
  mark("dashboard", "scrolled");
  await S(800);
  await smoothScroll(page, 0, 1800);
}

async function sceneConnect(page) {
  await connect(page, "alice");
  mark("connect", "connected");
  await S(2500);
}

async function sceneDeposit(page) {
  await page.focus("#depAmt").catch(() => {});
  await page.type("#depAmt", "20", { delay: 120 });
  mark("deposit", "amount-typed");
  const pre = await page.evaluate(() => ({
    value: document.getElementById("depAmt").value,
    depDisabled: document.getElementById("depBtn").disabled,
    hint: document.getElementById("depRoom")?.textContent,
  }));
  log(`deposit pre-check: ${JSON.stringify(pre)}`);
  await S(700);
  await click(page, "#depBtn");
  mark("deposit", "submitted");
  await page.waitForSelector("#txlog .chip.pending", { timeout: 10000 }).catch(() => {});
  const href = await waitMined(page, "deposit");
  writeFileSync(`${SCENES_DIR}/deposit-tx.url`, href ?? "");
  await S(1500);
  // open Activity so the mined row (and its hash link) is on screen for the explorer scene
  await click(page, '[data-nav="activity"]');
  await S(2000);
}

async function sceneExplorer(browser, page) {
  mark("explorer", "opening");
  // click the mined tx hash in the log — needs a real click so the new tab is allowed
  const newTab = browser
    .waitForTarget((t) => t.url().includes("stellar.expert"), { timeout: 15000 })
    .catch(() => null);
  await clickReal(page, "#txlog a");
  const target = await newTab;
  const url = existsSync(`${SCENES_DIR}/deposit-tx.url`)
    ? readFileSync(`${SCENES_DIR}/deposit-tx.url`, "utf8").trim()
    : "";
  let tab = target ? await target.page() : null;
  if (!tab) {
    tab = await browser.newPage();
    await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }
  await S(9000); // let stellar.expert render the tx
  await tab.screenshot({ path: `${SCENES_DIR}/explorer.png` }).catch(() => {});
  mark("explorer", "loaded");
  await S(2500);
  await tab.close().catch(() => {});
  await page.bringToFront();
}

async function sceneAgent(headed, chromePid) {
  const agentSecret = execFileSync("stellar", ["keys", "secret", "stellar-agent"], { encoding: "utf8" }).trim();
  const dir = SCENES_DIR;
  const logFile = `${dir}/agent-tick.log`;
  rmSync(logFile, { force: true });
  if (headed) {
    const cmd = `cd '${process.cwd()}' && rm -f ${logFile} && AGENT_SECRET='${agentSecret}' npm run agent:once 2>&1 | tee ${logFile} ; echo TICK_DONE >> ${logFile}`;
    const escaped = cmd.replace(/"/g, '\\"');
    // new tab (selected), window sized, then fullscreen so menu bar and dock stay hidden.
    // One script block: AppleScript locals don't persist across separate -e invocations.
    const ok = osascript(
      `tell application "Terminal"
        activate
        set t to do script "${escaped}"
        set selected of t to true
        set bounds of front window to {40, 40, 1320, 860}
        activate
      end tell
      tell application "System Events" to keystroke "f" using {control down, command down}`,
    );
    if (!ok) log("WARN: Terminal automation failed (permissions?)");
    await S(1800); // fullscreen animation
    mark("agent", "terminal-shown");
  } else {
    // headless rehearsal: run the tick directly, no Terminal window
    const out = createWriteStream(logFile);
    const child = spawn("npm", ["run", "agent:once"], { cwd: process.cwd(), env: { ...process.env, AGENT_SECRET: agentSecret } });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on("close", () => out.end());
    mark("agent", "terminal-shown");
  }
  for (let i = 0; i < 120; i++) {
    if (existsSync(logFile) && readFileSync(logFile, "utf8").includes("TICK_DONE")) break;
    await S(500);
  }
  await S(1500);
  mark("agent", "tick-done");
  if (headed && chromePid) {
    // raise OUR Chrome instance (the user may have their own Chrome running):
    // System Events by unix pid, falling back to a plain activate
    const raised = osascript(
      `tell application "System Events" to set frontmost of first process whose unix id is ${chromePid} to true`,
    );
    if (!raised) osascript('tell application "Google Chrome" to activate');
  }
  await S(1500);
}

async function sceneVenuesActivity(page) {
  await click(page, '[data-nav="venues"]');
  await page.waitForSelector("#venues:not(.hidden)", { timeout: 10000 });
  await S(1300);
  await click(page, "tr[data-vdetail]", 15000).catch(async () => {
    // a slow auto-refresh can swallow the first nav click; retry once
    await click(page, '[data-nav="venues"]');
    await page.waitForSelector("#venues:not(.hidden)", { timeout: 10000 });
    await click(page, "tr[data-vdetail]", 15000);
  });
  mark("venues-activity", "detail-open");
  await S(2200);
  await click(page, '[data-nav="activity"]');
  await S(2200);
  mark("venues-activity", "feed-shown");
  await shot(page, "activity");
}

async function sceneWithdraw(page) {
  await click(page, '[data-nav="dashboard"]');
  await S(1400);
  await page.focus("#wdAmt").catch(() => {});
  await page.type("#wdAmt", "5", { delay: 140 });
  mark("withdraw", "amount-typed");
  await S(700);
  await click(page, "#wdBtn");
  mark("withdraw", "submitted");
  await waitMined(page, "withdraw");
  await S(2000);
  await click(page, '[data-nav="transactions"]');
  await S(1500);
  await click(page, "tr[data-txrow]");
  mark("withdraw", "tx-expanded");
  await S(2000);
}

async function sceneAdmin(page) {
  await disconnect(page);
  await connect(page, "admin");
  mark("admin", "connected-as-owner");
  await click(page, '[data-nav="admin"]');
  await S(1500);
  const maxScroll = await page.evaluate(() => document.body.scrollHeight - innerHeight);
  await smoothScroll(page, Math.min(maxScroll, 700), 3200);
  mark("admin", "page-scrolled");
  await S(1500);
  await smoothScroll(page, 0, 1500);
}

async function sceneOutro(page) {
  await click(page, '[data-nav="dashboard"]').catch(() => {});
  await S(2800);
}

// ----- main -----

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  const wallet = readFileSync(WALLET_BUNDLE, "utf8");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADED ? false : "new",
    // headed: no viewport emulation — puppeteer's default 800x600 dpr-1 emulation
    // otherwise pins the window small and non-retina
    defaultViewport: HEADED ? null : { width: 1352, height: 878 },
    // without --enable-automation Chrome shows no "controlled by test software" infobar
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      ...(HEADED ? [`--app=${PAGE_URL}`] : []),
    ],
  });
  const page = (await browser.pages())[0];
  page.on("error", (e) => log(`PAGE CRASH: ${String(e).slice(0, 120)}`));
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) log(`NAVIGATED -> ${f.url().slice(0, 60)}`); });
  await page.evaluateOnNewDocument((src) => window.eval(src), wallet);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  if (HEADED) {
    // macOS fullscreen is unreachable from automation here (Chrome 156 ignores
    // windowState, keystrokes need accessibility). The --app window opens at
    // (0, menuBar) covering the full display width; record its rect so the
    // assembly can crop the menu bar and the empty rest of the display away.
    await S(1500);
    const rect = await page.evaluate(() => ({
      x: window.screenLeft, y: window.screenTop, w: window.innerWidth, h: window.innerHeight,
      sw: window.screen.width, sh: window.screen.height, dpr: window.devicePixelRatio,
    }));
    writeFileSync(`${SCENES_DIR}/window-rect.json`, JSON.stringify(rect));
    log(`window rect ${JSON.stringify(rect)}`);
    if (rect.dpr < 2) log("WARN: window is not on the retina backing");
  }
  await waitForData(page);
  log("DATA READY");

  const scenes = [
    ["dashboard", (b, p) => sceneDashboard(p)],
    ["connect", (b, p) => sceneConnect(p)],
    ["deposit", (b, p) => sceneDeposit(p)],
    ["explorer", (b, p) => sceneExplorer(b, p)],
    ["agent", (b, p) => sceneAgent(HEADED, browser.process()?.pid)],
    ["venues-activity", (b, p) => sceneVenuesActivity(p)],
    ["withdraw", (b, p) => sceneWithdraw(p)],
    ["admin", (b, p) => sceneAdmin(p)],
    ["outro", (b, p) => sceneOutro(p)],
  ];
  const onlyIdx = process.argv.indexOf("--scenes");
  const wanted = onlyIdx > -1 ? process.argv[onlyIdx + 1].split(",") : null;
  const runScenes = wanted ? scenes.filter(([n]) => wanted.includes(n)) : scenes;

  const ensurePage = async () => {
    try {
      await page.evaluate(() => 1);
      return page;
    } catch {
      const p = (await browser.pages())[0];
      p.on("error", (e) => log(`PAGE CRASH: ${String(e).slice(0, 120)}`));
      await p.bringToFront().catch(() => {});
      log("page re-attached after detachment");
      return p;
    }
  };

  for (const [name, fn] of runScenes) {
    await waitGo(name);
    try {
      await fn(browser, await ensurePage());
      log(`SCENE_DONE ${name}`);
    } catch (e) {
      log(`SCENE_FAILED ${name}: ${e.message}`);
      try {
        const toasts = await page.evaluate(() => document.getElementById("toasts")?.textContent ?? "");
        if (toasts.trim()) log(`toasts after ${name}: ${toasts.slice(0, 300)}`);
        await page.screenshot({ path: `${SCENES_DIR}/fail-${name}.png` });
      } catch {}
    }
  }
  writeFileSync(`${SCENES_DIR}/markers.json`, JSON.stringify(markers, null, 2));
  await S(500);
  await browser.close().catch(() => {});
  log("closed");
}

main().catch((e) => {
  console.error("DRIVER ERROR:", e);
  process.exit(1);
});

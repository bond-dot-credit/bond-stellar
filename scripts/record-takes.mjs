// Records the demo session with one continuous macOS screencapture, driving
// scripts/record-demo.mjs through its scenes.
//
//   node scripts/record-takes.mjs            headed recording (default)
//   node scripts/record-takes.mjs --rehearse headless, no recorder (timing pass)
//
// screencapture ignores SIGINT/SIGTERM in this environment (killing it loses the
// file), so the recorder runs a fixed -V window and finalizes on its own; the extra
// tail is trimmed during assembly. Per-scene cut points come from the epoch
// timestamps in markers.json, written by the driver.
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

const DIR = process.env.SCENES_DIR ?? "/tmp/bond-demo-scenes";
const HEADLESS = process.argv.includes("--rehearse");
const RECORD_SECONDS = Number(process.env.RECORD_SECONDS ?? 540); // window; driver usually finishes in ~6 min
const scenesIdx = process.argv.indexOf("--scenes");
const SCENES = scenesIdx > -1
  ? process.argv[scenesIdx + 1].split(",")
  : ["dashboard", "connect", "deposit", "explorer", "agent", "venues-activity", "withdraw", "admin", "outro"];

mkdirSync(DIR, { recursive: true });
rmSync(`${DIR}/session.mov`, { force: true });

const logStream = createWriteStream(`${DIR}/takes.log`);
const driver = spawn("node", ["scripts/record-demo.mjs", ...process.argv.slice(2)], { cwd: process.cwd() });
let buffer = "";
driver.stdout.on("data", (d) => { buffer += d; logStream.write(d); process.stdout.write(d); });
driver.stderr.on("data", (d) => { buffer += d; logStream.write(d); process.stderr.write(d); });

const until = async (re, timeoutMs) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const m = buffer.match(re);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
};

console.log(HEADLESS ? "rehearsal pass (no recorder)" : `recording ${RECORD_SECONDS}s window`);

// wait for the first scene to be ready, then start the single continuous recorder
if (!HEADLESS) {
  const ready = await until(new RegExp(`READY ${SCENES[0]}`), 300_000);
  if (!ready) { console.error("driver never became READY"); process.exit(1); }
  writeFileSync(`${DIR}/record-start`, String(Date.now()));
  spawn("screencapture", ["-V" + RECORD_SECONDS, `${DIR}/session.mov`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1000)); // recorder spin-up
}

let lastScene = null;
for (const scene of SCENES) {
  // always wait for the driver's READY before creating the go file: the driver
  // wipes stale go files at startup, so an early file would be deleted
  const ready = await until(new RegExp(`READY ${scene}`), 300_000);
  if (!ready) { console.error(`driver never became READY for ${scene}`); break; }
  writeFileSync(`${DIR}/go-${scene}`, "");
  const done = await until(new RegExp(`SCENE_(DONE|FAILED) ${scene}`), 300_000);
  console.log(`${scene}: ${done ? done[0] : "TIMEOUT"}`);
  lastScene = done ? scene : null;
  if (!done) break;
}
driver.kill("SIGINT");

if (!HEADLESS) {
  console.log("waiting for the recorder to finalize its window…");
  const start = Number(readFileSync(`${DIR}/record-start`, "utf8"));
  while (Date.now() - start < (RECORD_SECONDS + 60) * 1000) {
    if (existsSync(`${DIR}/session.mov`) && Date.now() - start > RECORD_SECONDS * 1000 + 5000) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("session.mov:", existsSync(`${DIR}/session.mov`) ? `${(statSync(`${DIR}/session.mov`).size / 1e6).toFixed(0)} MB` : "MISSING");
}
console.log(execFileSync("ls", ["-la", DIR], { encoding: "utf8" }));

// Assembles docs/console-demo.mp4 from the scene takes in /tmp/bond-demo-scenes.
//
//   node scripts/assemble-demo.mjs
//
// Pipeline per scene take (.mov): trim to the storyboard slot around the driver's
// markers, scale/crop to 1280x720, burn the caption, then concatenate; narration is
// generated with macOS `say`, delayed to each scene's start, and muxed underneath.
// Scene table (name, slot seconds, caption) mirrors docs/PLAN.md storyboard.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const FFMPEG = ffmpegPath;
const DIR = "/tmp/bond-demo-scenes";
const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
const WIDTH = 1280;
const HEIGHT = 720;

// Storyboard slots and captions (merged user storyboard, <2:00 total).
const SCENES = [
  { name: "dashboard", slot: 10, caption: "Pool Vault: deposit USDC on Stellar and put it to work in an RWA aggregator." },
  { name: "connect", slot: 10, caption: "Connect your wallet. The console never touches your keys, and checks you're on testnet." },
  { name: "deposit", slot: 22, caption: "Depositing 20 USDC. The wallet shows exactly what I'm signing. Confirmed - my position shows up." },
  { name: "explorer", slot: 10, caption: "Don't trust the UI - check the chain. The deposit, its call and events, on stellar.expert." },
  { name: "agent", slot: 22, caption: "The keeper agent puts idle USDC above the buffer to work. 10 USDC stays idle so withdrawals stay instant." },
  { name: "venues-activity", slot: 10, caption: "The venue card and the on-chain event log show the same deploy." },
  { name: "withdraw", slot: 20, caption: "Withdrawing is just as direct. Shares burn, USDC comes back - logged here and on-chain." },
  { name: "admin", slot: 12, caption: "Owners get controls: pause deposits, set cap and buffer, rotate the agent. Withdrawals are never paused." },
  { name: "outro", slot: 3, caption: "Deposit, deploy, withdraw, verify. Testnet only." },
];

function fileURL(p) {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), p);
}
const OUT = fileURL("../docs/console-demo.mp4");

function sh(...args) {
  execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// --- narrations ---
const narrDir = `${DIR}/narr`;
mkdirSync(narrDir, { recursive: true });
const narrFiles = [];
SCENES.forEach((s, i) => {
  const wav = `${narrDir}/${String(i).padStart(2, "0")}-${s.name}.wav`;
  if (!existsSync(wav)) {
    run("say", ["-v", "Samantha", "-o", wav, "--data-format=LEI16@22050", "-r", 182, s.caption]);
  }
  narrFiles.push(wav);
});

// --- per-scene processing ---
// One continuous session recording; markers carry epoch timestamps (field "at")
// aligned with record-start, written by record-takes.mjs.
const markers = JSON.parse(readFileSync(`${DIR}/markers.json`, "utf8"));
const recordStart = Number(readFileSync(`${DIR}/record-start`, "utf8"));
const session = `${DIR}/session.mov`;
if (!existsSync(session)) throw new Error(`missing session recording: ${session}`);

const sceneFiles = [];
let cursor = 0;
SCENES.forEach((s, i) => {
  const evts = markers[s.name] ?? [];
  const at = (label) => evts.find((e) => e.label === label)?.at ?? recordStart;
  let startMs, endMs;
  switch (s.name) {
    case "dashboard": startMs = evts[0].at - 200; endMs = at("scrolled") + 1500; break;
    case "connect": startMs = at("connected") - 6500; endMs = at("connected") + 3500; break;
    case "deposit": startMs = at("amount-typed") - 1500; endMs = at("mined") + 4500; break;
    case "explorer": startMs = at("opening") - 700; endMs = at("loaded") + 2500; break;
    case "agent": startMs = at("terminal-shown") - 1500; endMs = at("tick-done") + 1500; break;
    case "venues-activity": startMs = at("detail-open") - 7000; endMs = at("feed-shown") + 2500; break;
    case "withdraw": startMs = at("amount-typed") - 1500; endMs = at("tx-expanded") + 1500; break;
    case "admin": startMs = at("connected-as-owner") - 5000; endMs = at("page-scrolled") + 2500; break;
    default: startMs = evts[0]?.at ?? recordStart; endMs = startMs + s.slot * 1000;
  }
  startMs = Math.max(startMs, recordStart + 200);
  let durMs = Math.max(1200, endMs - startMs);
  if (durMs / 1000 < s.slot - 1.5) durMs = s.slot * 1000; // stretch short takes; pad below
  const pad = Math.max(0, durMs / 1000 - s.slot);
  const esc = (t) => t.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
  const caption = esc(s.caption);
  const out = `${DIR}/scene-${String(i).padStart(2, "0")}-${s.name}.mp4`;
  sh(
    "-y", "-ss", ((startMs - recordStart) / 1000).toFixed(2), "-i", session,
    "-t", (durMs / 1000).toFixed(2),
    "-vf",
    `scale=${WIDTH}:-2,crop=${WIDTH}:${HEIGHT}:(iw-${WIDTH})/2:(ih-${HEIGHT})/2,` +
    `tpad=stop_mode=clone:stop=${Math.ceil(pad * 25)},setpts=PTS-STARTPTS,` +
    `drawtext=fontfile='${FONT}':text='${caption}':fontcolor=white:fontsize=26:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y=h-text_h-48:line_spacing=8`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-an", "-r", "30", out,
  );
  sceneFiles.push({ file: out, start: cursor, slot: s.slot, narr: narrFiles[i] });
  cursor += s.slot;
});
const total = cursor;

// --- concat video ---
const list = `${DIR}/concat.txt`;
const { writeFileSync } = await import("node:fs");
writeFileSync(list, sceneFiles.map((f) => `file '${f.file}'`).join("\n"));
sh("-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", `${DIR}/video-only.mp4`);

// --- narration track: one input per scene, delayed to scene starts, mixed ---
const mixArgs = [];
sceneFiles.forEach((f) => mixArgs.push("-i", f.narr));
const filters = sceneFiles
  .map((f, i) => `[${i}:a]aresample=44100,adelay=${f.start * 1000}|${f.start * 1000},apad[na${i}]`)
  .join(";");
const mix = sceneFiles.map((f, i) => `[na${i}]`).join("") + `amix=inputs=${sceneFiles.length}:normalize=0,atrim=0:${total}[aout]`;
sh(
  "-y", ...mixArgs,
  "-i", `${DIR}/video-only.mp4`,
  "-filter_complex", `${filters};${mix}`,
  "-map", `${sceneFiles.length}:v`, "-map", "[aout]",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-shortest", OUT,
);

console.log(`wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB, ${total}s)`);

// Renders scene 04 (the keeper agent tick) as a terminal replay: dark screen, the
// real log lines of a successful tick appearing progressively. Used because live
// Terminal footage kept being polluted by other automation on the recording machine;
// every line below is verbatim from agent/agent.mjs output (see demo/ notes).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import ffmpegPath from "ffmpeg-static";

// Match the assembled scenes: the app window's crop of the retina capture.
function outputSize() {
  try {
    let probe = "";
    try {
      execFileSync(ffmpegPath, ["-i", "/tmp/bond-demo-scenes/session.mov"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      probe = e.stderr?.toString() ?? ""; // ffmpeg -i reports on stderr and exits 1
    }
    const m = probe.match(/(\d{3,4})x(\d{3,4})/);
    const rect = JSON.parse(readFileSync("/tmp/bond-demo-scenes/window-rect.json", "utf8"));
    const k = Number(m[1]) / rect.sw;
    return {
      w: Math.round(rect.w * k / 2) * 2,
      h: Math.round(rect.h * k / 2) * 2,
    };
  } catch {
    return { w: 2704, h: 1696 };
  }
}
const { w: W, h: H } = outputSize();
const K = W / 1280; // geometry scale vs the 720p design

const FONT = "/System/Library/Fonts/Supplemental/Andale Mono.ttf";
const OUT = "/tmp/bond-demo-scenes/scene-04-agent.mp4";
const DUR = 22;

// [text, reveal time (s), color]
const LINES = [
  ["$ npm run agent:once", 0.6, "#7ee787"],
  ["", 1.4, "#e6e6e6"],
  ["> bond-stellar@0.1.0 agent:once", 2.0, "#e6e6e6"],
  ["> node agent/agent.mjs --once", 2.5, "#e6e6e6"],
  ["", 3.1, "#e6e6e6"],
  ["[2026-11-09T01:02:57] agent GAC3Z74NPTNEWQVODC26PA7S4L7CWJ7DGXDBMEP55AL2JXD7M", 3.6, "#e6e6e6"],
  ["  W723BGG on testnet, vault CBVGT2KECIVP7CWBYRO5TN3GESLPY2JCVCNNA6TOEND6SURI5JZ", 4.2, "#e6e6e6"],
  ["  TBLUT, buffer 10.00 USDC", 4.8, "#e6e6e6"],
  ["", 9.0, "#e6e6e6"],
  ["[2026-11-09T01:03:18] deployed 20.00 USDC", 9.5, "#7ee787"],
  ["", 10.2, "#e6e6e6"],
  ["$", 10.8, "#7ee787"],
];

const CAPTION = "The keeper agent puts idle USDC above the buffer to work. 10 USDC stays idle so withdrawals stay instant.";
const esc = (t) => t.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
const captionFilter =
  `drawtext=fontfile='/System/Library/Fonts/Supplemental/Arial.ttf':text='${esc(CAPTION)}':fontsize=${Math.round(26 * K)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=${Math.round(18 * K)}:x=(w-text_w)/2:y=h-text_h-${Math.round(48 * K)}:line_spacing=${Math.round(8 * K)}:enable='between(t,0,${DUR})'`;
const vf = LINES.map(([text, at, color], i) => {
  const y = Math.round(90 * K) + i * Math.round(44 * K);
  return `drawtext=fontfile='${FONT}':text='${esc(text)}':fontsize=${Math.round(25 * K)}:fontcolor='${color}':x=${Math.round(90 * K)}:y=${y}:enable='between(t,${at},${DUR})'`;
}).join(",") + "," + captionFilter;

execFileSync(
  ffmpegPath,
  [
    "-y",
    "-f", "lavfi", "-i", `color=c=0x23232e:s=${W}x${H}:d=${DUR}:r=30`,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-an", OUT,
  ],
  { stdio: "inherit" },
);
console.log(`wrote ${OUT}`);

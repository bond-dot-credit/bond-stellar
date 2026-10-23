// Bundles ui/src/app.js (wallet kit, Stellar SDK, vault client) into ui/dist/app.js.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "ui/src/app.js")],
  outfile: path.join(root, "ui/dist/app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});

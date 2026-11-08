// Builds the demo mock-wallet extension bundle. Reads the testnet identities from the
// Stellar CLI keystore (never from files in the repo) and inlines them into the bundle
// under demo/mock-wallet/build/, which is gitignored.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "demo/mock-wallet/build");

const secret = (name) => execFileSync("stellar", ["keys", "secret", name], { encoding: "utf8" }).trim();
const address = (name) => execFileSync("stellar", ["keys", "address", name], { encoding: "utf8" }).trim();

const alice = { secret: secret("stellar-alice"), public: address("stellar-alice") };
// The owner scene only needs the address (the Admin page gates on it and the demo signs
// nothing there). Prefer the keystore admin when it matches the deployed vault; otherwise
// fall back to the deployment's admin address with no signing key.
const deployments = JSON.parse(readFileSync(path.join(root, "deployments", "testnet.json"), "utf8"));
const adminSecret = secret("stellar-admin");
const admin = address("stellar-admin") === deployments.admin
  ? { secret: adminSecret, public: deployments.admin }
  : { secret: "", public: deployments.admin };

await esbuild.build({
  entryPoints: [path.join(root, "demo/mock-wallet/wallet.js")],
  outfile: path.join(outdir, "inject.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  minify: true,
  define: {
    __ALICE_PUBLIC__: JSON.stringify(alice.public),
    __ALICE_SECRET__: JSON.stringify(alice.secret),
    __ADMIN_PUBLIC__: JSON.stringify(admin.public),
    __ADMIN_SECRET__: JSON.stringify(admin.secret),
  },
});

console.log(`built demo/mock-wallet/build/inject.js (alice=${alice.public.slice(0, 8)}… admin=${admin.public.slice(0, 8)}…)`);

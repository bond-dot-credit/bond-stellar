// End-to-end smoke test on Stellar testnet through the same client the UI and agent use.
// Flow: alice deposits, agent deploys idle USDC into the aggregator, alice withdraws part.
// Requires deploy-testnet.sh to have run (reads deployments/testnet.json and the stellar CLI keys).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createChain, formatUsdc, keypairSigner, toBaseUnits, vault } from "../ui/lib/soroban.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(root, "deployments/testnet.json"), "utf8"));
const chain = createChain(config);

const stellarKey = (command, name) => execFileSync("stellar", ["keys", command, name], { encoding: "utf8" }).trim();
const aliceAddress = stellarKey("address", "stellar-alice");
const aliceSecret = stellarKey("secret", "stellar-alice");
const agentSecret = stellarKey("secret", "stellar-agent");

const show = (label, s) =>
  console.log(
    `${label.padEnd(22)} total=${formatUsdc(s.totalAssets)} idle=${formatUsdc(s.idle)} buffer=${formatUsdc(s.buffer)} cap=${formatUsdc(s.cap)} supply=${s.totalSupply}`,
  );

console.log("== before");
show("vault", await vault.state(chain));

// The pool may already hold deposits from earlier runs, so the test fits its
// amounts under the current cap room and idle buffer instead of assuming an empty pool.
const before = await vault.state(chain);
const room = before.cap - before.totalAssets;
const deposit = room < toBaseUnits("30") ? room : toBaseUnits("30");
if (deposit <= 0n) {
  console.log("pool is at cap — nothing to deposit");
  process.exit(0);
}
console.log(`== alice deposits ${formatUsdc(deposit)} USDC`);
await vault.deposit(chain, { user: aliceAddress, amount: deposit, signTx: keypairSigner(aliceSecret, config.networkPassphrase) });
show("vault", await vault.state(chain));
const afterDeposit = await vault.position(chain, aliceAddress);
console.log(`alice shares=${afterDeposit.shares} value=${formatUsdc(afterDeposit.value)} USDC`);

const deployable = (await vault.state(chain)).idle - before.buffer;
if (deployable > 0n) {
  const deploy = deployable < toBaseUnits("15") ? deployable : toBaseUnits("15");
  console.log(`== agent deploys ${formatUsdc(deploy)} USDC into aggregator`);
  await vault.agentDeploy(chain, { agent: config.agent, amount: deploy, signTx: keypairSigner(agentSecret, config.networkPassphrase) });
  show("vault", await vault.state(chain));
  console.log(`deployed in aggregator: ${formatUsdc(await vault.deployed(chain))} USDC`);
} else {
  console.log("== agent deploy skipped: idle is at or below the buffer");
}

console.log("== alice withdraws half her shares, or what idle covers");
const left = await vault.position(chain, aliceAddress);
const st = await vault.state(chain);
// withdraw returns shares*(assets+1)/(supply+1e6); this bound keeps that amount within idle.
const idleBound = st.totalAssets > 0n ? (st.idle * (st.totalSupply + 1_000_000n)) / (st.totalAssets + 1n) : 0n;
const half = left.shares / 2n;
const burn = [half, left.shares, idleBound].reduce((a, b) => (b < a ? b : a));
if (burn <= 0n) {
  console.log("idle is empty — nothing to withdraw");
} else {
  await vault.withdraw(chain, { user: aliceAddress, shares: burn, signTx: keypairSigner(aliceSecret, config.networkPassphrase) });
  show("vault", await vault.state(chain));
}
const final = await vault.position(chain, aliceAddress);
console.log(`alice shares=${final.shares} value=${formatUsdc(final.value)} USDC`);

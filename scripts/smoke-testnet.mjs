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

console.log("== alice deposits 30 USDC");
await vault.deposit(chain, { user: aliceAddress, amount: toBaseUnits("30"), signTx: keypairSigner(aliceSecret, config.networkPassphrase) });
show("vault", await vault.state(chain));
const afterDeposit = await vault.position(chain, aliceAddress);
console.log(`alice shares=${afterDeposit.shares} value=${formatUsdc(afterDeposit.value)} USDC`);

console.log("== agent deploys 15 USDC into aggregator");
await vault.agentDeploy(chain, { agent: config.agent, amount: toBaseUnits("15"), signTx: keypairSigner(agentSecret, config.networkPassphrase) });
show("vault", await vault.state(chain));
console.log(`deployed in aggregator: ${formatUsdc(await vault.deployed(chain))} USDC`);

console.log("== alice withdraws half her shares");
await vault.withdraw(chain, { user: aliceAddress, shares: afterDeposit.shares / 2n, signTx: keypairSigner(aliceSecret, config.networkPassphrase) });
show("vault", await vault.state(chain));
const left = await vault.position(chain, aliceAddress);
console.log(`alice shares=${left.shares} value=${formatUsdc(left.value)} USDC`);

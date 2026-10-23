// Full demo on testnet through the same client the console uses.
// alice and bob deposit, the agent deploys, a redemption is requested and claimed, and both
// users withdraw everything. Ends with an empty pool. Needs deploy-testnet.sh to have run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createChain, formatUsdc, keypairSigner, toBaseUnits, vault } from "../ui/lib/soroban.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(root, "deployments/testnet.json"), "utf8"));
const chain = createChain(config);

const key = (command, name) => execFileSync("stellar", ["keys", command, name], { encoding: "utf8" }).trim();
const alice = { address: key("address", "stellar-alice"), signTx: keypairSigner(key("secret", "stellar-alice"), config.networkPassphrase) };
const bob = { address: key("address", "stellar-bob"), signTx: keypairSigner(key("secret", "stellar-bob"), config.networkPassphrase) };
const agent = { address: config.agent, signTx: keypairSigner(key("secret", "stellar-agent"), config.networkPassphrase) };

const step = (title) => console.log(`\n== ${title}`);
const usdc = formatUsdc;

async function snapshot(label) {
  const s = await vault.state(chain);
  const deployed = await vault.deployed(chain);
  const pending = await vault.pendingRedeem(chain);
  console.log(
    `${label.padEnd(26)} total=${usdc(s.totalAssets)} idle=${usdc(s.idle)} deployed=${usdc(deployed)} pending=${pending ? usdc(pending.amount) : "0"}`,
  );
  return s;
}

async function waitForClaim() {
  const pending = await vault.pendingRedeem(chain);
  if (!pending) return;
  const wait = Math.max(0, pending.unlock * 1000 - Date.now()) + 2000;
  console.log(`waiting ${Math.ceil(wait / 1000)}s for the redemption to settle`);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

step("start");
await snapshot("pool before");

step("deposits");
await vault.deposit(chain, { user: alice.address, amount: toBaseUnits("30"), signTx: alice.signTx });
console.log("alice deposited 30 USDC");
await vault.deposit(chain, { user: bob.address, amount: toBaseUnits("20"), signTx: bob.signTx });
console.log("bob deposited 20 USDC");
const afterDeposits = await snapshot("after deposits");

step("agent deploys surplus above the buffer");
const surplus = afterDeposits.idle - afterDeposits.buffer;
await vault.agentDeploy(chain, { agent: agent.address, amount: surplus, signTx: agent.signTx });
console.log(`deployed ${usdc(surplus)} USDC into the aggregator`);
await snapshot("after deploy");

step("alice exits: agent redeems to refill idle, then alice withdraws everything");
await vault.agentRequestRedeem(chain, { agent: agent.address, amount: toBaseUnits("20"), signTx: agent.signTx });
await snapshot("redemption requested");
await waitForClaim();
const claimed = await vault.agentClaim(chain, { agent: agent.address, signTx: agent.signTx });
console.log(`agent claimed ${usdc(claimed.value)} USDC`);
await snapshot("after claim");
const aliceShares = (await vault.position(chain, alice.address)).shares;
const aliceOut = await vault.withdraw(chain, { user: alice.address, shares: aliceShares, signTx: alice.signTx });
console.log(`alice withdrew all shares: ${usdc(aliceOut.value)} USDC`);
await snapshot("after alice exits");

step("bob exits: redeem the rest, claim, withdraw everything");
const bobPosition = await vault.position(chain, bob.address);
const deployedLeft = await vault.deployed(chain);
await vault.agentRequestRedeem(chain, { agent: agent.address, amount: deployedLeft, signTx: agent.signTx });
await waitForClaim();
await vault.agentClaim(chain, { agent: agent.address, signTx: agent.signTx });
const bobOut = await vault.withdraw(chain, { user: bob.address, shares: bobPosition.shares, signTx: bob.signTx });
console.log(`bob withdrew all shares: ${usdc(bobOut.value)} USDC`);

step("end");
const final = await snapshot("pool after demo");
console.log(`alice shares left: ${(await vault.position(chain, alice.address)).shares}, bob shares left: ${(await vault.position(chain, bob.address)).shares}`);
if (final.totalSupply !== 0n) console.log("warning: shares outstanding");

#!/usr/bin/env node
// Vault agent. Each tick it keeps idle USDC near the buffer:
//   1. claims a redemption that has settled
//   2. deploys idle USDC above the buffer into the aggregator
//   3. requests a redemption when idle is below the buffer and nothing is pending
//
// Only the agent key can move funds in and out of the aggregator, and only through the
// vault's agent functions. It cannot send USDC to any other address.
//
// Usage:  AGENT_SECRET=S... node agent/agent.mjs [--once]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { createChain, formatUsdc, keypairSigner, toBaseUnits, vault } from "../ui/lib/soroban.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const network = process.env.NETWORK ?? "testnet";
const config = JSON.parse(readFileSync(path.join(root, "deployments", `${network}.json`), "utf8"));
const chain = createChain(config);

const secret = process.env.AGENT_SECRET;
if (!secret) throw new Error("set AGENT_SECRET to the agent's secret key");
if (Keypair.fromSecret(secret).publicKey() !== config.agent) throw new Error("AGENT_SECRET does not match the agent address in the deployment");
const signTx = keypairSigner(secret, config.networkPassphrase);
const minMove = toBaseUnits(process.env.MIN_MOVE_USDC ?? "1");
const tickMs = Number(process.env.TICK_SECONDS ?? 60) * 1000;
const once = process.argv.includes("--once");

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

/** One pass over the vault. Returns the list of actions it took. */
export async function tick() {
  const actions = [];
  const now = Math.floor(Date.now() / 1000);

  const pending = await vault.pendingRedeem(chain);
  if (pending && now >= pending.unlock) {
    const { value } = await vault.agentClaim(chain, { agent: config.agent, signTx });
    actions.push(`claimed ${formatUsdc(value ?? 0n)} USDC`);
  }

  const state = await vault.state(chain);
  const surplus = state.idle - state.buffer;
  if (surplus >= minMove) {
    await vault.agentDeploy(chain, { agent: config.agent, amount: surplus, signTx });
    actions.push(`deployed ${formatUsdc(surplus)} USDC`);
  }

  const deficit = state.buffer - state.idle;
  if (deficit >= minMove && !pending) {
    const deployed = await vault.deployed(chain);
    const amount = deficit < deployed ? deficit : deployed;
    if (amount >= minMove) {
      await vault.agentRequestRedeem(chain, { agent: config.agent, amount, signTx });
      actions.push(`requested redemption of ${formatUsdc(amount)} USDC`);
    }
  }

  return actions;
}

async function main() {
  log(`agent ${config.agent} on ${network}, vault ${config.vault}, buffer ${formatUsdc(config.buffer)} USDC`);
  do {
    try {
      const actions = await tick();
      log(actions.length ? actions.join("; ") : "no action");
    } catch (error) {
      log(`tick failed: ${error.message}`);
    }
    if (!once) await new Promise((resolve) => setTimeout(resolve, tickMs));
  } while (!once);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

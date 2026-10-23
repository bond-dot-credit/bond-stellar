// Shared Soroban client for the pooled vault. Used by the browser UI (wallet signer) and
// the Node agent (keypair signer). Imports stay bare so both environments resolve the same SDK.
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1500;

export function createChain(config) {
  return {
    config,
    server: new rpc.Server(config.rpcUrl),
    passphrase: config.networkPassphrase,
  };
}

/** Converts a human USDC amount ("12.5") to Stellar base units (7 decimals). */
export function toBaseUnits(usdc) {
  const [whole, frac = ""] = String(usdc).trim().split(".");
  if (frac.length > 7) throw new Error("USDC supports at most 7 decimals");
  return BigInt(whole || "0") * 10_000_000n + BigInt(frac.padEnd(7, "0") || "0");
}

/** Formats base units as a USDC string with 2 decimals for display. */
export function formatUsdc(baseUnits) {
  const value = BigInt(baseUnits);
  const whole = value / 10_000_000n;
  const cents = (value % 10_000_000n) / 100_000n;
  return `${whole}.${String(cents).padStart(2, "0")}`;
}

const i128 = (value) => nativeToScVal(BigInt(value), { type: "i128" });
const addr = (value) => new Address(value).toScVal();

/**
 * Read-only call. Simulates without signing. `source` only needs to exist on-chain.
 * Pass a contract id to read from the aggregator instead of the vault.
 */
export async function view(chain, contractId, method, args = [], source = chain.config.admin) {
  const account = await chain.server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: chain.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await chain.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} failed: ${sim.error}`);
  return scValToNative(sim.result.retval);
}

/**
 * State-changing call. `source` is the signing account (depositor or agent).
 * `signTx(xdr) -> signedXdr` is the wallet or keypair signer.
 */
export async function send(chain, { source, contractId, method, args = [], signTx }) {
  const account = await chain.server.getAccount(source);
  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: chain.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();

  const prepared = await chain.server.prepareTransaction(built);
  const signedXdr = await signTx(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, chain.passphrase);

  const sent = await chain.server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`${method} rejected: ${sent.errorResult ? sent.errorResult.toXDR("base64") : sent.status}`);
  }

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const result = await chain.server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") {
      return { hash: sent.hash, value: result.returnValue ? scValToNative(result.returnValue) : null };
    }
    if (result.status === "FAILED") throw new Error(`${method} failed on-chain (${sent.hash})`);
  }
  throw new Error(`${method} still pending after polling (${sent.hash})`);
}

/** A holder's USDC balance in base units. */
export async function usdcBalance(chain, user) {
  return BigInt(await view(chain, chain.config.usdc, "balance", [addr(user)], user));
}

/** Keypair signer for the agent and smoke tests. */
export function keypairSigner(secret, passphrase) {
  const keypair = Keypair.fromSecret(secret);
  return async (xdr) => {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    tx.sign(keypair);
    return tx.toXDR();
  };
}

const vaultCall = (chain, source, method, args, signTx) =>
  send(chain, { source, contractId: chain.config.vault, method, args, signTx });

export const vault = {
  /** Pool-level numbers for the UI and the agent. All amounts are base units (BigInt). */
  async state(chain) {
    const v = (method, args) => view(chain, chain.config.vault, method, args);
    const [totalAssets, idle, totalSupply, cap, buffer, paused, kycOpen] = await Promise.all([
      v("total_assets"),
      v("idle"),
      v("total_supply"),
      v("cap"),
      v("buffer"),
      v("paused"),
      v("kyc_open"),
    ]);
    return {
      totalAssets: BigInt(totalAssets),
      idle: BigInt(idle),
      totalSupply: BigInt(totalSupply),
      cap: BigInt(cap),
      buffer: BigInt(buffer),
      paused,
      kycOpen,
    };
  },

  /** Value held in the aggregator for this vault, including redemptions still settling. */
  async deployed(chain) {
    return BigInt(await view(chain, chain.config.aggregator, "value_of", [addr(chain.config.vault)]));
  },

  /** Redemption the aggregator is settling for this vault: null, or { amount, unlock (unix seconds) }. */
  async pendingRedeem(chain) {
    const pending = await view(chain, chain.config.aggregator, "pending", [addr(chain.config.vault)]);
    return pending ? { amount: BigInt(pending.amount), unlock: Number(pending.unlock) } : null;
  },

  /** A user's shares and their current USDC value. */
  async position(chain, user) {
    const shares = BigInt(await view(chain, chain.config.vault, "balance", [addr(user)], user));
    const value =
      shares === 0n ? 0n : BigInt(await view(chain, chain.config.vault, "preview_withdraw", [i128(shares)], user));
    return { shares, value };
  },

  deposit: (chain, { user, amount, signTx }) =>
    vaultCall(chain, user, "deposit", [addr(user), i128(amount)], signTx),

  withdraw: (chain, { user, shares, signTx }) =>
    vaultCall(chain, user, "withdraw", [addr(user), i128(shares)], signTx),

  agentDeploy: (chain, { agent, amount, signTx }) => vaultCall(chain, agent, "agent_deploy", [i128(amount)], signTx),

  agentRequestRedeem: (chain, { agent, amount, signTx }) =>
    vaultCall(chain, agent, "agent_request_redeem", [i128(amount)], signTx),

  agentClaim: (chain, { agent, signTx }) => vaultCall(chain, agent, "agent_claim", [], signTx),
};

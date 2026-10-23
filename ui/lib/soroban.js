// Shared Soroban client for the pooled vault. Used by the browser console (wallet signer)
// and the Node agent (keypair signer). Imports stay bare so both environments resolve the same SDK.
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1500;
const EVENT_WINDOW_LEDGERS = 8_000;

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
  const value = BigInt(baseUnits ?? 0);
  const whole = value / 10_000_000n;
  const cents = (value % 10_000_000n) / 100_000n;
  return `${whole}.${String(cents).padStart(2, "0")}`;
}

const i128 = (value) => nativeToScVal(BigInt(value), { type: "i128" });
const addr = (value) => new Address(value).toScVal();

/** Argument encoders for admin calls. */
export const arg = {
  i128,
  address: addr,
  bool: (value) => nativeToScVal(Boolean(value), { type: "bool" }),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Submits a signed transaction and polls until it settles. Returns the hash and return value. */
async function submitAndWait(chain, signed, label) {
  const sent = await chain.server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`${label} rejected: ${sent.errorResult ? sent.errorResult.toXDR("base64") : sent.status}`);
  }
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const result = await chain.server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") {
      return { hash: sent.hash, value: result.returnValue ? scValToNative(result.returnValue) : null };
    }
    if (result.status === "FAILED") throw new Error(`${label} failed on-chain (${sent.hash})`);
  }
  throw new Error(`${label} still pending after polling (${sent.hash})`);
}

/**
 * State-changing Soroban call. `source` is the signing account (depositor, agent, or admin).
 * `signTx(xdr) -> signedXdr` is the wallet or keypair signer.
 */
export async function send(chain, { source, contractId, method, args = [], signTx }) {
  const account = await chain.server.getAccount(source);
  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: chain.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
  const prepared = await chain.server.prepareTransaction(built);
  const signed = TransactionBuilder.fromXDR(await signTx(prepared.toXDR()), chain.passphrase);
  return submitAndWait(chain, signed, method);
}

/** Classic XLM payment (used for the agent gas top-up). */
export async function payXlm(chain, { from, to, amount, signTx }) {
  const account = await chain.server.getAccount(from);
  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: chain.passphrase })
    .addOperation(Operation.payment({ destination: to, asset: Asset.native(), amount: String(amount) }))
    .setTimeout(120)
    .build();
  const signed = TransactionBuilder.fromXDR(await signTx(built.toXDR()), chain.passphrase);
  return submitAndWait(chain, signed, "payment");
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

/** Native XLM balance from Horizon, or null when the account isn't funded. */
export async function xlmBalance(chain, account) {
  const response = await fetch(`${chain.config.horizonUrl}/accounts/${account}`);
  if (!response.ok) return null;
  const data = await response.json();
  return data.balances.find((b) => b.asset_type === "native")?.balance ?? null;
}

// Event names are the snake_case of each #[contractevent] struct in pooled-vault.
const EVENT_LABELS = {
  deposited: "deposit",
  withdrawn: "withdraw",
  deployed: "deploy",
  redeem_requested: "request redeem",
  claimed: "claim",
  paused_set: "pause",
  cap_set: "set cap",
  buffer_set: "set buffer",
  agent_set: "set agent",
  kyc_open_set: "kyc mode",
  verified: "verify",
};

const vaultCall = (chain, source, method, args, signTx) =>
  send(chain, { source, contractId: chain.config.vault, method, args, signTx });

export const vault = {
  /** Contract roles and configuration. Addresses are strings. */
  async roles(chain) {
    const v = (method) => view(chain, chain.config.vault, method);
    const [admin, agent, usdc, aggregator] = await Promise.all([v("admin"), v("agent"), v("usdc"), v("aggregator")]);
    return { admin, agent, usdc, aggregator };
  },

  /** Pool-level numbers. All amounts are base units (BigInt). */
  async state(chain) {
    const v = (method) => view(chain, chain.config.vault, method);
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

  /** Share price of the aggregator (1.0 = 10_000_000). */
  async sharePrice(chain) {
    return BigInt(await view(chain, chain.config.aggregator, "price"));
  },

  /** Redemption the aggregator is settling for this vault: null, or { amount, unlock (unix seconds) }. */
  async pendingRedeem(chain) {
    const pending = await view(chain, chain.config.aggregator, "pending", [addr(chain.config.vault)]);
    return pending ? { amount: BigInt(pending.amount), unlock: Number(pending.unlock) } : null;
  },

  async isVerified(chain, user) {
    return Boolean(await view(chain, chain.config.vault, "is_verified", [addr(user)], user));
  },

  /** A user's shares and their current USDC value. */
  async position(chain, user) {
    const shares = BigInt(await view(chain, chain.config.vault, "balance", [addr(user)], user));
    const value =
      shares === 0n ? 0n : BigInt(await view(chain, chain.config.vault, "preview_withdraw", [i128(shares)], user));
    return { shares, value };
  },

  /** A holder's USDC balance in base units. */
  async usdcBalance(chain, user) {
    return BigInt(await view(chain, chain.config.usdc, "balance", [addr(user)], user));
  },

  /**
   * Vault events from `fromLedger` (default: the last ~8k ledgers, about 11 hours).
   * RPC scans a bounded range per call, so callers poll forward from `latestLedger`
   * instead of asking for a longer window. Each item:
   * { id, name, label, txHash, ledger, closedAt, actor, args }, newest first.
   */
  async events(chain, { fromLedger } = {}) {
    const latest = await chain.server.getLatestLedger();
    const startLedger = fromLedger ?? Math.max(1, latest.sequence - EVENT_WINDOW_LEDGERS);
    const response = await chain.server.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [chain.config.vault] }],
      limit: 200,
    });
    const events = response.events
      .map((e) => {
        const name = scValToNative(e.topic[0]);
        return {
          id: e.id,
          name,
          label: EVENT_LABELS[name] ?? name,
          txHash: e.txHash,
          ledger: e.ledger,
          closedAt: e.ledgerClosedAt,
          actor: e.topic[1] ? scValToNative(e.topic[1]) : null,
          args: scValToNative(e.value) ?? {},
        };
      })
      .reverse();
    return { events, latestLedger: latest.sequence };
  },

  deposit: (chain, { user, amount, signTx }) =>
    vaultCall(chain, user, "deposit", [addr(user), i128(amount)], signTx),

  withdraw: (chain, { user, shares, signTx }) =>
    vaultCall(chain, user, "withdraw", [addr(user), i128(shares)], signTx),

  agentDeploy: (chain, { agent, amount, signTx }) => vaultCall(chain, agent, "agent_deploy", [i128(amount)], signTx),

  agentRequestRedeem: (chain, { agent, amount, signTx }) =>
    vaultCall(chain, agent, "agent_request_redeem", [i128(amount)], signTx),

  agentClaim: (chain, { agent, signTx }) => vaultCall(chain, agent, "agent_claim", [], signTx),

  /** Owner-only setters. `method` is one of the vault's admin functions. */
  admin: (chain, { admin, method, args = [], signTx }) => vaultCall(chain, admin, method, args, signTx),
};

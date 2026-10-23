// Pooled vault UI. Bundled with esbuild (see scripts/build-ui.mjs) so the Wallets Kit and
// its wallet modules share one instance.
import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import {
  WalletConnectModule,
  WalletConnectTargetChain,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import { createChain, formatUsdc, toBaseUnits, usdcBalance, vault } from "../lib/soroban.js";

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 15_000;
const EXPLORER = "https://stellar.expert/explorer/testnet/tx";

const state = { chain: null, user: null, position: null, refreshTimer: null };

// ----- wallet -----

async function setupWallet(config) {
  const modules = defaultModules();
  if (config.walletConnectProjectId) {
    modules.push(
      new WalletConnectModule({
        projectId: config.walletConnectProjectId,
        metadata: {
          name: "Bond Stellar",
          description: "Pooled USDC vault on Stellar",
          url: location.origin,
          icons: [],
        },
        allowedChains: [WalletConnectTargetChain.TESTNET],
      }),
    );
  }
  StellarWalletsKit.init({
    modules,
    network: config.network === "testnet" ? Networks.TESTNET : Networks.PUBLIC,
  });
}

async function connect() {
  try {
    const { address } = await StellarWalletsKit.authModal();
    state.user = address;
    $("wallet-button").textContent = shorten(address);
    $("wallet-button").classList.add("connected");
    await refresh();
  } catch (error) {
    notify(`Wallet connection failed: ${error.message ?? error}`, "error");
  }
}

function signerFor(address) {
  return async (xdr) => {
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
      networkPassphrase: state.chain.config.networkPassphrase,
      address,
    });
    return signedTxXdr;
  };
}

// ----- rendering -----

const shorten = (address) => `${address.slice(0, 4)}…${address.slice(-4)}`;

function renderPool(pool) {
  const pct = pool.cap === 0n ? 0 : Number((pool.totalAssets * 10000n) / pool.cap) / 100;
  $("pool-total").textContent = formatUsdc(pool.totalAssets);
  $("pool-cap").textContent = formatUsdc(pool.cap);
  $("cap-fill").style.width = `${Math.min(pct, 100)}%`;
  $("cap-pct").textContent = `${pct.toFixed(0)}% of cap used`;
  $("pool-idle").textContent = formatUsdc(pool.idle);
  $("pool-buffer").textContent = formatUsdc(pool.buffer);
  $("pool-deployed").textContent = formatUsdc(pool.totalAssets - pool.idle);
  $("kyc-badge").textContent = pool.kycOpen ? "KYC: simulated, open to all" : "KYC: verified accounts only";
  $("paused-badge").hidden = !pool.paused;
  $("deposit-remaining").textContent = formatUsdc(pool.cap > pool.totalAssets ? pool.cap - pool.totalAssets : 0n);
  $("deposit-button").disabled = pool.paused || pool.cap <= pool.totalAssets;
}

function renderPosition() {
  const connected = Boolean(state.user);
  $("position-card").hidden = !connected;
  $("connect-prompt").hidden = connected;
  if (!connected || !state.position) return;
  $("position-value").textContent = formatUsdc(state.position.value);
  $("position-shares").textContent = state.position.shares.toString();
  const hasShares = state.position.shares > 0n;
  for (const button of document.querySelectorAll("[data-withdraw-pct]")) button.disabled = !hasShares;
}

function notify(message, kind = "info") {
  const entry = document.createElement("li");
  entry.className = kind;
  entry.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  $("activity").prepend(entry);
}

function notifyTx(label, hash) {
  const entry = document.createElement("li");
  entry.className = "ok";
  const link = document.createElement("a");
  link.href = `${EXPLORER}/${hash}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `${label} · ${hash.slice(0, 8)}…`;
  entry.append(link);
  $("activity").prepend(entry);
}

// ----- data -----

async function refresh() {
  try {
    const pool = await vault.state(state.chain);
    renderPool(pool);
    if (state.user) {
      const [position, wallet] = await Promise.all([
        vault.position(state.chain, state.user),
        usdcBalance(state.chain, state.user),
      ]);
      state.position = position;
      $("wallet-usdc").textContent = formatUsdc(wallet);
      renderPosition();
    }
  } catch (error) {
    notify(`Could not read the vault: ${error.message}`, "error");
  }
}

// ----- actions -----

async function runAction(label, button, action) {
  button.disabled = true;
  notify(`${label}…`);
  try {
    const { hash } = await action();
    notifyTx(label, hash);
    await refresh();
  } catch (error) {
    notify(`${label} failed: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    await refresh();
  }
}

function onDeposit(event) {
  event.preventDefault();
  if (!state.user) return notify("Connect a wallet first", "error");
  const button = $("deposit-button");
  let amount;
  try {
    amount = toBaseUnits($("deposit-amount").value);
  } catch (error) {
    return notify(error.message, "error");
  }
  if (amount <= 0n) return notify("Enter an amount above zero", "error");
  runAction("Deposit", button, () =>
    vault.deposit(state.chain, { user: state.user, amount, signTx: signerFor(state.user) }),
  );
}

function onWithdraw(percent) {
  if (!state.user || !state.position) return;
  const shares = (state.position.shares * BigInt(percent)) / 100n;
  if (shares <= 0n) return notify("Nothing to withdraw", "error");
  const button = document.querySelector(`[data-withdraw-pct="${percent}"]`);
  runAction(`Withdraw ${percent}%`, button, () =>
    vault.withdraw(state.chain, { user: state.user, shares, signTx: signerFor(state.user) }),
  );
}

// ----- boot -----

async function boot() {
  const config = await (await fetch("./config.json")).json();
  state.chain = createChain(config);
  $("network-badge").textContent = config.network;
  $("usdc-issuer").textContent = shorten(config.usdcIssuer);
  $("vault-id").textContent = config.vault;

  await setupWallet(config);
  $("wallet-button").addEventListener("click", connect);
  $("deposit-form").addEventListener("submit", onDeposit);
  for (const button of document.querySelectorAll("[data-withdraw-pct]")) {
    button.addEventListener("click", () => onWithdraw(Number(button.dataset.withdrawPct)));
  }
  for (const link of document.querySelectorAll("[data-fill]")) {
    link.addEventListener("click", () => {
      $("deposit-amount").value = link.dataset.fill === "max" ? $("wallet-usdc").textContent : link.dataset.fill;
    });
  }

  await refresh();
  state.refreshTimer = setInterval(refresh, REFRESH_MS);
}

boot().catch((error) => notify(`Startup failed: ${error.message}`, "error"));

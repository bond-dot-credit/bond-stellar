// Demo-only mock of the Freighter external API (window.postMessage protocol used by
// @stellar/freighter-api). Speaks the exact message types the Stellar Wallets Kit sends,
// and signs with the bond-stellar testnet identities (stellar-alice / stellar-admin)
// pulled from the Stellar CLI keystore at build time. Never use for real funds:
// the secrets live in the built file, which is gitignored.
//
// The active identity is chosen per connect through localStorage "demo.identity"
// ("alice" by default, "admin" for the owner scenes), read at request time.
import { Keypair, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";

const NETWORK = "TESTNET";
const PASSPHRASE = "Test SDF Network ; September 2015";
const HORIZON = "https://horizon-testnet.stellar.org";
const RPC = "https://soroban-testnet.stellar.org";

// Injected by scripts/build-demo-wallet.mjs via esbuild define (see build/ output).
const IDENTITIES = {
  alice: { publicKey: __ALICE_PUBLIC__, secret: __ALICE_SECRET__ },
  admin: { publicKey: __ADMIN_PUBLIC__, secret: __ADMIN_SECRET__ },
};

const active = () => {
  let name = "alice";
  try {
    name = localStorage.getItem("demo.identity") || "alice";
  } catch {}
  if (!IDENTITIES[name]) name = "alice";
  return { name, ...IDENTITIES[name] };
};

// Message types mirrored from @stellar/freighter-api.
const T = {
  SUBMIT_TRANSACTION: "SUBMIT_TRANSACTION",
  SUBMIT_AUTH_ENTRY: "SUBMIT_AUTH_ENTRY",
  SUBMIT_BLOB: "SUBMIT_BLOB",
  REQUEST_NETWORK: "REQUEST_NETWORK",
  REQUEST_NETWORK_DETAILS: "REQUEST_NETWORK_DETAILS",
  REQUEST_CONNECTION_STATUS: "REQUEST_CONNECTION_STATUS",
  REQUEST_ACCESS: "REQUEST_ACCESS",
  REQUEST_PUBLIC_KEY: "REQUEST_PUBLIC_KEY",
  REQUEST_ALLOWED_STATUS: "REQUEST_ALLOWED_STATUS",
};

const respond = (req, payload) =>
  window.postMessage(
    { source: "FREIGHTER_EXTERNAL_MSG_RESPONSE", messagedId: req.messageId, ...payload },
    window.location.origin,
  );

const sign = async (xdr, secret, passphrase) => {
  const approved = await showSignDialog(xdr, passphrase);
  if (!approved) return { signedTransaction: "", signerAddress: "", apiError: "rejected by user" };
  const tx = TransactionBuilder.fromXDR(xdr, passphrase);
  const keypair = Keypair.fromSecret(secret);
  tx.sign(keypair);
  return { signedTransaction: tx.toXDR(), signerAddress: keypair.publicKey() };
};

/** Decode the Soroban call so the dialog can say what is being signed. */
const describe = (xdr, passphrase) => {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase);
    const op = tx.operations[0];
    const fee = `${(Number(tx.fee) / 1e7).toFixed(5)} XLM`;
    const ic = op?.func?.invokeContract;
    if (op?.type === "invokeHostFunction" && ic) {
      const fnName = typeof ic.functionName === "string"
        ? ic.functionName
        : new TextDecoder().decode(ic.functionName.bytes);
      const args = ic.args.map(scValToNative);
      // deposit(user, amount in USDC); withdraw(user, shares) - the mock
      // aggregator's price is 1.0, so shares / 1e13 == USDC value
      const amount =
        fnName === "deposit" && typeof args[1] === "bigint" ? `${(Number(args[1]) / 1e7).toFixed(2)} USDC`
        : fnName === "withdraw" && typeof args[1] === "bigint" ? `${(Number(args[1]) / 1e13).toFixed(2)} USDC`
        : null;
      return { fn: fnName, amount, fee };
    }
    return { fn: op?.type ?? "transaction", amount: null, fee };
  } catch {
    return { fn: "transaction", amount: null, fee: "—" };
  }
};

/** Freighter-style approval popup, anchored like the extension window. Resolves true
 *  on Sign; auto-approves after 5s so a missed driver click can never hang the flow. */
const showSignDialog = (xdr, passphrase) =>
  new Promise((resolve) => {
    const { fn, amount, fee } = describe(xdr, passphrase);
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;top:16px;right:16px;width:372px;background:#ffffff;color:#1c2a35;" +
      "border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.08);" +
      "z-index:2147483647;font-family:-apple-system,system-ui,sans-serif;overflow:hidden;";
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:14px 16px 10px">
        <div style="font-size:15px;font-weight:700;letter-spacing:-.2px">Freighter</div>
        <div style="font-size:10px;font-weight:600;color:#0e7a4f;background:#e6f6ee;border-radius:99px;padding:3px 8px">TESTNET</div>
        <div id="demo-wallet-close" style="margin-left:auto;color:#9aa8b2;font-size:15px;cursor:pointer;line-height:1">×</div>
      </div>
      <div style="padding:0 16px 12px;border-bottom:1px solid #edf1f4">
        <div style="font-size:12px;color:#5d6e7a">localhost:8080 wants to sign a transaction</div>
      </div>
      <div style="padding:12px 16px;font-size:13px;line-height:2">
        <div style="display:flex;justify-content:space-between"><span style="color:#5d6e7a">Operation</span><span style="font-family:ui-monospace,monospace;font-size:12.5px">${fn}(${amount ?? ""})</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#5d6e7a">Network</span><span>Test SDF Network</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#5d6e7a">Fee</span><span>${fee}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#5d6e7a">Source</span><span style="font-family:ui-monospace,monospace;font-size:12.5px">${active().publicKey.slice(0, 4)}…${active().publicKey.slice(-4)}</span></div>
      </div>
      <div style="display:flex;gap:10px;padding:4px 16px 16px">
        <button id="demo-wallet-reject" style="flex:1;padding:11px;border-radius:8px;border:1px solid #d5dde3;background:#fff;color:#44545f;font-size:13.5px;font-weight:600;cursor:pointer">Reject</button>
        <button id="demo-wallet-approve" style="flex:1;padding:11px;border-radius:8px;border:none;background:#0e7a4f;color:#fff;font-size:13.5px;font-weight:700;cursor:pointer">Sign</button>
      </div>`;
    document.body.appendChild(overlay);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(autoTimer);
      overlay.remove();
      resolve(ok);
    };
    overlay.querySelector("#demo-wallet-approve").onclick = () => finish(true);
    overlay.querySelector("#demo-wallet-reject").onclick = () => finish(false);
    overlay.querySelector("#demo-wallet-close").onclick = () => finish(false);
    const autoTimer = setTimeout(() => finish(true), 5000);
  });

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
  const { publicKey, secret } = active();

  switch (data.type) {
    case T.REQUEST_CONNECTION_STATUS:
      return respond(data, { isConnected: true, publicKey });
    case T.REQUEST_ACCESS:
      return respond(data, { publicKey });
    case T.REQUEST_PUBLIC_KEY:
      return respond(data, { publicKey });
    case T.REQUEST_ALLOWED_STATUS:
      return respond(data, { isAllowed: true });
    case T.REQUEST_NETWORK:
      return respond(data, { network: NETWORK, networkPassphrase: PASSPHRASE });
    case T.REQUEST_NETWORK_DETAILS:
      return respond(data, {
        networkDetails: { network: NETWORK, networkName: NETWORK, networkUrl: HORIZON, networkPassphrase: PASSPHRASE, sorobanRpcUrl: RPC },
      });
    case T.SUBMIT_TRANSACTION:
      try {
        return respond(data, await sign(data.transactionXdr, secret, data.networkPassphrase || PASSPHRASE));
      } catch (e) {
        return respond(data, { signedTransaction: "", signerAddress: "", apiError: String(e?.message ?? e) });
      }
    default:
      return respond(data, { apiError: `unsupported demo wallet request: ${data.type}` });
  }
});

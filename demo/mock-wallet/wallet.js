// Demo-only mock of the Freighter external API (window.postMessage protocol used by
// @stellar/freighter-api). Speaks the exact message types the Stellar Wallets Kit sends,
// and signs with the bond-stellar testnet identities (stellar-alice / stellar-admin)
// pulled from the Stellar CLI keystore at build time. Never use for real funds:
// the secrets live in the built file, which is gitignored.
//
// The active identity is chosen per connect through localStorage "demo.identity"
// ("alice" by default, "admin" for the owner scenes), read at request time.
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

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

const sign = (xdr, secret) => {
  const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
  const keypair = Keypair.fromSecret(secret);
  tx.sign(keypair);
  return { signedTransaction: tx.toXDR(), signerAddress: keypair.publicKey() };
};

window.addEventListener("message", (event) => {
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
        return respond(data, sign(data.transactionXdr, secret));
      } catch (e) {
        return respond(data, { signedTransaction: "", signerAddress: "", apiError: String(e?.message ?? e) });
      }
    default:
      return respond(data, { apiError: `unsupported demo wallet request: ${data.type}` });
  }
});

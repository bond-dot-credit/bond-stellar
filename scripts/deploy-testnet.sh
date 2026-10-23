#!/usr/bin/env bash
# Deploy the pooled vault + mock aggregator to Stellar testnet and write the addresses
# the UI and agent read. Idempotent for keys; re-running deploys new contracts.
#
# Testnet has no Circle USDC we control, so this issues a test USDC asset from an
# issuer account and wraps it in a Stellar Asset Contract. Mainnet uses Circle USDC.
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
CAP="${CAP:-1000000000}"          # 100 USDC (7 decimals)
BUFFER="${BUFFER:-100000000}"     # 10 USDC kept idle for withdrawals
DELAY="${DELAY:-60}"              # aggregator redemption delay, seconds
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/deployments/$NETWORK.json"
UI_CONFIG="$ROOT/ui/config.json"
WASM_DIR="$ROOT/contracts/target/wasm32v1-none/release"

case "$NETWORK" in
  testnet)
    RPC_URL="https://soroban-testnet.stellar.org"
    PASSPHRASE="Test SDF Network ; September 2015"
    HORIZON_URL="https://horizon-testnet.stellar.org"
    ;;
  *)
    echo "Unsupported NETWORK=$NETWORK (this script is testnet only)" >&2
    exit 1
    ;;
esac

ensure_key() {
  local name="$1"
  if ! stellar keys address "$name" >/dev/null 2>&1; then
    stellar keys generate "$name" --network "$NETWORK" --fund >/dev/null
    echo "funded $name via friendbot" >&2
  fi
  stellar keys address "$name"
}

echo "== build contracts"
(cd "$ROOT/contracts" && stellar contract build >/dev/null)

echo "== identities"
ADMIN=$(ensure_key stellar-admin)
AGENT=$(ensure_key stellar-agent)
ISSUER=$(ensure_key stellar-usdc-issuer)
ALICE=$(ensure_key stellar-alice)
BOB=$(ensure_key stellar-bob)

echo "== test USDC (classic asset + Stellar Asset Contract)"
USDC_ID=$(stellar contract asset deploy --asset "USDC:$ISSUER" \
  --source stellar-usdc-issuer --network "$NETWORK" 2>/dev/null || true)
if [ -z "$USDC_ID" ]; then
  USDC_ID=$(stellar contract id asset --asset "USDC:$ISSUER" --network "$NETWORK")
fi
echo "USDC SAC: $USDC_ID"

for user in stellar-alice stellar-bob; do
  stellar tx new change-trust --line "USDC:$ISSUER" --source "$user" --network "$NETWORK" >/dev/null 2>&1 || true
done

echo "== deploy mock aggregator"
AGG_ID=$(stellar contract deploy --wasm "$WASM_DIR/mock_aggregator.wasm" \
  --source stellar-admin --network "$NETWORK" --alias bond-mock-aggregator)
stellar contract invoke --id "$AGG_ID" --source stellar-admin --network "$NETWORK" -- \
  initialize --admin_addr "$ADMIN" --usdc_addr "$USDC_ID" --delay_seconds "$DELAY" >/dev/null

echo "== deploy pooled vault"
VAULT_ID=$(stellar contract deploy --wasm "$WASM_DIR/pooled_vault.wasm" \
  --source stellar-admin --network "$NETWORK" --alias bond-pooled-vault)
stellar contract invoke --id "$VAULT_ID" --source stellar-admin --network "$NETWORK" -- \
  initialize --admin_addr "$ADMIN" --agent_addr "$AGENT" --usdc_addr "$USDC_ID" \
  --aggregator_addr "$AGG_ID" --cap_amount "$CAP" --buffer_amount "$BUFFER" >/dev/null

echo "== mint test USDC to users and fund aggregator (yield headroom)"
for user in "$ALICE" "$BOB"; do
  stellar contract invoke --id "$USDC_ID" --source stellar-usdc-issuer --network "$NETWORK" -- \
    mint --to "$user" --amount 2000000000 >/dev/null
done
stellar contract invoke --id "$USDC_ID" --source stellar-usdc-issuer --network "$NETWORK" -- \
  mint --to "$AGG_ID" --amount 1000000000 >/dev/null

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<EOF
{
  "network": "$NETWORK",
  "rpcUrl": "$RPC_URL",
  "horizonUrl": "$HORIZON_URL",
  "networkPassphrase": "$PASSPHRASE",
  "usdc": "$USDC_ID",
  "usdcIssuer": "$ISSUER",
  "vault": "$VAULT_ID",
  "aggregator": "$AGG_ID",
  "admin": "$ADMIN",
  "agent": "$AGENT",
  "cap": "$CAP",
  "buffer": "$BUFFER",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
mkdir -p "$(dirname "$UI_CONFIG")"
cp "$OUT" "$UI_CONFIG"
echo "wrote $OUT and $UI_CONFIG"

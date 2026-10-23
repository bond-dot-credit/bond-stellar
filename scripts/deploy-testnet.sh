#!/usr/bin/env bash
# Deploy the test USDC token, the mock aggregator, and the pooled vault to Stellar testnet,
# then write the addresses the console and agent read. Keys are created once; each run
# deploys new contracts.
#
# The test USDC is a Soroban token (see contracts/test-usdc). It is not Circle USDC and
# has no mainnet use. Wallets receive it without a classic trustline, and the console's
# faucet button mints it on request.
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

invoke() {  # invoke <source> <contract id> <function> [args...]
  local source="$1" id="$2" fn="$3"; shift 3
  stellar contract invoke --id "$id" --source "$source" --network "$NETWORK" -- "$fn" "$@" >/dev/null
}

echo "== build contracts"
(cd "$ROOT/contracts" && stellar contract build >/dev/null)

echo "== identities"
ADMIN=$(ensure_key stellar-admin)
AGENT=$(ensure_key stellar-agent)
ALICE=$(ensure_key stellar-alice)
BOB=$(ensure_key stellar-bob)

echo "== deploy test USDC"
USDC_ID=$(stellar contract deploy --wasm "$WASM_DIR/test_usdc.wasm" \
  --source stellar-admin --network "$NETWORK" --alias bond-test-usdc)
invoke stellar-admin "$USDC_ID" initialize --admin "$ADMIN"
echo "test USDC: $USDC_ID"

echo "== deploy mock aggregator"
AGG_ID=$(stellar contract deploy --wasm "$WASM_DIR/mock_aggregator.wasm" \
  --source stellar-admin --network "$NETWORK" --alias bond-mock-aggregator)
invoke stellar-admin "$AGG_ID" initialize --admin_addr "$ADMIN" --usdc_addr "$USDC_ID" --delay_seconds "$DELAY"

echo "== deploy pooled vault"
VAULT_ID=$(stellar contract deploy --wasm "$WASM_DIR/pooled_vault.wasm" \
  --source stellar-admin --network "$NETWORK" --alias bond-pooled-vault)
invoke stellar-admin "$VAULT_ID" initialize --admin_addr "$ADMIN" --agent_addr "$AGENT" --usdc_addr "$USDC_ID" \
  --aggregator_addr "$AGG_ID" --cap_amount "$CAP" --buffer_amount "$BUFFER"

echo "== mint test USDC to test users and fund the aggregator (yield headroom)"
invoke stellar-admin "$USDC_ID" mint --to "$ALICE" --amount 2000000000
invoke stellar-admin "$USDC_ID" mint --to "$BOB" --amount 2000000000
invoke stellar-admin "$USDC_ID" mint --to "$AGG_ID" --amount 1000000000

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<JSON
{
  "network": "$NETWORK",
  "rpcUrl": "$RPC_URL",
  "horizonUrl": "$HORIZON_URL",
  "networkPassphrase": "$PASSPHRASE",
  "usdc": "$USDC_ID",
  "vault": "$VAULT_ID",
  "aggregator": "$AGG_ID",
  "admin": "$ADMIN",
  "agent": "$AGENT",
  "cap": "$CAP",
  "buffer": "$BUFFER",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
mkdir -p "$(dirname "$UI_CONFIG")"
cp "$OUT" "$UI_CONFIG"
echo "wrote $OUT and $UI_CONFIG"

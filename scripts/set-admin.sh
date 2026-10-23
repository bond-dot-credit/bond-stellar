#!/usr/bin/env bash
# Hand the pool's admin role to another address. The current admin key signs.
# Usage: scripts/set-admin.sh G...   (the new admin's public key)
set -euo pipefail

NEW_ADMIN="${1:?usage: set-admin.sh G...}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deployments/testnet.json"
VAULT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['vault'])" "$DEPLOY")

stellar contract invoke --id "$VAULT" --source stellar-admin --network testnet -- \
  set_admin --new_admin "$NEW_ADMIN" >/dev/null

python3 - "$DEPLOY" "$ROOT/ui/config.json" "$NEW_ADMIN" <<'PY'
import json, sys
for path in sys.argv[1:3]:
    data = json.load(open(path))
    data["admin"] = sys.argv[3]
    json.dump(data, open(path, "w"), indent=2)
    open(path, "a").write("\n")
PY
echo "admin is now $NEW_ADMIN"

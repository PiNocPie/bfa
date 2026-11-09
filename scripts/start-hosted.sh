#!/bin/sh
# One container runs everything: the demo seller (internal, port 8402) and the gateway, which serves the
# website, the console API (/api) and the MCP endpoint (/v1) on $PORT.
# Secrets come from the host's environment (Railway Variables): BFA_SECRET_KEY, NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY,
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Everything below is a non-secret default that a variable can override.
set -eu

APP="${BFA_APP_DIR:-/app}"
DATA="${BFA_DATA_DIR:-/data}"
mkdir -p "$DATA/gateway" "$DATA/seller" "$DATA/facilitator"

export NEAR_NETWORK="${NEAR_NETWORK:-testnet}"
export BFA_TREASURY_ID="${BFA_TREASURY_ID:-treasury.nen-testnet.testnet}"
export BFA_TOPUP_FACTORY="${BFA_TOPUP_FACTORY:-0xd0fd9f5a17cdc84873a836c4c2971b2ae941340f}"
export BFA_GATEWAY_STATE_DIR="${BFA_GATEWAY_STATE_DIR:-$DATA/gateway}"
export BFA_WEB_DIR="${BFA_WEB_DIR:-$APP/packages/web/dist}"
export BFA_DEV_REGISTRY_DIR="${BFA_DEV_REGISTRY_DIR:-$APP/examples/dev-registry}"
export BFA_GATEWAY_HOST="${BFA_GATEWAY_HOST:-0.0.0.0}"
export BFA_SECURE_COOKIES="${BFA_SECURE_COOKIES:-1}"

# BFA's own x402 facilitator (internal, port 8403): settles testnet payments with its own gas wallet, so paid
# calls don't depend on a public facilitator having gas. Its key is created on first start under $DATA/facilitator;
# fund the address it prints (also at GET /api/config → facilitator) with a little Base Sepolia ETH.
BFA_FACILITATOR_STATE_DIR="$DATA/facilitator" FACILITATOR_PORT=8403 \
  node "$APP/packages/demo-seller/dist/facilitator.js" &
FACILITATOR_PID=$!
# Wait until it answers: the seller reads the facilitator's supported schemes once at startup.
for i in $(seq 1 30); do
  node -e "fetch('http://127.0.0.1:8403/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" && break
  sleep 1
done
export X402_FACILITATOR_URL="${X402_FACILITATOR_URL:-http://127.0.0.1:8403}"
export BFA_FACILITATOR_URL="${BFA_FACILITATOR_URL:-$X402_FACILITATOR_URL}"

# Demo seller: sells bfa/near-account for $0.001 per call; reached by the gateway over loopback.
SELLER_PAY_TO="${SELLER_PAY_TO:-0x11F4555ABdaa2BC5b39A172E39b69E8293ad4aA3}" \
BFA_SELLER_STATE_DIR="$DATA/seller" PORT=8402 \
  node "$APP/packages/demo-seller/dist/server.js" &
SELLER_PID=$!

node "$APP/packages/gateway/dist/main.js" &
GATEWAY_PID=$!

trap 'kill $SELLER_PID $GATEWAY_PID $FACILITATOR_PID 2>/dev/null' TERM INT
# Exit (and let the host restart us) if either process dies.
while kill -0 $SELLER_PID 2>/dev/null && kill -0 $GATEWAY_PID 2>/dev/null && kill -0 $FACILITATOR_PID 2>/dev/null; do sleep 5; done
kill $SELLER_PID $GATEWAY_PID $FACILITATOR_PID 2>/dev/null || true
exit 1

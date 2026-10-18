#!/bin/sh
# Runs every end-to-end suite against a running local worker.
#   1. cd worker && npx wrangler dev --local --port 8787
#   2. npm run test:e2e
set -e
API="${API:-http://127.0.0.1:8787}"
WS="${BASE:-ws://127.0.0.1:8787}"
export API BASE="$WS"
node scripts/e2e-site-api.mjs
node scripts/e2e-live-ot.mjs

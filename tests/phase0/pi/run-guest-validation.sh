#!/usr/bin/env bash
# Run the complete Pi RPC + mock-model + real guest-agent validation.
set -euo pipefail
cd /home/aib/pi-validation
export PATH="/home/aib/pi-validation/node/bin:/home/aib/pi-validation/npm-global/bin:$PATH"
export AGENT_IN_BOX_GUEST_URL="http://127.0.0.1:7611"
export AGENT_IN_BOX_GUEST_TOKEN="$(cat /home/aib/.agent-in-box-token)"
export MOCK_MODEL_LOG="/home/aib/pi-validation/mock-model.jsonl"
export AIB_PI_WORK="/home/aib/pi-validation"
export AIB_PI_EXTENSION="/home/aib/pi-validation/cua-extension.js"
export AIB_PI_BINARY="/home/aib/pi-validation/npm-global/bin/pi"

: >"$MOCK_MODEL_LOG"
rm -f /tmp/aib-pi-cua-ok
nohup node mock-model-server.mjs >mock-model-server.log 2>&1 </dev/null &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null || true' EXIT
sleep 1
node run-rpc-validation.mjs

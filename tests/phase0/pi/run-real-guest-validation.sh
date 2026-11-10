#!/usr/bin/env bash
# Run real-model Pi validation through the WSL Model Broker. The guest receives
# only the local broker token, never the upstream provider key.
set -euo pipefail
cd /home/aib/pi-validation
export PATH="/home/aib/pi-validation/node/bin:/home/aib/pi-validation/npm-global/bin:$PATH"
export AGENT_IN_BOX_GUEST_URL="http://127.0.0.1:7611"
export AGENT_IN_BOX_GUEST_TOKEN="$(cat /home/aib/.agent-in-box-token)"
export AIB_PI_WORK="/home/aib/pi-real-validation"
export AIB_REAL_MODEL="${AIB_REAL_MODEL:-pro}"
broker_token="$(cat /home/aib/pi-validation/broker-token)"

cat >/home/aib/.pi/agent/models.json <<EOF
{
  "providers": {
    "mock": {
      "baseUrl": "http://127.0.0.1:4000/v1",
      "api": "openai-completions",
      "apiKey": "mock",
      "models": [{ "id": "mock-cua", "input": ["text", "image"] }]
    },
    "broker": {
      "baseUrl": "http://10.0.2.2:6719/v1",
      "api": "openai-completions",
      "apiKey": "$broker_token",
      "models": [
        { "id": "pro", "input": ["text", "image"] },
        { "id": "flash", "input": ["text", "image"] },
        { "id": "expert", "input": ["text", "image"] }
      ]
    }
  }
}
EOF

rm -f /tmp/aib-real-model-ok
node run-real-rpc-validation.mjs

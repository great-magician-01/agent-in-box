#!/usr/bin/env bash
# Install a fixed Node/Pi toolchain inside the validation guest, without sudo.
set -euo pipefail
cd /home/aib/pi-validation
mkdir -p node npm-global
if [ ! -x node/bin/node ]; then
  tar -xJf node-v24.18.0-linux-x64.tar.xz -C node --strip-components=1
fi
export PATH="/home/aib/pi-validation/node/bin:/home/aib/pi-validation/npm-global/bin:$PATH"
node --version
npm config set registry https://registry.npmmirror.com
npm config set prefix /home/aib/pi-validation/npm-global
npm install -g @earendil-works/pi-coding-agent@1.5.1
pi --version

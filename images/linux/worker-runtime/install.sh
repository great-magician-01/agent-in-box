#!/usr/bin/env bash
# Agent-in-Box Guest Worker runtime installer.
#
# Run this once as root inside the Linux guest (a booted VM with systemd). It:
#   - installs Node.js 24.18.0 from an explicit archive and verifies its version;
#   - installs @earendil-works/pi-coding-agent 1.5.1 from an explicit npm tarball;
#   - installs a self-contained agent-runtime worker bundle whose archive root
#     contains dist/worker-rpc-main.js (CommonJS);
#   - creates the unprivileged aib-worker user, workspace and state directories;
#   - installs the systemd unit and enables (but does not start) the service.
#
# The service always runs as aib-worker. This installer never generates provider
# API keys or Model Broker tokens, and it does not create any models.json.
#
# Security rules enforced here:
#   - every input path is explicit and absolute; the current working directory is
#     never used or executed from;
#   - archives and the Pi package are copied into a root-only staging directory
#     and checked against caller-supplied SHA-256 values before use;
#   - the worker RPC token is only copied from an explicit root-owned staging
#     file supplied by controlled provisioning; no token is generated here.
#
# Exit codes: 2 usage/path, 3 privilege/platform, 4 input/archive,
#             5 checksum mismatch, 6 pinned version mismatch,
#             7 installation/state, 8 systemd integration.

set -euo pipefail
umask 022

readonly NODE_VERSION="24.18.0"
readonly PI_VERSION="1.5.1"
readonly WORKER_PORT="7612"

readonly WORKER_USER="aib-worker"
readonly WORKER_GROUP="aib-worker"
readonly WORKER_HOME="/home/aib-worker"
readonly WORKSPACE_DIR="/home/aib-worker/workspace"

readonly OPT_ROOT="/opt/agent-in-box"
readonly NODE_DIR="${OPT_ROOT}/node-${NODE_VERSION}"
readonly NODE_LINK="${OPT_ROOT}/node"
readonly PI_DIR="${OPT_ROOT}/pi-${PI_VERSION}"
readonly PI_LINK="${OPT_ROOT}/pi"
readonly WORKER_RELEASES="${OPT_ROOT}/worker-releases"
readonly WORKER_LINK="${OPT_ROOT}/worker"

readonly EXT_DIR="${OPT_ROOT}/extensions"
readonly CUA_EXTENSION_FILE="${EXT_DIR}/cua-extension.js"

readonly STATE_ROOT="/var/lib/agent-in-box"
readonly WORKER_STATE="${STATE_ROOT}/worker"
readonly SESSION_ROOT="${WORKER_STATE}/sessions"
readonly RPC_TOKEN_FILE="${WORKER_STATE}/rpc-token"

readonly CONFIG_DIR="/etc/agent-in-box/worker"
readonly WORKER_ENV_FILE="${CONFIG_DIR}/worker.env"
readonly UNIT_NAME="agent-in-box-worker.service"
readonly UNIT_DEST="/etc/systemd/system/${UNIT_NAME}"
readonly UNIT_DROPIN_DIR="/etc/systemd/system/${UNIT_NAME}.d"
readonly CUA_DROPIN="${UNIT_DROPIN_DIR}/10-cua-extension.conf"
readonly MANIFEST_FILE="${OPT_ROOT}/install-manifest.json"

readonly SHA256_RE='^[0-9a-fA-F]{64}$'

SCRIPT_DIR="$(unset CDPATH; cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly ENV_EXAMPLE_SRC="${SCRIPT_DIR}/worker.env.example"
UNIT_SRC="${SCRIPT_DIR}/agent-in-box-worker.service"

NODE_ARCHIVE=""
NODE_SHA256=""
PI_PACKAGE=""
PI_SHA256=""
WORKER_BUNDLE=""
WORKER_SHA256=""
RPC_TOKEN_SRC=""
CUA_EXTENSION_SRC=""
UNIT_SRC_ARG=""

STAGE_DIR=""
LAST_SHA=""
WORKER_BUNDLE_SHA=""
RPC_TOKEN_PRESENT=0
CUA_EXTENSION_INSTALLED=0

usage() {
  cat <<'EOF'
Usage:
  install.sh \
    --node-archive PATH --node-sha256 SHA256 \
    --pi-package PATH --pi-sha256 SHA256 \
    --worker-bundle PATH --worker-sha256 SHA256 \
    [--rpc-token-file PATH] [--cua-extension PATH] [--unit-file PATH]

Required (absolute paths):
  --node-archive PATH    Official Node.js v24.18.0 linux archive (.tar.xz).
  --node-sha256 SHA256   64-hex SHA-256 of the Node archive.
  --pi-package PATH      npm tarball of @earendil-works/pi-coding-agent 1.5.1.
  --pi-sha256 SHA256     64-hex SHA-256 of the Pi tarball.
  --worker-bundle PATH   Self-contained agent-runtime worker .tar.gz. The
                         archive root must contain dist/worker-rpc-main.js.
  --worker-sha256 SHA256 64-hex SHA-256 of the worker bundle.

Optional (absolute paths):
  --rpc-token-file PATH  Root-owned staging file (mode 0600) containing the
                         per-VM worker RPC bearer token. It is copied to
                         /var/lib/agent-in-box/worker/rpc-token with mode 0600.
                         This installer never creates a token.
  --cua-extension PATH   Optional Pi extension implementing Computer Use tools.
                         It is installed below /opt/agent-in-box/extensions and
                         exposed through the optional AGENT_IN_BOX_CUA_EXTENSION.
  --unit-file PATH       systemd unit to install. Defaults to the sibling
                         agent-in-box-worker.service of this script.

The installer enables agent-in-box-worker.service but does not start it. Start it
after the RPC token has been provisioned:
  systemctl start agent-in-box-worker.service

Do not put provider API keys or Model Broker tokens in any argument, file or
environment consumed by this installer.
EOF
}

die() {
  local code=$1
  shift
  printf 'agent-in-box worker install: ERROR: %s\n' "$*" >&2
  exit "$code"
}

note() {
  printf 'agent-in-box worker install: %s\n' "$*"
}

warn() {
  printf 'agent-in-box worker install: WARNING: %s\n' "$*" >&2
}

cleanup() {
  if [[ -n "${STAGE_DIR}" && -d "${STAGE_DIR}" && "${STAGE_DIR}" == "${OPT_ROOT}"/.install.* ]]; then
    rm -rf -- "${STAGE_DIR}"
  fi
}
trap cleanup EXIT

parse_args() {
  if [[ $# -eq 0 ]]; then
    usage >&2
    exit 2
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --node-archive)
        [[ $# -ge 2 ]] || die 2 "missing value for --node-archive"
        NODE_ARCHIVE="$2"
        shift 2
        ;;
      --node-sha256)
        [[ $# -ge 2 ]] || die 2 "missing value for --node-sha256"
        NODE_SHA256="$2"
        shift 2
        ;;
      --pi-package)
        [[ $# -ge 2 ]] || die 2 "missing value for --pi-package"
        PI_PACKAGE="$2"
        shift 2
        ;;
      --pi-sha256)
        [[ $# -ge 2 ]] || die 2 "missing value for --pi-sha256"
        PI_SHA256="$2"
        shift 2
        ;;
      --worker-bundle)
        [[ $# -ge 2 ]] || die 2 "missing value for --worker-bundle"
        WORKER_BUNDLE="$2"
        shift 2
        ;;
      --worker-sha256)
        [[ $# -ge 2 ]] || die 2 "missing value for --worker-sha256"
        WORKER_SHA256="$2"
        shift 2
        ;;
      --rpc-token-file)
        [[ $# -ge 2 ]] || die 2 "missing value for --rpc-token-file"
        RPC_TOKEN_SRC="$2"
        shift 2
        ;;
      --cua-extension)
        [[ $# -ge 2 ]] || die 2 "missing value for --cua-extension"
        CUA_EXTENSION_SRC="$2"
        shift 2
        ;;
      --unit-file)
        [[ $# -ge 2 ]] || die 2 "missing value for --unit-file"
        UNIT_SRC_ARG="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      --)
        shift
        break
        ;;
      *)
        die 2 "unknown argument: $1 (run with --help for usage)"
        ;;
    esac
  done

  if [[ $# -ne 0 ]]; then
    die 2 "unexpected positional argument: $1"
  fi

  if [[ -n "${UNIT_SRC_ARG}" ]]; then
    UNIT_SRC="${UNIT_SRC_ARG}"
  fi

  [[ -n "${NODE_ARCHIVE}" ]] || die 2 "--node-archive is required"
  [[ -n "${NODE_SHA256}" ]] || die 2 "--node-sha256 is required"
  [[ -n "${PI_PACKAGE}" ]] || die 2 "--pi-package is required"
  [[ -n "${PI_SHA256}" ]] || die 2 "--pi-sha256 is required"
  [[ -n "${WORKER_BUNDLE}" ]] || die 2 "--worker-bundle is required"
  [[ -n "${WORKER_SHA256}" ]] || die 2 "--worker-sha256 is required"

  local value
  for value in \
    "${NODE_ARCHIVE}" "${PI_PACKAGE}" "${WORKER_BUNDLE}" \
    "${UNIT_SRC}" "${ENV_EXAMPLE_SRC}" ${RPC_TOKEN_SRC:+"${RPC_TOKEN_SRC}"} \
    ${CUA_EXTENSION_SRC:+"${CUA_EXTENSION_SRC}"}; do
    [[ "${value}" == /* ]] || die 2 "input path must be absolute: ${value}"
  done
  for value in "${NODE_SHA256}" "${PI_SHA256}" "${WORKER_SHA256}"; do
    [[ "${value}" =~ ${SHA256_RE} ]] || die 2 "SHA-256 must be 64 hexadecimal characters: ${value}"
  done
}

require_platform() {
  [[ "$(uname -s)" == "Linux" ]] || die 3 "this installer only supports Linux"

  if [[ "${EUID}" -ne 0 ]]; then
    die 3 "must run as root (service processes will still run as ${WORKER_USER})"
  fi

  if [[ ! -d /run/systemd/system ]]; then
    die 3 "systemd is not running; run this installer inside the booted Linux guest"
  fi

  local cmd
  for cmd in install mktemp tar xz gzip sha256sum stat getent groupadd useradd \
             systemctl awk grep date dirname chown chmod ln mv rm; do
    command -v "${cmd}" >/dev/null 2>&1 || die 3 "required command not found: ${cmd}"
  done

  # Refuse to load sibling assets from a directory that unprivileged users can
  # modify. This keeps execution independent of any untrusted current directory.
  local script_dir_mode
  script_dir_mode="$(stat -c '%a' -- "${SCRIPT_DIR}")" || die 4 "cannot stat ${SCRIPT_DIR}"
  if (( (8#${script_dir_mode} & 0022) != 0 )); then
    die 4 "installer directory is group/other writable: ${SCRIPT_DIR}; provision from a root-owned or read-only directory"
  fi

  require_root_owned_directory /opt
  require_root_owned_directory /var/lib
  require_root_owned_directory /etc
  require_root_owned_directory /etc/systemd/system
  require_root_owned_directory /home
}

require_root_owned_directory() {
  local dir=$1
  local uid mode
  [[ -d "${dir}" && ! -L "${dir}" ]] || die 7 "expected a root-owned directory: ${dir}"
  uid="$(stat -c '%u' -- "${dir}")" || die 7 "cannot stat ${dir}"
  mode="$(stat -c '%a' -- "${dir}")" || die 7 "cannot stat ${dir}"
  [[ "${uid}" == "0" ]] || die 7 "directory must be root-owned: ${dir}"
  if (( (8#${mode} & 0022) != 0 )); then
    die 7 "directory must not be group/other writable: ${dir}"
  fi
}

require_regular_input() {
  local path=$1
  local label=$2
  [[ -f "${path}" && ! -L "${path}" ]] || die 4 "${label} must be a regular, non-symlink file: ${path}"
  [[ -r "${path}" ]] || die 4 "${label} is not readable: ${path}"

  local mode
  mode="$(stat -c '%a' -- "${path}")" || die 4 "cannot stat ${label}: ${path}"
  if (( (8#${mode} & 0022) != 0 )); then
    die 4 "${label} must not be group/other writable: ${path}"
  fi
}

require_token_input() {
  local path=$1
  require_regular_input "${path}" "RPC token staging file"

  local uid mode size
  uid="$(stat -c '%u' -- "${path}")" || die 4 "cannot stat RPC token staging file: ${path}"
  mode="$(stat -c '%a' -- "${path}")" || die 4 "cannot stat RPC token staging file: ${path}"
  size="$(stat -c '%s' -- "${path}")" || die 4 "cannot stat RPC token staging file: ${path}"

  [[ "${uid}" == "0" ]] || die 4 "RPC token staging file must be owned by root: ${path}"
  if (( (8#${mode} & 0077) != 0 )); then
    die 4 "RPC token staging file must not grant group/other permissions (use mode 0600): ${path}"
  fi
  if (( size < 1 || size > 4096 )); then
    die 4 "RPC token staging file must be a small non-empty file (1..4096 bytes): ${path}"
  fi
}

copy_root_only() {
  local src=$1
  local dst=$2
  local label=$3
  require_regular_input "${src}" "${label}"
  install -m 0400 -o root -g root "${src}" "${dst}" || die 4 "failed to copy ${label}: ${src}"
  chown root:root "${dst}" || die 4 "failed to set ownership on staged ${label}"
}

sha256_of() {
  sha256sum -- "$1" | awk '{print $1}'
}

verify_sha256() {
  local path=$1
  local expected=$2
  local label=$3
  local actual

  actual="$(sha256_of "${path}")" || die 5 "cannot hash ${label}: ${path}"
  actual="${actual,,}"
  expected="${expected,,}"

  if [[ "${actual}" != "${expected}" ]]; then
    die 5 "${label} SHA-256 mismatch: expected ${expected}, got ${actual} (${path})"
  fi

  LAST_SHA="${actual}"
  note "${label} SHA-256 verified: ${actual}"
}

assert_safe_archive_paths() {
  local archive=$1
  local kind=$2
  local label=$3
  local listing entry

  case "${kind}" in
    xz) listing="$(tar -tJf "${archive}")" || die 4 "cannot list ${label}: ${archive}" ;;
    gz) listing="$(tar -tzf "${archive}")" || die 4 "cannot list ${label}: ${archive}" ;;
    *) die 99 "internal error: unsupported archive kind ${kind}" ;;
  esac

  while IFS= read -r entry; do
    [[ -z "${entry}" ]] && continue
    case "${entry}" in
      /*) die 4 "${label} contains an absolute archive path: ${entry}" ;;
    esac
    case "/${entry}/" in
      */../*) die 4 "${label} contains a parent-directory path: ${entry}" ;;
    esac
  done <<<"${listing}"
}

extract_archive() {
  local archive=$1
  local kind=$2
  local dest=$3
  local strip=$4
  local label=$5
  local compression_option

  case "${kind}" in
    xz) compression_option="--xz" ;;
    gz) compression_option="--gzip" ;;
    *) die 99 "internal error: unsupported archive kind ${kind}" ;;
  esac

  if ! tar --extract "${compression_option}" --file "${archive}" --directory "${dest}" \
      --strip-components="${strip}" --no-same-owner --no-same-permissions; then
    die 4 "failed to extract ${label}: ${archive}"
  fi
}

install_node() {
  local node_copy="$1"
  local node_stage="${STAGE_DIR}/node"
  local version_line

  note "extracting Node.js ${NODE_VERSION}"
  assert_safe_archive_paths "${node_copy}" xz "Node archive"
  install -d -m 0700 "${node_stage}"
  extract_archive "${node_copy}" xz "${node_stage}" 1 "Node archive"

  [[ -x "${node_stage}/bin/node" ]] || die 4 "Node archive does not contain an executable bin/node"
  [[ -x "${node_stage}/bin/npm" ]] || die 4 "Node archive does not contain an executable bin/npm"

  if ! version_line="$("${node_stage}/bin/node" --version 2>&1)"; then
    die 6 "cannot execute the staged Node binary; check the guest architecture"
  fi
  version_line="${version_line//$'\r'/}"
  [[ "${version_line}" == "v${NODE_VERSION}" ]] \
    || die 6 "Node version mismatch: expected v${NODE_VERSION}, got '${version_line}'"

  chown -R root:root "${node_stage}"
  chmod -R a+rX,go-w,u-s,g-s "${node_stage}"

  if [[ -e "${NODE_DIR}" || -L "${NODE_DIR}" ]]; then
    rm -rf -- "${NODE_DIR}"
  fi
  mv -- "${node_stage}" "${NODE_DIR}"

  if [[ -e "${NODE_LINK}" && ! -L "${NODE_LINK}" ]]; then
    die 7 "${NODE_LINK} exists but is not a symlink; refusing to overwrite it"
  fi
  ln -sfn -- "${NODE_DIR}" "${NODE_LINK}"

  version_line="$("${NODE_LINK}/bin/node" --version 2>&1)" \
    || die 6 "installed Node binary is not executable"
  [[ "${version_line//$'\r'/}" == "v${NODE_VERSION}" ]] \
    || die 6 "installed Node version is '${version_line}', expected v${NODE_VERSION}"
  note "Node.js ${NODE_VERSION} installed at ${NODE_DIR}"
}

install_pi() {
  local pi_copy="$1"
  local pi_stage="${STAGE_DIR}/pi"
  local npm_cache="${STAGE_DIR}/npm-cache"
  local npm_home="${STAGE_DIR}/npm-home"
  local empty_npmrc="${STAGE_DIR}/empty-npmrc"
  local pi_package_dir="${pi_stage}/lib/node_modules/@earendil-works/pi-coding-agent"
  local pi_pkg_version pi_reported pi_version_re

  note "installing Pi ${PI_VERSION} from verified npm tarball"
  install -d -m 0755 "${pi_stage}"
  install -d -m 0700 "${npm_cache}" "${npm_home}"
  : >"${empty_npmrc}"
  chmod 0600 "${empty_npmrc}"

  if ! PATH="${NODE_LINK}/bin:/usr/local/bin:/usr/bin:/bin" \
       HOME="${npm_home}" \
       npm_config_cache="${npm_cache}" \
       npm_config_userconfig="${empty_npmrc}" \
       npm_config_update_notifier=false \
       "${NODE_LINK}/bin/npm" install \
         --global \
         --prefix "${pi_stage}" \
         --ignore-scripts \
         --no-audit \
         --no-fund \
         "${pi_copy}"; then
    die 7 "npm failed to install Pi ${PI_VERSION}; registry access is required unless an npm cache is provided by the build environment"
  fi

  [[ -f "${pi_package_dir}/package.json" && ! -L "${pi_package_dir}/package.json" ]] \
    || die 7 "Pi package was not installed at the expected prefix: ${pi_package_dir}"
  [[ -x "${pi_stage}/bin/pi" ]] || die 7 "Pi package does not provide an executable bin/pi"

  pi_pkg_version="$("${NODE_LINK}/bin/node" -e \
    'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.version||""))' \
    "${pi_package_dir}/package.json")" \
    || die 6 "cannot read the installed Pi package version"
  [[ "${pi_pkg_version}" == "${PI_VERSION}" ]] \
    || die 6 "Pi package version mismatch: expected ${PI_VERSION}, got '${pi_pkg_version}'"

  if ! pi_reported="$(HOME="${npm_home}" PATH="${NODE_LINK}/bin:/usr/local/bin:/usr/bin:/bin" \
      "${pi_stage}/bin/pi" --version 2>&1)"; then
    die 6 "installed Pi binary failed to report its version"
  fi
  pi_reported="${pi_reported//$'\r'/}"
  pi_version_re="(^|[^0-9.])${PI_VERSION//./\\.}([^0-9.]|$)"
  [[ "${pi_reported}" =~ ${pi_version_re} ]] \
    || die 6 "Pi binary reported '${pi_reported}', expected version ${PI_VERSION}"

  chown -R root:root "${pi_stage}"
  chmod -R a+rX,go-w,u-s,g-s "${pi_stage}"

  if [[ -e "${PI_DIR}" || -L "${PI_DIR}" ]]; then
    rm -rf -- "${PI_DIR}"
  fi
  mv -- "${pi_stage}" "${PI_DIR}"

  if [[ -e "${PI_LINK}" && ! -L "${PI_LINK}" ]]; then
    die 7 "${PI_LINK} exists but is not a symlink; refusing to overwrite it"
  fi
  ln -sfn -- "${PI_DIR}" "${PI_LINK}"

  if ! pi_reported="$(HOME="${npm_home}" PATH="${NODE_LINK}/bin:/usr/local/bin:/usr/bin:/bin" \
      "${PI_LINK}/bin/pi" --version 2>&1)"; then
    die 6 "installed Pi binary at ${PI_LINK} failed to report its version"
  fi
  pi_reported="${pi_reported//$'\r'/}"
  [[ "${pi_reported}" =~ ${pi_version_re} ]] \
    || die 6 "Pi at ${PI_LINK} reported '${pi_reported}', expected version ${PI_VERSION}"

  note "Pi ${PI_VERSION} installed at ${PI_DIR}"
}

install_worker() {
  local worker_copy="$1"
  local worker_stage="${STAGE_DIR}/worker"
  local main_file="${worker_stage}/dist/worker-rpc-main.js"
  local worker_release

  note "extracting agent-runtime worker bundle"
  assert_safe_archive_paths "${worker_copy}" gz "Worker bundle"
  install -d -m 0700 "${worker_stage}"
  extract_archive "${worker_copy}" gz "${worker_stage}" 0 "Worker bundle"

  [[ -f "${main_file}" && ! -L "${main_file}" ]] \
    || die 4 "worker bundle must contain a regular dist/worker-rpc-main.js at its archive root"
  if ! "${NODE_LINK}/bin/node" --check "${main_file}"; then
    die 4 "worker bundle entry dist/worker-rpc-main.js is not valid CommonJS"
  fi

  chown -R root:root "${worker_stage}"
  chmod -R a+rX,go-w,u-s,g-s "${worker_stage}"

  worker_release="${WORKER_RELEASES}/${WORKER_BUNDLE_SHA}"
  install -d -m 0755 -o root -g root "${WORKER_RELEASES}"
  if [[ -e "${worker_release}" || -L "${worker_release}" ]]; then
    rm -rf -- "${worker_release}"
  fi
  mv -- "${worker_stage}" "${worker_release}"

  if [[ -e "${WORKER_LINK}" && ! -L "${WORKER_LINK}" ]]; then
    die 7 "${WORKER_LINK} exists but is not a symlink; refusing to overwrite it"
  fi
  ln -sfn -- "${worker_release}" "${WORKER_LINK}"

  if ! "${NODE_LINK}/bin/node" --check "${WORKER_LINK}/dist/worker-rpc-main.js"; then
    die 7 "installed worker entry is not valid CommonJS"
  fi

  note "worker bundle ${WORKER_BUNDLE_SHA} installed at ${worker_release}"
}

create_worker_identity_and_directories() {
  local existing_home existing_uid group

  if ! getent group "${WORKER_GROUP}" >/dev/null 2>&1; then
    groupadd --system "${WORKER_GROUP}" || die 7 "failed to create group ${WORKER_GROUP}"
  fi

  if ! id -u "${WORKER_USER}" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "${WORKER_HOME}" \
      --shell /bin/bash --gid "${WORKER_GROUP}" "${WORKER_USER}" \
      || die 7 "failed to create user ${WORKER_USER}"
  else
    existing_home="$(getent passwd "${WORKER_USER}" | awk -F: '{print $6}')"
    existing_uid="$(id -u "${WORKER_USER}")"
    [[ "${existing_home}" == "${WORKER_HOME}" ]] \
      || die 7 "existing ${WORKER_USER} home is ${existing_home}, expected ${WORKER_HOME}"
    (( existing_uid != 0 )) || die 7 "${WORKER_USER} must not be uid 0"
  fi

  for group in $(id -Gn "${WORKER_USER}"); do
    case "${group}" in
      root|sudo|wheel|admin|docker|lxd)
        die 7 "${WORKER_USER} belongs to privileged group ${group}; provision a dedicated unprivileged account"
        ;;
    esac
  done

  install -d -m 0750 -o "${WORKER_USER}" -g "${WORKER_GROUP}" "${WORKER_HOME}" "${WORKSPACE_DIR}"
  chown "${WORKER_USER}:${WORKER_GROUP}" "${WORKER_HOME}" "${WORKSPACE_DIR}"
  chmod 0750 "${WORKER_HOME}" "${WORKSPACE_DIR}"

  install -d -m 0755 -o root -g root "${STATE_ROOT}" "${WORKER_STATE}"
  install -d -m 0700 -o "${WORKER_USER}" -g "${WORKER_GROUP}" "${SESSION_ROOT}"
  chown root:root "${WORKER_STATE}"
  chmod 0755 "${WORKER_STATE}"
  chown "${WORKER_USER}:${WORKER_GROUP}" "${SESSION_ROOT}"
  chmod 0700 "${SESSION_ROOT}"

  note "created ${WORKER_USER} with workspace ${WORKSPACE_DIR} and session root ${SESSION_ROOT}"
}

install_configuration_files() {
  local env_copy="$1"
  local extension_copy="${2:-}"

  install -d -m 0750 -o root -g "${WORKER_GROUP}" "${CONFIG_DIR}"

  if [[ -e "${WORKER_ENV_FILE}" || -L "${WORKER_ENV_FILE}" ]]; then
    [[ -f "${WORKER_ENV_FILE}" && ! -L "${WORKER_ENV_FILE}" ]] \
      || die 7 "${WORKER_ENV_FILE} must be a regular, non-symlink file"
    local env_mode env_uid
    env_mode="$(stat -c '%a' -- "${WORKER_ENV_FILE}")"
    env_uid="$(stat -c '%u' -- "${WORKER_ENV_FILE}")"
    [[ "${env_uid}" == "0" ]] || die 7 "${WORKER_ENV_FILE} must be root-owned"
    if (( (8#${env_mode} & 0022) != 0 )); then
      die 7 "${WORKER_ENV_FILE} must not be group/other writable"
    fi
  else
    install -m 0640 -o root -g "${WORKER_GROUP}" "${env_copy}" "${WORKER_ENV_FILE}" \
      || die 7 "failed to install ${WORKER_ENV_FILE}"
  fi

  if [[ -n "${extension_copy}" ]]; then
    install -d -m 0750 -o root -g "${WORKER_GROUP}" "${EXT_DIR}"
    install -m 0640 -o root -g "${WORKER_GROUP}" "${extension_copy}" "${CUA_EXTENSION_FILE}" \
      || die 7 "failed to install CUA extension"
    install -d -m 0755 -o root -g root "${UNIT_DROPIN_DIR}"
    cat >"${CUA_DROPIN}" <<EOF
[Service]
Environment="AGENT_IN_BOX_CUA_EXTENSION=${CUA_EXTENSION_FILE}"
EOF
    chown root:root "${CUA_DROPIN}"
    chmod 0644 "${CUA_DROPIN}"
    CUA_EXTENSION_INSTALLED=1
    note "optional CUA extension installed at ${CUA_EXTENSION_FILE}"
  fi
}

install_rpc_token() {
  local token_copy="$1"
  local temp_file="${RPC_TOKEN_FILE}.new.$$"
  local existing_mode existing_size
  local token_mode token_owner token_size

  if [[ -n "${token_copy}" ]]; then
    install -d -m 0755 -o root -g root "${WORKER_STATE}"
    install -m 0600 -o "${WORKER_USER}" -g "${WORKER_GROUP}" "${token_copy}" "${temp_file}" \
      || die 7 "failed to stage the RPC token file"
    mv -f -- "${temp_file}" "${RPC_TOKEN_FILE}" || die 7 "failed to install the RPC token file"
    token_mode="$(stat -c '%a' -- "${RPC_TOKEN_FILE}")"
    token_owner="$(stat -c '%U' -- "${RPC_TOKEN_FILE}")"
    token_size="$(stat -c '%s' -- "${RPC_TOKEN_FILE}")"
    [[ "${token_mode}" == "600" ]] || die 7 "RPC token file mode is ${token_mode}, expected 600"
    [[ "${token_owner}" == "${WORKER_USER}" ]] \
      || die 7 "RPC token file owner is ${token_owner}, expected ${WORKER_USER}"
    (( token_size >= 1 && token_size <= 4096 )) \
      || die 7 "RPC token file must be non-empty and at most 4096 bytes"
    RPC_TOKEN_PRESENT=1
    note "worker RPC token installed at ${RPC_TOKEN_FILE} (mode 0600, owner ${WORKER_USER})"
    return
  fi

  if [[ -e "${RPC_TOKEN_FILE}" || -L "${RPC_TOKEN_FILE}" ]]; then
    [[ -f "${RPC_TOKEN_FILE}" && ! -L "${RPC_TOKEN_FILE}" ]] \
      || die 7 "${RPC_TOKEN_FILE} must be a regular, non-symlink token file"
    existing_size="$(stat -c '%s' -- "${RPC_TOKEN_FILE}")"
    (( existing_size >= 1 && existing_size <= 4096 )) \
      || die 7 "${RPC_TOKEN_FILE} must be non-empty and at most 4096 bytes"
    chown "${WORKER_USER}:${WORKER_GROUP}" "${RPC_TOKEN_FILE}" \
      || die 7 "failed to set owner on ${RPC_TOKEN_FILE}"
    chmod 0600 "${RPC_TOKEN_FILE}" || die 7 "failed to set mode 0600 on ${RPC_TOKEN_FILE}"
    existing_mode="$(stat -c '%a' -- "${RPC_TOKEN_FILE}")"
    [[ "${existing_mode}" == "600" ]] || die 7 "could not enforce mode 0600 on ${RPC_TOKEN_FILE}"
    RPC_TOKEN_PRESENT=1
    note "existing worker RPC token validated at ${RPC_TOKEN_FILE}"
    return
  fi

  RPC_TOKEN_PRESENT=0
  warn "no worker RPC token was provided or found. ${UNIT_NAME} will be enabled but will fail closed until controlled provisioning writes ${RPC_TOKEN_FILE} (mode 0600, owner ${WORKER_USER})."
}

assert_unit_contract() {
  local unit=$1
  local user_count group_count exec_count extra_exec

  user_count="$(grep -c '^User=' "${unit}" || true)"
  group_count="$(grep -c '^Group=' "${unit}" || true)"
  exec_count="$(grep -c '^ExecStart=' "${unit}" || true)"
  [[ "${user_count}" == "1" ]] || die 8 "unit must contain exactly one User= line"
  [[ "${group_count}" == "1" ]] || die 8 "unit must contain exactly one Group= line"
  [[ "${exec_count}" == "1" ]] || die 8 "unit must contain exactly one ExecStart= line"
  extra_exec="$(grep -E '^Exec(StartPre|StartPost|Reload|Stop|StopPost)=' "${unit}" || true)"
  [[ -z "${extra_exec}" ]] || die 8 "unit must not add other Exec commands or privileged prefixes"
  if grep -Eq '^PermissionsStartOnly=(yes|true|1)$' "${unit}"; then
    die 8 "unit must not use PermissionsStartOnly= to run the service as root"
  fi
  if grep -Eq '^SupplementaryGroups=' "${unit}"; then
    die 8 "unit must not add supplementary groups"
  fi
  grep -Fqx 'User=aib-worker' "${unit}" || die 8 "unit must run as aib-worker, never root"
  grep -Fqx 'Group=aib-worker' "${unit}" || die 8 "unit must run with group aib-worker"
  grep -Fqx 'WorkingDirectory=/home/aib-worker/workspace' "${unit}" \
    || die 8 "unit has an unexpected WorkingDirectory"
  grep -Fqx 'ExecStart=/opt/agent-in-box/node/bin/node /opt/agent-in-box/worker/dist/worker-rpc-main.js' "${unit}" \
    || die 8 "unit ExecStart does not match the installed Node/worker paths"
  grep -Fqx 'Environment=AGENT_IN_BOX_WORKER_TOKEN_FILE=/var/lib/agent-in-box/worker/rpc-token' "${unit}" \
    || die 8 "unit has an unexpected AGENT_IN_BOX_WORKER_TOKEN_FILE"
  grep -Fqx 'Environment=AGENT_IN_BOX_PI_BINARY=/opt/agent-in-box/pi/bin/pi' "${unit}" \
    || die 8 "unit has an unexpected AGENT_IN_BOX_PI_BINARY"
  grep -Fqx 'Environment=AGENT_IN_BOX_SESSION_ROOT=/var/lib/agent-in-box/worker/sessions' "${unit}" \
    || die 8 "unit has an unexpected AGENT_IN_BOX_SESSION_ROOT"
  grep -Fqx 'ConditionPathExists=/var/lib/agent-in-box/worker/rpc-token' "${unit}" \
    || die 8 "unit must refuse to start without the RPC token file"
  grep -Fqx 'NoNewPrivileges=true' "${unit}" \
    || die 8 "unit must keep NoNewPrivileges=true"
  grep -Fqx 'CapabilityBoundingSet=' "${unit}" \
    || die 8 "unit must keep an empty CapabilityBoundingSet"
  grep -Fqx 'AmbientCapabilities=' "${unit}" \
    || die 8 "unit must keep empty AmbientCapabilities"
}

install_systemd_unit() {
  local unit_copy="$1"

  assert_unit_contract "${unit_copy}"
  install -d -m 0755 -o root -g root /etc/systemd/system
  install -m 0644 -o root -g root "${unit_copy}" "${UNIT_DEST}" \
    || die 8 "failed to install ${UNIT_DEST}"

  systemctl daemon-reload || die 8 "systemctl daemon-reload failed"
  systemctl enable "${UNIT_NAME}" >/dev/null || die 8 "failed to enable ${UNIT_NAME}"
  systemctl is-enabled "${UNIT_NAME}" >/dev/null 2>&1 \
    || die 8 "systemctl reports ${UNIT_NAME} as not enabled"

  if systemctl is-active --quiet "${UNIT_NAME}"; then
    warn "${UNIT_NAME} is currently active; restart it manually to apply the newly installed runtime"
  fi

  note "${UNIT_NAME} installed and enabled (not started)"
}

write_install_manifest() {
  local token_json="false"
  local cua_json="null"
  local installed_at
  local manifest_stage="${STAGE_DIR}/install-manifest.json"

  if (( RPC_TOKEN_PRESENT == 1 )); then
    token_json="true"
  fi
  if (( CUA_EXTENSION_INSTALLED == 1 )); then
    cua_json="\"${CUA_EXTENSION_FILE}\""
  fi
  installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  cat >"${manifest_stage}" <<EOF
{
  "schemaVersion": 1,
  "installedAt": "${installed_at}",
  "nodeVersion": "v${NODE_VERSION}",
  "piVersion": "${PI_VERSION}",
  "nodeArchiveSha256": "${NODE_SHA256,,}",
  "piPackageSha256": "${PI_SHA256,,}",
  "workerBundleSha256": "${WORKER_BUNDLE_SHA}",
  "workerEntry": "dist/worker-rpc-main.js",
  "workerModuleFormat": "commonjs",
  "rpcListen": "0.0.0.0:${WORKER_PORT}",
  "serviceUser": "${WORKER_USER}",
  "rpcTokenFile": "${RPC_TOKEN_FILE}",
  "rpcTokenConfigured": ${token_json},
  "sessionRoot": "${SESSION_ROOT}",
  "cuaExtension": ${cua_json}
}
EOF

  install -m 0644 -o root -g root "${manifest_stage}" "${MANIFEST_FILE}" \
    || die 7 "failed to install ${MANIFEST_FILE}"
  note "install manifest written to ${MANIFEST_FILE}"
}

print_summary() {
  cat <<EOF

Agent-in-Box Guest Worker installation complete.

  Node.js:        v${NODE_VERSION} (${NODE_DIR})
  Pi:             ${PI_VERSION} (${PI_DIR})
  Worker:         ${WORKER_LINK} -> ${WORKER_RELEASES}/${WORKER_BUNDLE_SHA}
  Service user:   ${WORKER_USER} (non-root, no sudo)
  Working dir:    ${WORKSPACE_DIR}
  Session root:   ${SESSION_ROOT}
  RPC listener:   0.0.0.0:${WORKER_PORT} (configured by the worker entrypoint)
  RPC token file: ${RPC_TOKEN_FILE}
  Unit:           ${UNIT_DEST} (enabled, not started)

Next steps:
  1. Provision the per-VM RPC bearer token through a controlled channel (never
     a provider key and never the Model Broker token). It must be a small
     regular file owned by ${WORKER_USER}, mode 0600.
  2. systemctl start ${UNIT_NAME}
  3. Verify with: systemctl status ${UNIT_NAME}; ss -ltn '( sport = :${WORKER_PORT} )'

The installer does not create models.json or any provider credentials. The Host
passes the short-lived Model Broker token in the session spec; the Worker RPC
entrypoint writes it atomically to
${SESSION_ROOT}/<workerId>/home/.pi/agent/models.json at session start.
EOF

  if (( RPC_TOKEN_PRESENT == 0 )); then
    warn "The service will fail closed until the RPC token file is provisioned."
  fi
}

main() {
  parse_args "$@"
  require_platform

  require_regular_input "${UNIT_SRC}" "systemd unit"
  require_regular_input "${ENV_EXAMPLE_SRC}" "worker.env example"
  if [[ -n "${RPC_TOKEN_SRC}" ]]; then
    require_token_input "${RPC_TOKEN_SRC}"
  fi
  if [[ -n "${CUA_EXTENSION_SRC}" ]]; then
    require_regular_input "${CUA_EXTENSION_SRC}" "CUA extension"
    local extension_size
    extension_size="$(stat -c '%s' -- "${CUA_EXTENSION_SRC}")"
    (( extension_size >= 1 && extension_size <= 16777216 )) \
      || die 4 "CUA extension must be between 1 byte and 16 MiB: ${CUA_EXTENSION_SRC}"
  fi

  install -d -m 0755 -o root -g root "${OPT_ROOT}"
  STAGE_DIR="$(mktemp -d "${OPT_ROOT}/.install.XXXXXXXX")" \
    || die 7 "failed to create a root-only staging directory"
  chmod 0700 "${STAGE_DIR}"

  note "staging verified inputs below ${STAGE_DIR}"
  local node_copy="${STAGE_DIR}/node-archive.tar.xz"
  local pi_copy="${STAGE_DIR}/pi-coding-agent.tgz"
  local worker_copy="${STAGE_DIR}/agent-runtime-worker.tar.gz"
  local unit_copy="${STAGE_DIR}/agent-in-box-worker.service"
  local env_copy="${STAGE_DIR}/worker.env"
  local token_copy=""
  local extension_copy=""

  copy_root_only "${NODE_ARCHIVE}" "${node_copy}" "Node archive"
  copy_root_only "${PI_PACKAGE}" "${pi_copy}" "Pi package"
  copy_root_only "${WORKER_BUNDLE}" "${worker_copy}" "Worker bundle"
  copy_root_only "${UNIT_SRC}" "${unit_copy}" "systemd unit"
  copy_root_only "${ENV_EXAMPLE_SRC}" "${env_copy}" "worker.env example"

  verify_sha256 "${node_copy}" "${NODE_SHA256}" "Node archive"
  verify_sha256 "${pi_copy}" "${PI_SHA256}" "Pi package"
  verify_sha256 "${worker_copy}" "${WORKER_SHA256}" "Worker bundle"
  WORKER_BUNDLE_SHA="${LAST_SHA}"

  if [[ -n "${RPC_TOKEN_SRC}" ]]; then
    token_copy="${STAGE_DIR}/rpc-token"
    require_token_input "${RPC_TOKEN_SRC}"
    install -m 0400 -o root -g root "${RPC_TOKEN_SRC}" "${token_copy}" \
      || die 4 "failed to stage the RPC token file"
  fi
  if [[ -n "${CUA_EXTENSION_SRC}" ]]; then
    extension_copy="${STAGE_DIR}/cua-extension.js"
    copy_root_only "${CUA_EXTENSION_SRC}" "${extension_copy}" "CUA extension"
  fi

  install_node "${node_copy}"
  install_worker "${worker_copy}"
  install_pi "${pi_copy}"
  create_worker_identity_and_directories
  install_configuration_files "${env_copy}" "${extension_copy}"
  install_rpc_token "${token_copy}"
  install_systemd_unit "${unit_copy}"
  write_install_manifest
  print_summary
}

main "$@"

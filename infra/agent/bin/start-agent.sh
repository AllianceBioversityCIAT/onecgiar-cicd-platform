#!/usr/bin/env bash
# architecture-change-04: starts the CI/CD agent in the background as the calling user. Install as
# <AGENT_HOME>/bin/start-agent.sh; it derives <AGENT_HOME> from its own location and touches nothing outside it.
# - Credentials and settings come only from <AGENT_HOME>/config/agent.env (`node --env-file`, mode 0600 required):
#   they never appear on a command line, and the deploy scripts the agent runs never inherit them.
# - Clean environment: nothing of the caller's shell is passed on, and HOME is <AGENT_HOME>, so ~/.aws is never read.
# - Node.js 22: <AGENT_HOME>/node/bin/node when present (for example a symlink to an nvm installation), else `node`.
#   The server's default Node.js is neither used nor changed.
set -euo pipefail
H="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE="${H}/node/bin/node"
[[ -x "${NODE}" ]] || NODE="$(command -v node || true)"
MAIN="${H}/current/dist/src/agent/main.js"
ENV_FILE="${H}/config/agent.env"

[[ -n "${NODE}" && "$("${NODE}" --version)" == v22.* ]] || { echo "Node.js 22 is required (${NODE:-no node found})" >&2; exit 1; }
[[ -f "${MAIN}" ]] || { echo "missing ${MAIN}" >&2; exit 1; }
[[ -f "${ENV_FILE}" ]] || { echo "missing ${ENV_FILE}" >&2; exit 1; }
[[ "$(stat -c '%a' "${ENV_FILE}")" == 600 ]] || { echo "${ENV_FILE} must have mode 0600" >&2; exit 1; }
if pgrep -u "$(id -un)" -f "${MAIN}" >/dev/null; then echo "the agent is already running" >&2; exit 1; fi

cd "${H}"
env -i PATH=/usr/bin:/bin HOME="${H}" LANG=C.UTF-8 \
  nohup setsid "${NODE}" --env-file="${ENV_FILE}" "${MAIN}" >>"${H}/logs/agent.log" 2>&1 </dev/null &
echo "agent started, pid $!"

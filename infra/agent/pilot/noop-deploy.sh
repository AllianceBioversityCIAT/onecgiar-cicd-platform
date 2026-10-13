#!/usr/bin/env bash
# architecture-change-04 E5 (TEST server pilot) - NO-OP deploy script. It changes nothing on the server: it only prints
# its arguments and identity, waits SLEEP_SECONDS and reports success. No Docker, no PM2, no file writes, no network.
# Install root-owned (root:root 0755) at the catalog path; the agent runs it as itself ("runAs": "self"), never sudo.
# For the recovery test, raise SLEEP_SECONDS to 60 (as root), then set it back to 5.
set -euo pipefail
SLEEP_SECONDS=5

sleeper=""
trap '[[ -n "${sleeper}" ]] && kill "${sleeper}" 2>/dev/null; echo "noop: SIGTERM received, exiting without changes"; exit 143' TERM

echo "noop: args=$*"

commit=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit-sha) commit="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

echo "noop: start $(date -u +%Y-%m-%dT%H:%M:%SZ) user=$(id -un) pid=$$"
echo "noop: nothing is deployed; sleeping ${SLEEP_SECONDS}s"
sleep "${SLEEP_SECONDS}" &
sleeper=$!
wait "${sleeper}"
echo "noop: end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ "${commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "CICD_RESULT {\"status\":\"SUCCESS\",\"deployedCommit\":\"${commit}\"}"
else
  echo 'CICD_RESULT {"status":"SUCCESS"}'
fi

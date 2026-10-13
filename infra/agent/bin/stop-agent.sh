#!/usr/bin/env bash
# architecture-change-04: stops ONLY this agent (the calling user's process running <AGENT_HOME>'s entry point) with
# SIGTERM and waits for its drain: running scripts get shutdownGraceSeconds, then it exits by itself. Never pkill,
# never another process. Usage: stop-agent.sh [seconds to wait, default 330 = 310 s grace of the pilot + margin]
set -euo pipefail
H="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MAIN="${H}/current/dist/src/agent/main.js"
WAIT="${1:-330}"

mapfile -t PIDS < <(pgrep -u "$(id -un)" -f "${MAIN}" || true)
if [[ ${#PIDS[@]} -eq 0 ]]; then echo "the agent is not running"; exit 0; fi
if [[ ${#PIDS[@]} -gt 1 ]]; then echo "more than one agent process (${PIDS[*]}): stop them one by one" >&2; exit 1; fi

ps -o pid=,args= -p "${PIDS[0]}"
kill -TERM "${PIDS[0]}"
for ((i = 0; i < WAIT; i++)); do
  if ! kill -0 "${PIDS[0]}" 2>/dev/null; then echo "agent stopped"; exit 0; fi
  sleep 1
done
echo "the agent is still draining after ${WAIT}s (pid ${PIDS[0]}); see logs/agent.log" >&2
exit 1

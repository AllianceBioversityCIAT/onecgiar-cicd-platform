#!/usr/bin/env bash
# @akili-spec changes/cicd-executor-poc gate-b-plan K-6
# Owner-run launcher: loads an env file, selects the portable Node 22 binary and runs
# `node dist/src/main/index.js` from executor/. It adds no logic to the Executor. The env
# is exported in this process and node replaces it through `exec`, so SIGTERM/SIGINT sent
# to the launcher reach node directly (ordered shutdown). Use --dry-run to print the
# resolved command without starting anything.
set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
executor_dir="$repo_root/executor"
env_file=""
node_bin=""
dry_run=0
allow_local_endpoint=0

usage() {
  cat <<USAGE
Usage: run-executor.sh [--env-file FILE] [--node PATH] [--executor-dir DIR] [--allow-local-endpoint] [--dry-run]
  --env-file   default: <executor-dir>/.local/executor.env
  --node       default: <executor-dir>/.local/node22/bin/node (must report major 22)
USAGE
}

need_value() {
  if [ "$2" -lt 2 ]; then
    echo "run-executor: option $1 requires a value" >&2
    usage >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) need_value "$1" "$#"; env_file="$2"; shift 2 ;;
    --node) need_value "$1" "$#"; node_bin="$2"; shift 2 ;;
    --executor-dir) need_value "$1" "$#"; executor_dir="$2"; shift 2 ;;
    --allow-local-endpoint) allow_local_endpoint=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "run-executor: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$env_file" ] || env_file="$executor_dir/.local/executor.env"
[ -n "$node_bin" ] || node_bin="$executor_dir/.local/node22/bin/node"
main_js="dist/src/main/index.js"

if [ ! -f "$env_file" ]; then
  echo "run-executor: env file not found: $env_file (copy docs/gate-b/executor/executor.env.example to executor/.local/executor.env)" >&2
  exit 2
fi
if [ ! -x "$node_bin" ] && [ ! -f "$node_bin" ]; then
  echo "run-executor: Node binary not found: $node_bin (see docs/gate-b/05-run-executor-node22.md)" >&2
  exit 2
fi

node_version="$("$node_bin" --version 2>/dev/null | tr -d '\r')"
case "$node_version" in
  v22.*) ;;
  *) echo "run-executor: refusing to run: Node major 22 is required, found '${node_version:-unknown}' at $node_bin" >&2; exit 2 ;;
esac

if [ ! -f "$executor_dir/$main_js" ]; then
  echo "run-executor: $executor_dir/$main_js is missing. Run 'npm ci && npm run build' in executor/ with the portable Node first." >&2
  exit 2
fi

# Simple env-file parser: KEY=VALUE, comments and blank lines ignored, optional surrounding quotes stripped.
keys=()
vals=()
first_line=1
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  if [ "$first_line" = 1 ]; then line="${line#$'\xEF\xBB\xBF'}"; first_line=0; fi
  trimmed="${line#"${line%%[![:space:]]*}"}"
  case "$trimmed" in ''|'#'*) continue ;; esac
  case "$trimmed" in *=*) ;; *) echo "run-executor: invalid env line (expected KEY=VALUE): $trimmed" >&2; exit 2 ;; esac
  key="${trimmed%%=*}"
  val="${trimmed#*=}"
  key="${key%"${key##*[![:space:]]}"}"
  case "$key" in [A-Za-z_][A-Za-z0-9_]*) ;; *) echo "run-executor: invalid env key: $key" >&2; exit 2 ;; esac
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  keys+=("$key")
  vals+=("$val")
done < "$env_file"

endpoint_set=0
profile_set=0
for i in "${!keys[@]}"; do
  case "${keys[$i]}" in
    AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)
      echo "run-executor: refusing to run: ${keys[$i]} is in the env file; static AWS keys are not allowed (use AWS_PROFILE with role_arn + source_profile)." >&2
      exit 2 ;;
    AWS_PROFILE)
      [ -n "${vals[$i]}" ] && profile_set=1 ;;
    CICD_DYNAMODB_ENDPOINT)
      [ -n "${vals[$i]}" ] && endpoint_set=1 ;;
  esac
done
if [ "$profile_set" != 1 ]; then
  echo "run-executor: refusing to run: AWS_PROFILE is missing or empty in the env file (use a profile with role_arn + source_profile that assumes the Executor role)." >&2
  exit 2
fi
if [ "$endpoint_set" = 1 ] && [ "$allow_local_endpoint" != 1 ]; then
  echo "run-executor: refusing to run: CICD_DYNAMODB_ENDPOINT is set and would point the Executor at a local emulator instead of AWS (pass --allow-local-endpoint to override)." >&2
  exit 2
fi

for inherited in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  if [ -n "${!inherited:-}" ]; then
    echo "run-executor: warning: inherited $inherited is ignored and removed from the Executor environment (static keys are not allowed)." >&2
  fi
done

if [ "$dry_run" = 1 ]; then
  echo "run-executor (dry run): nothing is started"
  echo "node: $node_bin ($node_version)"
  echo "cwd: $executor_dir"
  echo "command: $node_bin $main_js"
  echo "env file: $env_file"
  echo "env (values redacted):"
  for i in "${!keys[@]}"; do
    if [ -n "${vals[$i]}" ]; then echo "  ${keys[$i]}=<set>"; else echo "  ${keys[$i]}=<empty>"; fi
  done
  exit 0
fi

# Export in THIS process (no subshell), drop inherited static keys, then replace the
# launcher with node so signals reach it.
for i in "${!keys[@]}"; do export "${keys[$i]}=${vals[$i]}"; done
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
cd "$executor_dir" || exit 2
exec "$node_bin" "$main_js"

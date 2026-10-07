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
  # A repeated key would let a later empty value override a validated one: refuse any duplicate.
  for seen_key in "${keys[@]+"${keys[@]}"}"; do
    if [ "$seen_key" = "$key" ]; then echo "run-executor: refusing to run: duplicate key $key in the env file (each key may appear only once)." >&2; exit 2; fi
  done
  keys+=("$key")
  vals+=("$val")
done < "$env_file"

endpoint_set=0
profile_set=0
config_file=""
creds_file=""
profile_val=""
executor_role_arn=""
for i in "${!keys[@]}"; do
  case "${keys[$i]}" in
    AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)
      echo "run-executor: refusing to run: ${keys[$i]} is in the env file; static AWS keys are not allowed (use AWS_PROFILE with role_arn + source_profile)." >&2
      exit 2 ;;
    AWS_PROFILE)
      [ -n "${vals[$i]}" ] && { profile_set=1; profile_val="${vals[$i]}"; } ;;
    CICD_EXECUTOR_ROLE_ARN) executor_role_arn="${vals[$i]}" ;;
    AWS_CONFIG_FILE) config_file="${vals[$i]}" ;;
    AWS_SHARED_CREDENTIALS_FILE) creds_file="${vals[$i]}" ;;
    CICD_DYNAMODB_ENDPOINT)
      [ -n "${vals[$i]}" ] && endpoint_set=1 ;;
  esac
done
if [ "$profile_set" != 1 ]; then
  echo "run-executor: refusing to run: AWS_PROFILE is missing or empty in the env file (use a profile with role_arn + source_profile that assumes the Executor role)." >&2
  exit 2
fi
# SR-3: the Executor must run with an ISOLATED AWS config and credentials file (the dedicated
# principal), never the default ~/.aws files that may hold administrator credentials. Allow-list:
# absolute path, under <executor-dir>/.local/aws/, no link on the way, a single hard link.
refuse() { echo "run-executor: refusing to run: $1" >&2; exit 2; }

# The expected Executor role (stack output ExecutorRoleArn). It is used ONLY to validate the isolated
# config and is deliberately not passed to the Executor: it is not a secret, but the Executor
# configuration surface stays unchanged (the role it assumes comes from the profile alone).
role_arn_regex='^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$'
[ -n "$executor_role_arn" ] || refuse "CICD_EXECUTOR_ROLE_ARN is missing or empty in the env file (set it to the ExecutorRoleArn stack output; SR-3)."
[[ "$executor_role_arn" =~ $role_arn_regex ]] || refuse "CICD_EXECUTOR_ROLE_ARN is not a well-formed IAM role ARN."

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

check_isolated_aws_file() {
  # $1 = env key, $2 = value, $3 = default file name under ~/.aws. Sets resolved_path.
  local key="$1" value="$2" name="$3" p dir base real_allowed real_dir real prefix seen part n d
  [ -n "$value" ] || refuse "$key is missing or empty in the env file (the Executor must use the isolated AWS files under executor/.local/aws/; see docs/gate-b/05-run-executor-node22.md)."
  case "$value" in
    /*) p="$value" ;;
    [A-Za-z]:[\\/]*) if command -v cygpath >/dev/null 2>&1; then p="$(cygpath -u "$value")"; else p="$value"; fi ;;
    *) refuse "$key must be an absolute path (a relative path would be resolved against another directory)." ;;
  esac
  case "/$p/" in */../*) refuse "$key must not contain '..' segments." ;; esac
  [ -f "$p" ] || refuse "$key points to a file that does not exist: $value"
  default_paths=("${HOME:-}/.aws/$name")
  if [ -n "${USERPROFILE:-}" ]; then
    if command -v cygpath >/dev/null 2>&1; then default_paths+=("$(cygpath -u "$USERPROFILE" 2>/dev/null)/.aws/$name"); fi
    default_paths+=("${USERPROFILE//\\//}/.aws/$name")
  fi
  for d in "${default_paths[@]}"; do
    if [ -f "$d" ] && [ "$p" -ef "$d" ]; then
      refuse "$key points to the default ~/.aws/$name; use the isolated file under executor/.local/aws/ (SR-3)."
    fi
  done
  # The LOGICAL path must be under <executor-dir>/.local/aws/ and neither .local nor .local/aws may be a link
  # (otherwise the physical-path comparison below would accept the link's target).
  logical_allowed="${executor_dir%/}/.local/aws"
  case "$p" in
    "$logical_allowed"/*) ;;
    *) refuse "$key is outside <executor-dir>/.local/aws/ (the path as written must be under it; allow-list rule, SR-3)." ;;
  esac
  if [ -L "${executor_dir%/}/.local" ] || [ -L "$logical_allowed" ]; then
    refuse "<executor-dir>/.local or <executor-dir>/.local/aws is a symbolic link or junction (SR-3)."
  fi
  real_allowed="$(cd "$executor_dir/.local/aws" 2>/dev/null && pwd -P)" || refuse "$key is outside <executor-dir>/.local/aws/ (the directory does not exist)."
  dir="$(dirname "$p")"; base="$(basename "$p")"
  real_dir="$(cd "$dir" 2>/dev/null && pwd -P)" || refuse "$key directory cannot be resolved."
  real="$real_dir/$base"
  case "$real" in
    "$real_allowed"/*) ;;
    *) refuse "$key is outside <executor-dir>/.local/aws/ (allow-list rule, SR-3)." ;;
  esac
  # No symbolic link / junction on any component from .local down (Git Bash reports junctions as links).
  prefix=""; seen=0
  IFS=/ read -ra parts <<< "$p"
  for part in "${parts[@]}"; do
    [ -n "$part" ] || continue
    prefix="$prefix/$part"
    [ "$part" = ".local" ] && seen=1
    if [ "$seen" = 1 ] && [ -L "$prefix" ]; then
      refuse "$key passes through a symbolic link or junction (no links allowed under .local, SR-3)."
    fi
  done
  [ ! -L "$p" ] || refuse "$key is a symbolic link (SR-3)."
  # Exactly one hard link (GNU stat on Linux and Git Bash; BSD stat as a fallback).
  n="$(stat -c %h "$p" 2>/dev/null || stat -f %l "$p" 2>/dev/null)"
  [ "$n" = 1 ] || refuse "$key has a hard link count of '${n:-unknown}' instead of 1 (SR-3)."
  resolved_path="$real"
}

# Simple INI parse, no evaluation: every line is treated as data.
ini_lines() { # prints "section<US>key<US>value" per key line (US = 0x1f, a non-whitespace separator); section is the trimmed header text
  local line t sec="" k
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"; line="${line#$'\xEF\xBB\xBF'}"
    t="$(trim "$line")"
    case "$t" in ''|'#'*|';'*) continue ;; esac
    case "$t" in
      \[*\]) sec="${t#[}"; sec="${sec%]}"; sec="$(trim "$sec" | tr -s '[:space:]' ' ')"; printf '%s\037[section]\037\n' "$sec" ;;
      *=*) k="$(trim "${t%%=*}" | tr 'A-Z' 'a-z')"; printf '%s\037%s\037%s\n' "$sec" "$k" "$(trim "${t#*=}")" ;;
    esac
  done < "$1"
}

check_isolated_config() {
  local sec k v found=0 has_role=0 has_src=0 role_mismatch=0
  while IFS=$'\037' read -r sec k v; do
    case "$k" in
      credential_process|credential_source|web_identity_token_file|sso_*)
        refuse "the isolated AWS config contains '$k' (forbidden: credentials must come only from role_arn + source_profile, SR-3)." ;;
      '[section]')
        case "$sec" in sso-session*) refuse "the isolated AWS config contains an sso-session section (forbidden, SR-3)." ;; esac
        [ "$sec" = "profile $profile_val" ] && found=1 ;;
      role_arn)
        if [ "$sec" = "profile $profile_val" ]; then
          has_role=1
          [ "$v" = "$executor_role_arn" ] || role_mismatch=1
        fi ;;
      source_profile) [ "$sec" = "profile $profile_val" ] && has_src=1 ;;
    esac
  done < <(ini_lines "$config_real")
  [ "$found" = 1 ] || refuse "the isolated AWS config has no [profile $profile_val] section named by AWS_PROFILE."
  [ "$has_role" = 1 ] || refuse "the [profile $profile_val] section of the isolated AWS config has no role_arn."
  [ "$has_src" = 1 ] || refuse "the [profile $profile_val] section of the isolated AWS config has no source_profile."
  [ "$role_mismatch" = 0 ] || refuse "the role_arn of [profile $profile_val] in the isolated AWS config is not exactly CICD_EXECUTOR_ROLE_ARN (the profile must assume only the Executor role, SR-3)."
}

check_isolated_credentials() {
  local sec k v
  while IFS=$'\037' read -r sec k v; do
    if [ "$k" = "[section]" ]; then
      if [ "$sec" = "$profile_val" ] || [ "$sec" = "profile $profile_val" ]; then
        refuse "the isolated credentials file contains a section named like AWS_PROFILE (the role profile must not carry static keys, SR-3)."
      fi
    else
      # Allow-list: a source-key file holds ONLY the two static key fields.
      case "$k" in
        aws_access_key_id|aws_secret_access_key) ;;
        *) refuse "the isolated credentials file contains '$k' (only aws_access_key_id and aws_secret_access_key are allowed, SR-3)." ;;
      esac
    fi
  done < <(ini_lines "$creds_real")
}

check_isolated_aws_file AWS_CONFIG_FILE "$config_file" config
config_real="$resolved_path"
check_isolated_aws_file AWS_SHARED_CREDENTIALS_FILE "$creds_file" credentials
creds_real="$resolved_path"
check_isolated_config
check_isolated_credentials

if [ "$endpoint_set" = 1 ] && [ "$allow_local_endpoint" != 1 ]; then
  echo "run-executor: refusing to run: CICD_DYNAMODB_ENDPOINT is set and would point the Executor at a local emulator instead of AWS (pass --allow-local-endpoint to override)." >&2
  exit 2
fi

for inherited in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  if [ -n "${!inherited:-}" ]; then
    echo "run-executor: warning: inherited $inherited is ignored and removed from the Executor environment (static keys are not allowed)." >&2
  fi
done

# SR-3: other credential sources that would bypass the isolated profile are removed.
alt_cred_vars="AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"
for inherited in $alt_cred_vars; do
  if [ -n "${!inherited:-}" ]; then
    echo "run-executor: warning: inherited $inherited is ignored and removed from the Executor environment (only the isolated role profile may supply credentials)." >&2
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

# Export in THIS process (no subshell), drop inherited static keys and alternative credential sources, then replace the
# launcher with node so signals reach it.
for i in "${!keys[@]}"; do export "${keys[$i]}=${vals[$i]}"; done
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
# shellcheck disable=SC2086
unset $alt_cred_vars
# The validated values are exported explicitly (never the env-file text); CICD_EXECUTOR_ROLE_ARN is launcher-only.
unset CICD_EXECUTOR_ROLE_ARN
export AWS_PROFILE="$profile_val" AWS_CONFIG_FILE="$config_real" AWS_SHARED_CREDENTIALS_FILE="$creds_real" AWS_EC2_METADATA_DISABLED=true
cd "$executor_dir" || exit 2
exec "$node_bin" "$main_js"

#!/usr/bin/env bash
# @akili-spec changes/cicd-executor-poc design §5.3, §6.5, DD-10, DD-11, DD-22, DD-26; requirements FR-13, FR-16 F11-F13/F18
#
# Generic target-side deploy script (design §6.5, N-15). Delivered per-execution over
# SFTP (DD-10) and run on the deploy target. GENERIC: nothing PRMS-specific or
# project-specific is hardcoded; every unit-specific detail arrives as a CLI
# argument from the Target Registry (artifacts, ports, migration commands, health
# checks, secret references).
#
# Artifacts are immutable (DD-26, FR-13): every artifact reference is
# <repository>@sha256:<64-hex>; a tag (or anything else) is a usage error (exit
# 2, before any effect). Images are pulled, run and recorded by digest.
#
# Order (DD-11): local kernel mutex (non-blocking) -> pull -> temporary runtime
# configuration -> migration with the NEW image, BEFORE the swap, while the
# OLD container keeps serving -> swap -> health check -> pruning that always
# keeps the previous image.
#
# Exit codes (design §6.5 / FR-13):
#   0  success (including "already running these digests": no migration, no swap)
#   10 login or pull failed            (previous intact)
#   20 migration failed                (previous intact, NOT stopped)
#   30 start failed                    (previous restored)
#   40 health check failed             (previous restored)
#   50 TARGET_BUSY (local mutex held)  (nothing done)
#   2  CLI usage error (not a deploy outcome; no CICD_RESULT line)
#
# Last stdout line is always `CICD_RESULT <json>` on every deploy-outcome exit
# path (0/10/20/30/40/50), per §6.5.
#
# Local mutex (design §5.3, §12.1, DD-22): a NON-BLOCKING KERNEL file lock
# (flock(2) semantics; the OS releases it when the holding process dies -- the
# lock is the kernel's lock, never the file's existence; never delete the lock
# file to "release" it). The lock file lives under a deploy-user-owned
# directory keyed by --lock-key and records executionId, fencingToken, PID and
# start time for the runbook (§12.1).
#
# HUP handling: the whole script ignores SIGHUP (superset of "the critical
# section ignores HUP") so an SSH session hangup never interrupts a migration
# or a swap in progress.
#
# Target AWS credentials (OD-Q5 still open; requirements FR-13 "target's AWS
# credentials" scenario): the runtime secret is fetched BY REFERENCE on the
# target, with the target's OWN permissions, never by reading leftover
# `~/.aws/credentials` keys. Concretely, every `aws` call is prefixed with
# AWS_SHARED_CREDENTIALS_FILE=/dev/null, which excludes that leftover file
# from the AWS CLI's credential provider chain (the trap described in the
# proposal §10.10 / DD-11). This does NOT by itself force or guarantee which
# provider in the chain ends up resolving -- an instance profile is simply
# expected to be the one that applies on the target when nothing else
# intervenes, but this script does not verify that. The fetch is isolated
# behind fetch_runtime_secret() so the mechanism can change without
# touching callers; this script does NOT resolve OD-Q5, it only avoids the
# known trap.
#
# No argument is ever eval'd. All docker/aws invocations are built as arrays.

set -euo pipefail

# Ignore session hangup for the whole lifetime of the script (see header).
trap '' HUP

# ---------------------------------------------------------------------------
# Resolve our own path so the locked re-invocation (`--internal-locked`) can
# find this same script file regardless of the caller's CWD.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

die_usage() {
  echo "deploy-container.sh: $*" >&2
  exit 2
}

# Strict charset for identifiers that become part of filesystem paths
# (lock file name, per-execution tmp dir, temp-container names) or are used
# to build container-name filters: letters, digits, '.', '_', '-' only. No
# '/', no whitespace, no shell metacharacters. Rejects path traversal (e.g.
# "../etc") before ANY effect (before the lock is even attempted).
validate_token() {
  local label="$1" value="$2"
  if [[ -z "$value" ]]; then
    die_usage "$label must not be empty"
  fi
  if [[ "$value" == *".."* ]]; then
    die_usage "$label must not contain '..': '$value'"
  fi
  if [[ ! "$value" =~ ^[A-Za-z0-9._-]+$ ]]; then
    die_usage "$label contains disallowed characters: '$value' (allowed: letters, digits, '.', '_', '-')"
  fi
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

# Builds a JSON object {"k":"v",...} from an associative array given by name.
json_map() {
  local -n map_ref="$1"
  local first=1
  local out="{"
  local k
  for k in "${!map_ref[@]}"; do
    if [[ $first -eq 0 ]]; then out+=","; fi
    out+="\"$(json_escape "$k")\":\"$(json_escape "${map_ref[$k]}")\""
    first=0
  done
  out+="}"
  printf '%s' "$out"
}

# Splits "<container>=<value>" into the two parts (first '=' only).
split_kv() {
  local kv="$1"
  KV_KEY="${kv%%=*}"
  KV_VAL="${kv#*=}"
}

# Immutable artifact reference (DD-26): <repository>@sha256:<64-hex>. The
# repository may carry a registry host (with port) and path segments; it must
# start with an alphanumeric (no option-like value), and '..' is rejected. No
# tag form is accepted: a reference is never resolved through a mutable tag.
validate_artifact_ref() {
  local label="$1" value="$2"
  if [[ "$value" == *".."* ]]; then
    die_usage "$label must not contain '..': '$value'"
  fi
  if [[ ! "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$ ]]; then
    die_usage "$label must be <repository>@sha256:<64-hex> (tags are not accepted): '$value'"
  fi
}

# Repository part of an immutable reference (everything before '@').
image_repository() {
  printf '%s' "${1%@*}"
}

# Fetches a runtime secret BY REFERENCE on the target, using the target's own
# AWS permissions. Mechanism is OD-Q5 (open); kept behind this one function
# so it can change without touching callers. Excludes the leftover
# ~/.aws/credentials file from the AWS CLI's credential provider chain (the
# trap called out in the proposal §10.10 / DD-11) -- it does not itself pick
# or guarantee which provider resolves.
# NEVER echoes the secret value: callers must redirect its stdout straight to
# a file, never capture it into a variable that could end up in a log line.
fetch_runtime_secret() {
  local secret_ref="$1"
  AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    aws secretsmanager get-secret-value \
      --secret-id "$secret_ref" \
      --query 'SecretString' \
      --output text
}

# ECR login, only engaged when the image's registry looks like ECR; a no-op
# for any other registry (generic: this script does not assume ECR).
docker_login_for_image() {
  local image_uri="$1"
  local registry="${image_uri%%/*}"
  if [[ "$registry" == *.dkr.ecr.*.amazonaws.com ]]; then
    local region
    region="$(printf '%s' "$registry" | sed -E 's/^[0-9]+\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/\1/')"
    AWS_SHARED_CREDENTIALS_FILE=/dev/null \
      aws ecr get-login-password --region "$region" \
      | docker login --username AWS --password-stdin "$registry" >/dev/null
  fi
  return 0
}

docker_running_image() {
  local container="$1"
  docker ps --filter "name=^/${container}\$" --format '{{.Image}}' 2>/dev/null || true
}

# Resolves what a running container is ACTUALLY running to an immutable
# identity (DD-26): never a tag. The raw 'docker ps' image may be a tag (a
# first deploy over a tag-deployed container), so:
#   1. already <repository>@sha256:<64-hex>      -> used as is;
#   2. else the container's image ID, then its RepoDigests entries: the
#      artifact's own digest if present, else the first entry of the SAME
#      repository -> <repository>@sha256:<digest>;
#   3. else (no matching RepoDigest) the image ID itself, which is
#      content-addressed and immutable; flagged unresolved so the result
#      reports it as "unresolved:<image-id>". A tag is never invented.
# Sets RESOLVED_REF and RESOLVED_UNRESOLVED (1 only in case 3); RESOLVED_REF
# stays empty when nothing can be resolved.
RESOLVED_REF=""
RESOLVED_UNRESOLVED=0
resolve_running_image() {
  local container="$1" raw="$2" repo="$3" new_image="$4"
  RESOLVED_REF=""
  RESOLVED_UNRESOLVED=0
  if [[ "$raw" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$ ]]; then
    RESOLVED_REF="$raw"
    return 0
  fi
  local image_id
  image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 0
  local entry first_match=""
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    if [[ "$entry" == "$new_image" ]]; then
      RESOLVED_REF="$entry"
      return 0
    fi
    if [[ -z "$first_match" && "${entry%@*}" == "$repo" ]]; then
      first_match="$entry"
    fi
  done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" 2>/dev/null || true)
  if [[ -n "$first_match" ]]; then
    RESOLVED_REF="$first_match"
  else
    RESOLVED_REF="$image_id"
    RESOLVED_UNRESOLVED=1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Argument parsing (shared between the outer orchestrator and the locked
# worker; both receive the SAME deploy arguments).
# ---------------------------------------------------------------------------

declare -A NEW_IMAGE=()
declare -A PREV_IMAGE_HINT=()
declare -A PORT_MAP=()
declare -A SECRET_REF=()
declare -A HEALTH_CHECK=()
MIGRATE_CONTAINERS=()
MIGRATION_CHECK_CMDS=()
MIGRATION_RUN_CMDS=()
MIGRATION_MODE="ephemeral"
EXECUTION_ID=""
UNIT=""
LOCK_KEY=""
FENCING_TOKEN=""

parse_args() {
  local current_migrate_idx=-1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --execution-id)
        EXECUTION_ID="$2"; shift 2 ;;
      --unit)
        UNIT="$2"; shift 2 ;;
      --artifact)
        split_kv "$2"; NEW_IMAGE["$KV_KEY"]="$KV_VAL"; shift 2 ;;
      --previous)
        split_kv "$2"; PREV_IMAGE_HINT["$KV_KEY"]="$KV_VAL"; shift 2 ;;
      --lock-key)
        LOCK_KEY="$2"; shift 2 ;;
      --fencing-token)
        FENCING_TOKEN="$2"; shift 2 ;;
      --port)
        split_kv "$2"; PORT_MAP["$KV_KEY"]="$KV_VAL"; shift 2 ;;
      --runtime-secret)
        split_kv "$2"; SECRET_REF["$KV_KEY"]="$KV_VAL"; shift 2 ;;
      --migrate)
        MIGRATE_CONTAINERS+=("$2")
        MIGRATION_CHECK_CMDS+=("")
        MIGRATION_RUN_CMDS+=("")
        current_migrate_idx=$(( ${#MIGRATE_CONTAINERS[@]} - 1 ))
        shift 2 ;;
      --migration-check)
        if [[ $current_migrate_idx -lt 0 ]]; then
          die_usage "--migration-check given before any --migrate"
        fi
        MIGRATION_CHECK_CMDS[$current_migrate_idx]="$2"
        shift 2 ;;
      --migration-run)
        if [[ $current_migrate_idx -lt 0 ]]; then
          die_usage "--migration-run given before any --migrate"
        fi
        MIGRATION_RUN_CMDS[$current_migrate_idx]="$2"
        shift 2 ;;
      --migration-mode)
        MIGRATION_MODE="$2"; shift 2 ;;
      --health)
        split_kv "$2"; HEALTH_CHECK["$KV_KEY"]="$KV_VAL"; shift 2 ;;
      *)
        die_usage "unknown argument '$1'" ;;
    esac
  done

  [[ -n "$EXECUTION_ID" ]] || die_usage "--execution-id is required"
  [[ -n "$UNIT" ]] || die_usage "--unit is required"
  [[ -n "$LOCK_KEY" ]] || die_usage "--lock-key is required"
  [[ -n "$FENCING_TOKEN" ]] || die_usage "--fencing-token is required"
  [[ ${#NEW_IMAGE[@]} -gt 0 ]] || die_usage "at least one --artifact is required"
  case "$MIGRATION_MODE" in
    ephemeral|temp-container) ;;
    *) die_usage "--migration-mode must be 'ephemeral' or 'temp-container'" ;;
  esac

  # Validated BEFORE any effect (before the lock is even attempted): these
  # identifiers become part of filesystem paths (lock file, per-execution
  # tmp dir, temp-container names) or docker name filters.
  validate_token "--execution-id" "$EXECUTION_ID"
  validate_token "--lock-key" "$LOCK_KEY"
  local name
  for name in "${!NEW_IMAGE[@]}" "${!PREV_IMAGE_HINT[@]}" "${!PORT_MAP[@]}" \
              "${!SECRET_REF[@]}" "${!HEALTH_CHECK[@]}" "${MIGRATE_CONTAINERS[@]:-}"; do
    if [[ -n "$name" ]]; then
      validate_token "container name" "$name"
    fi
  done

  # Artifact and previous-image references must be immutable digests (DD-26).
  # Still before any effect (before the lock is attempted).
  for name in "${!NEW_IMAGE[@]}"; do
    validate_artifact_ref "--artifact $name" "${NEW_IMAGE[$name]}"
  done
  for name in "${!PREV_IMAGE_HINT[@]}"; do
    validate_artifact_ref "--previous $name" "${PREV_IMAGE_HINT[$name]}"
  done
  return 0
}

# ---------------------------------------------------------------------------
# Locked-worker state (populated by main_inner)
# ---------------------------------------------------------------------------

declare -A RUNNING_IMAGE=()
declare -A RESTORE_IMAGE=()
declare -A DEPLOYED_IMAGE=()
declare -A ALREADY_CURRENT=()
declare -A SKIP_PRUNE=()
declare -A UNRESOLVED_PREV=()
MIGRATIONS_STATUS="NONE"
HEALTHY=""
TMP_DIR=""
RESULT_FILE=""
LOCK_FILE=""

env_file_for() {
  local container="$1"
  printf '%s/runtime-%s.env' "$TMP_DIR" "$container"
}

container_port_args() {
  local container="$1"
  if [[ -n "${PORT_MAP[$container]:-}" ]]; then
    printf '%s\n%s\n' "-p" "${PORT_MAP[$container]}"
  fi
}

container_env_args() {
  local container="$1"
  local f; f="$(env_file_for "$container")"
  if [[ -f "$f" ]]; then
    printf '%s\n%s\n' "--env-file" "$f"
  fi
}

materialize_runtime_secret() {
  local container="$1"
  local ref="${SECRET_REF[$container]:-}"
  [[ -n "$ref" ]] || return 0
  local f; f="$(env_file_for "$container")"
  # Created with 0600 from the first byte (umask), never through a variable
  # that could be echoed or logged.
  (umask 177; fetch_runtime_secret "$ref" > "$f")
}

start_container() {
  local container="$1" image="$2"
  local -a port_args=() env_args=()
  mapfile -t port_args < <(container_port_args "$container")
  mapfile -t env_args < <(container_env_args "$container")
  docker run -d --name "$container" "${port_args[@]}" "${env_args[@]}" "$image" >/dev/null
}

stop_and_remove_container() {
  local container="$1"
  docker stop "$container" >/dev/null 2>&1 || true
  docker rm "$container" >/dev/null 2>&1 || true
}

swap_container() {
  local container="$1"
  local image="${NEW_IMAGE[$container]}"
  stop_and_remove_container "$container"
  start_container "$container" "$image"
}

restore_container() {
  local container="$1"
  local restore_image="${RESTORE_IMAGE[$container]:-}"
  [[ -n "$restore_image" ]] || return 0
  stop_and_remove_container "$container"
  if start_container "$container" "$restore_image"; then
    DEPLOYED_IMAGE["$container"]="$restore_image"
  fi
}

restore_all_containers() {
  local container
  for container in "${!NEW_IMAGE[@]}"; do
    # A container this run did not change must not be rolled back.
    [[ -n "${ALREADY_CURRENT[$container]:-}" ]] && continue
    restore_container "$container"
  done
}

run_migration_step() {
  local container="$1" image="$2" check_cmd="$3" run_cmd="$4"
  local -a env_args=()
  mapfile -t env_args < <(container_env_args "$container")

  local check_rc=0 run_rc=0

  if [[ "$MIGRATION_MODE" == "temp-container" ]]; then
    # DD-11 / P-5 fallback: start the NEW image under a temporary name (the
    # old container is never touched), run the commands inside it via exec,
    # then stop/remove the temporary one. "Migrate before stopping old" is
    # preserved because the old container is untouched in this branch.
    local temp_name="${container}-migrating-${EXECUTION_ID}"
    if ! docker run -d --name "$temp_name" "${env_args[@]}" "$image" >/dev/null 2>&1; then
      return 1
    fi
    docker exec "$temp_name" sh -c "$check_cmd" >/dev/null 2>&1 || check_rc=$?
    if [[ $check_rc -ne 0 && -n "$run_cmd" ]]; then
      docker exec "$temp_name" sh -c "$run_cmd" >/dev/null 2>&1 || run_rc=$?
    fi
    docker stop "$temp_name" >/dev/null 2>&1 || true
    docker rm "$temp_name" >/dev/null 2>&1 || true
  else
    # Ephemeral container of the new image (default; design DD-11 primary
    # variant, assuming P-5 holds).
    docker run --rm "${env_args[@]}" "$image" sh -c "$check_cmd" >/dev/null 2>&1 || check_rc=$?
    if [[ $check_rc -ne 0 && -n "$run_cmd" ]]; then
      docker run --rm "${env_args[@]}" "$image" sh -c "$run_cmd" >/dev/null 2>&1 || run_rc=$?
    fi
  fi

  if [[ $check_rc -eq 0 ]]; then
    MIGRATIONS_STATUS="NONE"
    return 0
  fi
  if [[ $run_rc -eq 0 ]]; then
    MIGRATIONS_STATUS="APPLIED"
    return 0
  fi
  MIGRATIONS_STATUS="FAILED"
  return 1
}

run_health_check() {
  local container="$1"
  local spec="${HEALTH_CHECK[$container]}"
  if [[ "$spec" =~ ^https?:// ]]; then
    curl -fsS --max-time 10 "$spec" >/dev/null 2>&1
  else
    docker exec "$container" sh -c "$spec" >/dev/null 2>&1
  fi
}

# Prunes images (by digest) of the same repository as the newly deployed one, EXCLUDING
# the one just deployed and the one kept as "previous" (restore candidate).
# Scoped to one repository at a time -- never a host-wide prune (the FA's C8
# risk the proposal calls out is exactly this kind of unscoped prune).
prune_old_images_for_container() {
  local container="$1"
  local new_image="${NEW_IMAGE[$container]}"
  local restore_image="${RESTORE_IMAGE[$container]:-}"
  local repo; repo="$(image_repository "$new_image")"
  local digest candidate
  while IFS= read -r digest; do
    # Untagged-and-undigested rows ('<none>') carry no usable reference.
    [[ -n "$digest" && "$digest" != "<none>" ]] || continue
    candidate="${repo}@${digest}"
    [[ "$candidate" == "$new_image" ]] && continue
    [[ -n "$restore_image" && "$candidate" == "$restore_image" ]] && continue
    # Unresolved previous (image ID, no matching RepoDigest): keep whichever
    # candidate is that same image.
    if [[ -n "${UNRESOLVED_PREV[$container]:-}" ]]; then
      local cand_id
      cand_id="$(docker image inspect --format '{{.Id}}' "$candidate" 2>/dev/null || true)"
      [[ -n "$cand_id" && "$cand_id" == "$restore_image" ]] && continue
    fi
    docker rmi "$candidate" >/dev/null 2>&1 || true
  done < <(docker images --digests --format '{{.Digest}}' "$repo" 2>/dev/null || true)
}

healthy_json_literal() {
  case "$HEALTHY" in
    true) printf 'true' ;;
    false) printf 'false' ;;
    *) printf 'null' ;;
  esac
}

status_for_exit_code() {
  case "$1" in
    0) printf 'SUCCESS' ;;
    10) printf 'PULL_FAILED' ;;
    20) printf 'MIGRATION_FAILED' ;;
    30) printf 'START_FAILED' ;;
    40) printf 'HEALTH_FAILED' ;;
    *) printf 'UNKNOWN_TARGET_STATE' ;;
  esac
}

write_result_and_exit() {
  local code="$1"
  local deployed_json previous_json
  # An unresolved previous image (see resolve_running_image) is reported as
  # "unresolved:<image-id>" -- still valid JSON, never a tag.
  local -A deployed_report=() previous_report=()
  local c
  for c in "${!DEPLOYED_IMAGE[@]}"; do
    deployed_report["$c"]="${DEPLOYED_IMAGE[$c]}"
    if [[ -n "${UNRESOLVED_PREV[$c]:-}" && "${DEPLOYED_IMAGE[$c]}" == "${RESTORE_IMAGE[$c]:-}" ]]; then
      deployed_report["$c"]="unresolved:${DEPLOYED_IMAGE[$c]}"
    fi
  done
  for c in "${!RESTORE_IMAGE[@]}"; do
    previous_report["$c"]="${RESTORE_IMAGE[$c]}"
    if [[ -n "${UNRESOLVED_PREV[$c]:-}" ]]; then
      previous_report["$c"]="unresolved:${RESTORE_IMAGE[$c]}"
    fi
  done
  deployed_json="$(json_map deployed_report)"
  previous_json="$(json_map previous_report)"
  {
    printf '{'
    printf '"status":"%s",' "$(json_escape "$(status_for_exit_code "$code")")"
    printf '"deployedImages":%s,' "$deployed_json"
    printf '"previousImages":%s,' "$previous_json"
    printf '"migrations":"%s",' "$(json_escape "$MIGRATIONS_STATUS")"
    printf '"healthy":%s' "$(healthy_json_literal)"
    printf '}'
  } > "$RESULT_FILE"
  exit "$code"
}

cleanup_tmp_dir() {
  rm -rf "$TMP_DIR" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Locked worker: everything here runs ONLY while the kernel lock is held
# (invoked by the outer orchestrator through `flock`). This is the "critical
# section"; the whole script already ignores HUP (see top of file).
# ---------------------------------------------------------------------------
main_inner() {
  parse_args "$@"

  TMP_DIR="/tmp/cicd-${EXECUTION_ID}"
  RESULT_FILE="/tmp/cicd-${EXECUTION_ID}.result.json"
  LOCK_FILE="${CICD_LOCK_DIR:-/var/lock/cicd}/${LOCK_KEY}.lock"

  trap cleanup_tmp_dir EXIT
  mkdir -p "$TMP_DIR"
  chmod 700 "$TMP_DIR" 2>/dev/null || true

  # Lock-file diagnostics for the runbook (§12.1): executionId, fencingToken,
  # PID, start time. Writing content does not disturb the kernel lock itself
  # (a different open, same inode) -- never delete this file to "release" it.
  {
    printf 'executionId=%s\n' "$EXECUTION_ID"
    printf 'fencingToken=%s\n' "$FENCING_TOKEN"
    printf 'pid=%s\n' "$$"
    printf 'startTime=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$LOCK_FILE" 2>/dev/null || true

  local container

  # 1. Discover the image ACTUALLY running per container. The authoritative
  #    source for restoring is this, never DynamoDB/--previous (design §6.5).
  #    --previous is used only as a hint when the container does not exist.
  for container in "${!NEW_IMAGE[@]}"; do
    local running
    running="$(docker_running_image "$container")"
    RUNNING_IMAGE["$container"]="$running"
    if [[ -n "$running" ]]; then
      # Never record or restore a tag: resolve to an immutable identity first.
      resolve_running_image "$container" "$running"         "$(image_repository "${NEW_IMAGE[$container]}")" "${NEW_IMAGE[$container]}"
      running="$RESOLVED_REF"
    fi
    if [[ -n "$running" ]]; then
      if [[ "$running" == "${NEW_IMAGE[$container]}" ]]; then
        # Idempotent re-run (FR-13 "script idempotency"): the running image
        # already is the requested digest. Docker state no longer exposes the
        # real previous (N-1) image, so RESTORE_IMAGE must NOT become
        # "$running" (it would equal NEW_IMAGE, collapse the keep-set and let
        # pruning delete the real previous image). Keep the --previous hint
        # as keep candidate; with no hint, skip pruning for this container.
        ALREADY_CURRENT["$container"]=1
        if [[ -n "${PREV_IMAGE_HINT[$container]:-}" ]]; then
          RESTORE_IMAGE["$container"]="${PREV_IMAGE_HINT[$container]}"
        else
          RESTORE_IMAGE["$container"]=""
          SKIP_PRUNE["$container"]=1
        fi
      else
        RESTORE_IMAGE["$container"]="$running"
        if [[ "$RESOLVED_UNRESOLVED" -eq 1 ]]; then
          UNRESOLVED_PREV["$container"]=1
        fi
      fi
    else
      RESTORE_IMAGE["$container"]="${PREV_IMAGE_HINT[$container]:-}"
    fi
  done

  # 2. Login + pull every NEW image BY DIGEST (no effects on running containers yet).
  for container in "${!NEW_IMAGE[@]}"; do
    local image="${NEW_IMAGE[$container]}"
    if ! docker_login_for_image "$image"; then
      write_result_and_exit 10
    fi
    if ! docker pull "$image" >/dev/null 2>&1; then
      write_result_and_exit 10
    fi
  done

  # 3. Materialize runtime secrets (0600, under the per-execution tmp dir).
  for container in "${!SECRET_REF[@]}"; do
    materialize_runtime_secret "$container"
  done

  # 4. Migration BEFORE the swap, while the OLD container keeps serving.
  local idx
  for idx in "${!MIGRATE_CONTAINERS[@]}"; do
    container="${MIGRATE_CONTAINERS[$idx]}"
    [[ -n "${ALREADY_CURRENT[$container]:-}" ]] && continue
    local check_cmd="${MIGRATION_CHECK_CMDS[$idx]}"
    local run_cmd="${MIGRATION_RUN_CMDS[$idx]}"
    local new_image="${NEW_IMAGE[$container]}"
    if ! run_migration_step "$container" "$new_image" "$check_cmd" "$run_cmd"; then
      write_result_and_exit 20
    fi
  done

  # 5. Swap (stop old, start new) -- skipped for already-current containers
  #    (script idempotency, FR-13 "script idempotency" scenario).
  for container in "${!NEW_IMAGE[@]}"; do
    if [[ -n "${ALREADY_CURRENT[$container]:-}" ]]; then
      DEPLOYED_IMAGE["$container"]="${NEW_IMAGE[$container]}"
      continue
    fi
    if ! swap_container "$container"; then
      restore_all_containers
      write_result_and_exit 30
    fi
    DEPLOYED_IMAGE["$container"]="${NEW_IMAGE[$container]}"
  done

  # 6. Health check.
  HEALTHY="true"
  for container in "${!HEALTH_CHECK[@]}"; do
    if ! run_health_check "$container"; then
      HEALTHY="false"
      restore_all_containers
      write_result_and_exit 40
    fi
  done

  # 7. Pruning: always keeps current and previous; never a host-wide prune.
  #    Skipped for idempotent re-runs with no --previous hint (see step 1):
  #    with no safe keep candidate, the safe default is to touch nothing.
  for container in "${!NEW_IMAGE[@]}"; do
    [[ -n "${SKIP_PRUNE[$container]:-}" ]] && continue
    prune_old_images_for_container "$container"
  done

  write_result_and_exit 0
}

# ---------------------------------------------------------------------------
# Outer orchestrator: takes the non-blocking KERNEL lock (flock) and either
# runs the locked worker (as a child, NOT an exec-replace, so this process is
# still alive afterwards to always print the final CICD_RESULT line) or, if
# busy, reports TARGET_BUSY itself with no effects whatsoever.
# ---------------------------------------------------------------------------
main_outer() {
  parse_args "$@"

  local lock_dir="${CICD_LOCK_DIR:-/var/lock/cicd}"
  LOCK_FILE="${lock_dir}/${LOCK_KEY}.lock"
  RESULT_FILE="/tmp/cicd-${EXECUTION_ID}.result.json"
  mkdir -p "$lock_dir" 2>/dev/null || true
  rm -f "$RESULT_FILE" 2>/dev/null || true

  local locked_exit=0
  set +e
  flock -n -E 50 "$LOCK_FILE" "$SCRIPT_PATH" --internal-locked "$@"
  locked_exit=$?
  set -e

  if [[ "$locked_exit" -eq 50 ]]; then
    local mutex_holder="" line
    if [[ -f "$LOCK_FILE" ]]; then
      while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ -n "$mutex_holder" ]]; then
          mutex_holder+="; ${line}"
        else
          mutex_holder="$line"
        fi
      done < "$LOCK_FILE"
    fi
    printf 'CICD_RESULT {"status":"TARGET_BUSY","deployedImages":{},"previousImages":{},"migrations":"NONE","healthy":null,"mutexHolder":"%s"}\n' \
      "$(json_escape "$mutex_holder")"
    exit 50
  fi

  local body
  if [[ -f "$RESULT_FILE" ]]; then
    body="$(cat "$RESULT_FILE")"
    rm -f "$RESULT_FILE" 2>/dev/null || true
  else
    body='{"status":"UNKNOWN_TARGET_STATE","deployedImages":{},"previousImages":{},"migrations":"NONE","healthy":null}'
  fi
  printf 'CICD_RESULT %s\n' "$body"
  exit "$locked_exit"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--internal-locked" ]]; then
  shift
  main_inner "$@"
else
  main_outer "$@"
fi

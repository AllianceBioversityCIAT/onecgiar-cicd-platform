#!/usr/bin/env bash
# Technology-neutral deploy script TEMPLATE (architecture-change-03, design §6.5).
#
# Copy this file to the target as the target record's `deployScript` (mode 0755, owned by an
# administrator, not writable by the deploy user; V1-R3) and replace ONLY the block between
# the PLATFORM markers with the platform's own procedure (for example the deploy stages taken
# from a Jenkins job). Everything outside that block is the common contract:
#
#   * Invocation: no argument (target `scriptArguments: none`) or the standard vector
#     (`--target-id --execution-id --fencing-token --commit-sha [--artifact <name>=sha256:<hex>]...`).
#     Any other argument is a usage error (exit 2, no effect).
#   * Target mutex: a non-blocking kernel flock taken before any effect; busy -> exit 50, no effect.
#   * Exit codes (AC-03 §3): 0 deployed; 10 failed before any change; 20 failed in a pre-switch
#     step; 30 switch failed and the previous state WAS restored; 40 verification failed and the
#     previous state WAS restored; 50 busy. A failure the script cannot restore exits 70, which the
#     Executor reports as UNKNOWN_TARGET_STATE (it is never reported as restored).
#   * Result: last stdout line `CICD_RESULT {...}` on 0/10/20/30/40/50, with `deployedCommit`
#     when the platform block sets DEPLOYED_COMMIT.
#
# Each phase runs in a subshell with `set -e`, so the first failing command of a phase fails the
# phase (a plain `exit 1` from a Jenkins-style step is mapped to the right contract code here).
# Never put secrets in this file; the platform block reads them with the target's own permissions.
# Requires bash >= 4.4 (inherit_errexit); on an older bash every run fails safely with exit 10 before any change.

set -uo pipefail
trap '' HUP
PATH="${PATH:+${PATH}:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

# Defaults (kept when the platform block does not override them). A platform that implements
# nothing fails safely: prepare fails before any change (exit 10) and restore reports "cannot restore".
phase_prepare() { echo "phase_prepare is not implemented for this platform" >&2; return 1; }
phase_pre_switch() { return 0; }
phase_switch() { echo "phase_switch is not implemented for this platform" >&2; return 1; }
phase_verify() { return 0; }
phase_restore() { return 1; }

# ===== BEGIN PLATFORM ===========================================================================
# Replace this block only. FUNCTION DEFINITIONS AND VARIABLE ASSIGNMENTS ONLY: this block is read at load
# time, before the arguments are validated and before the mutex is taken, so a command with an effect at
# top level would run without protection (and twice). Every step goes inside a phase function.
# Define TARGET_LOCK_NAME and override the phases the platform needs:
#   phase_prepare     fetch / download / validate; must not change the running service   (fail -> 10)
#   phase_pre_switch  optional pre-switch steps (e.g. migrations); the service keeps serving (fail -> 20)
#   phase_switch      switch the running service to the new version          (fail + restore -> 30)
#   phase_verify      optional verification of the new version (health)      (fail + restore -> 40)
#   phase_restore     restore the previous version; return non-zero when it cannot (then exit 70)
# Inputs (read-only): REQUESTED_COMMIT (standard mode; empty in none mode), REQUESTED_ARTIFACT[name]
# (sha256 digests, standard mode), EXECUTION_ID, TARGET_ID, FENCING_TOKEN (standard mode).
# Set DEPLOYED_COMMIT (40-hex) once the platform knows the commit it actually deployed.
#
# TARGET_LOCK_NAME is the target mutex name in BOTH modes (so a manual run and an Executor run of this
# script always exclude each other); with the standard vector the --target-id must equal it. Targets
# sharing a resource (one Tomcat, a port, a proxy) must also take a shared lock around that resource
# inside their phases.
TARGET_LOCK_NAME="<TARGET_LOCK_NAME>"
# ===== END PLATFORM =============================================================================

TARGET_ID=""
EXECUTION_ID=""
FENCING_TOKEN=""
REQUESTED_COMMIT=""
DEPLOYED_COMMIT=""
declare -A REQUESTED_ARTIFACT=()

usage() { echo "deploy script: $*" >&2; exit 2; }

parse_args() {
  local name value
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 ]] || usage "'$1' needs a value"
    case "$1" in
      --target-id) TARGET_ID="$2" ;;
      --execution-id) EXECUTION_ID="$2" ;;
      --fencing-token) FENCING_TOKEN="$2" ;;
      --commit-sha) REQUESTED_COMMIT="$2" ;;
      --artifact)
        name="${2%%=*}"; value="${2#*=}"
        [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,31}$ && "$value" =~ ^sha256:[0-9a-f]{64}$ ]] || usage "invalid --artifact '$2'"
        [[ -z "${REQUESTED_ARTIFACT[$name]+x}" ]] || usage "--artifact '$name' given twice"
        REQUESTED_ARTIFACT["$name"]="$value" ;;
      *) usage "unknown argument '$1'" ;;
    esac
    shift 2
  done
  if [[ -n "$TARGET_ID$EXECUTION_ID$FENCING_TOKEN$REQUESTED_COMMIT" ]]; then
    [[ "$TARGET_ID" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || usage "invalid or missing --target-id"
    [[ "$EXECUTION_ID" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || usage "invalid or missing --execution-id"
    [[ "$FENCING_TOKEN" =~ ^[0-9]{1,20}$ ]] || usage "invalid or missing --fencing-token"
    [[ "$REQUESTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || usage "invalid or missing --commit-sha"
    [[ "$TARGET_ID" == "$TARGET_LOCK_NAME" ]] || usage "--target-id '$TARGET_ID' is not this script's target"
  else
    [[ ${#REQUESTED_ARTIFACT[@]} -eq 0 ]] || usage "--artifact without the standard arguments"
  fi
  [[ "$TARGET_LOCK_NAME" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || usage "TARGET_LOCK_NAME is not configured"
  LOCK_NAME="$TARGET_LOCK_NAME"
}

result_status() {
  case "$1" in
    0) printf 'SUCCESS' ;; 10) printf 'PREPARE_FAILED' ;; 20) printf 'PRE_SWITCH_FAILED' ;;
    30) printf 'SWITCH_FAILED_RESTORED' ;; 40) printf 'VERIFY_FAILED_RESTORED' ;; 50) printf 'TARGET_BUSY' ;;
  esac
}

finish() {
  local code="$1"
  case "$code" in
    0|10|20|30|40)
      if [[ "$DEPLOYED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
        printf 'CICD_RESULT {"status":"%s","deployedCommit":"%s"}\n' "$(result_status "$code")" "$DEPLOYED_COMMIT"
      else
        printf 'CICD_RESULT {"status":"%s"}\n' "$(result_status "$code")"
      fi ;;
  esac
  exit "$code"
}

# Runs one phase with `set -e` in effect, exporting DEPLOYED_COMMIT back. It must be called as a plain
# statement, never inside an `if`, `while`, `&&` or `||`: bash disables `set -e` for everything run in
# such a context, subshells included, and a failing step would then be reported as a success.
run_phase() {
  local phase="$1" rc state="$RUN_DIR/state"
  : > "$state"
  # inherit_errexit: a failing command inside $(...) also fails the phase (a common Jenkins-step pitfall).
  ( set -e; shopt -s inherit_errexit; "$phase"; printf '%s' "$DEPLOYED_COMMIT" > "$state" )
  rc=$?
  if [[ $rc -eq 0 && -s "$state" ]]; then DEPLOYED_COMMIT="$(cat "$state")"; fi
  return "$rc"
}

main_locked() {
  parse_args "$@"
  RUN_DIR="$(mktemp -d)"
  trap 'rm -rf "$RUN_DIR"' EXIT
  {
    printf 'lockName=%s\n' "$LOCK_NAME"
    printf 'executionId=%s\n' "$EXECUTION_ID"
    printf 'fencingToken=%s\n' "$FENCING_TOKEN"
    printf 'commitSha=%s\n' "$REQUESTED_COMMIT"
    printf 'pid=%s\n' "$$"
  } > "$LOCK_FILE" 2>/dev/null || true
  local rc
  run_phase phase_prepare; rc=$?
  [[ $rc -eq 0 ]] || finish 10
  run_phase phase_pre_switch; rc=$?
  [[ $rc -eq 0 ]] || finish 20
  run_phase phase_switch; rc=$?
  if [[ $rc -ne 0 ]]; then
    run_phase phase_restore; rc=$?
    DEPLOYED_COMMIT=""   # the restored version is not the requested one: never report it as deployed
    [[ $rc -ne 0 ]] || finish 30
    exit 70
  fi
  run_phase phase_verify; rc=$?
  if [[ $rc -ne 0 ]]; then
    run_phase phase_restore; rc=$?
    DEPLOYED_COMMIT=""
    [[ $rc -ne 0 ]] || finish 40
    exit 70
  fi
  finish 0
}

if [[ "${1:-}" == "--internal-locked" ]]; then
  shift
  LOCK_FILE="$1"; shift
  main_locked "$@"
fi

parse_args "$@"
lock_dir="${CICD_LOCK_DIR:-/var/lock/cicd}"
LOCK_FILE="$lock_dir/${LOCK_NAME}.lock"
mkdir -p "$lock_dir" 2>/dev/null || true
flock -n -E 50 "$LOCK_FILE" "$SCRIPT_PATH" --internal-locked "$LOCK_FILE" "$@"
rc=$?
if [[ $rc -eq 50 ]]; then
  printf 'CICD_RESULT {"status":"TARGET_BUSY"}\n'
fi
exit "$rc"

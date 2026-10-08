#!/usr/bin/env bash
# Shared test harness for deploy-container.sh local control-flow tests.
#
# Scope reminder (see run-tests.sh header): these tests run with SHIMS
# (fake docker / flock / aws) on PATH. They prove the SCRIPT's own control
# flow -- ordering, exit codes, cleanup, no-prune-of-previous, CICD_RESULT
# shape. They do NOT and cannot validate real kernel-lock semantics, real
# Docker behavior, or other Linux-specific behavior; that is DEFERRED
# environment-dependent validation (Gate C, T-33).
set -uo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
DEPLOY_SCRIPTS_DIR="$(cd "$TEST_ROOT/.." && pwd)"
SCRIPT_UNDER_TEST="$DEPLOY_SCRIPTS_DIR/deploy-container.sh"
SHIMS_DIR="$HARNESS_DIR/shims"

# Immutable artifact references (DD-26) used by the cases: <repo>@sha256:<64-hex>.
# V0 < V1 < V2 stand for successive builds of one repository (fake digests).
IMG_REPO="registry.example.invalid/team/app"
IMG_V0="${IMG_REPO}@sha256:$(printf '0%.0s' {1..64})"
IMG_V1="${IMG_REPO}@sha256:$(printf '1%.0s' {1..64})"
IMG_ID_V1="sha256:$(printf 'b%.0s' {1..64})"
IMG_V2="${IMG_REPO}@sha256:$(printf '2%.0s' {1..64})"

TESTS_RUN=0
TESTS_FAILED=0
TESTS_SKIPPED=0
ASSERTIONS_SKIPPED=0
CURRENT_TEST_NAME=""
# A test case sets TEST_SKIPPED=1 (and calls `skip "..."`) ONLY when the
# ENTIRE test cannot meaningfully run in this environment (e.g. no usable
# signal delivery at all) and it returns 0 having checked nothing real.
# run_test() then reports it as SKIPPED, distinct from PASSED.
#
# IMPORTANT: a real failure (rc != 0) always wins over TEST_SKIPPED. A test
# that has already checked something real and found it wrong must NEVER be
# reported as SKIPPED -- that would hide the failure. A test that can run
# its real assertions but has ONE sub-check it cannot validate in this
# environment (e.g. a POSIX permission bit on a filesystem that doesn't
# reflect them) must use skip_assertion() instead of TEST_SKIPPED/skip(): it
# records an environment-limited assertion without silencing the test's
# other, real pass/fail assertions.
TEST_SKIPPED=0

# Creates a fresh, isolated sandbox for one test case and wires every path
# the script/shims use (lock dir, docker state, logs) into it, plus PATH so
# the shims shadow (nonexistent) real docker/flock/aws on this machine.
# Usage: sandbox_init "<test-name>"
sandbox_init() {
  CURRENT_TEST_NAME="$1"
  SANDBOX_DIR="$(mktemp -d)"
  export CICD_LOCK_DIR="$SANDBOX_DIR/lock"
  export DOCKER_STATE_DIR="$SANDBOX_DIR/docker-state"
  export DOCKER_LOG="$SANDBOX_DIR/docker.log"
  export AWS_FAKE_LOG="$SANDBOX_DIR/aws.log"
  # Target-side configuration (design §6.5, task R-9a): one file per target id.
  export CICD_TARGET_CONFIG_DIR="$SANDBOX_DIR/targets"
  mkdir -p "$CICD_LOCK_DIR" "$DOCKER_STATE_DIR" "$(dirname "$DOCKER_LOG")" "$CICD_TARGET_CONFIG_DIR"
  : > "$DOCKER_LOG"
  : > "$AWS_FAKE_LOG"
  export PATH="$SHIMS_DIR:$PATH"
}

sandbox_cleanup() {
  [[ -n "${SANDBOX_DIR:-}" ]] && rm -rf "$SANDBOX_DIR" 2>/dev/null || true
}

# Marks a container as currently running a given image in the docker shim's
# state (simulates "the container is running image X before the script runs").
shim_set_running() {
  local name="$1" image="$2"
  mkdir -p "$DOCKER_STATE_DIR/containers"
  printf '%s' "$image" > "$DOCKER_STATE_DIR/containers/$name"
}

# Marks an image as already pulled/present (so tests can seed decoy images
# for pruning assertions without going through a real pull).
shim_seed_image() {
  local image="$1"
  local repo="${image%@*}" digest="${image##*@}"
  local dir="$DOCKER_STATE_DIR/images/$(printf '%s' "$repo" | tr '/' '_')"
  mkdir -p "$dir"
  : > "$dir/$digest"
}

# Declares the identity of an image in the docker shim: its image ID and the
# RepoDigests it carries. Usage: shim_define_image <ref> <image-id> [repodigest...]
# <ref> (e.g. a tag form a container was started with) and every repodigest
# resolve to <image-id>.
shim_define_image() {
  local ref="$1" id="$2"; shift 2
  mkdir -p "$DOCKER_STATE_DIR/ids" "$DOCKER_STATE_DIR/repodigests"
  local key; key() { printf '%s' "$1" | tr '/' '_'; }
  printf '%s' "$id" > "$DOCKER_STATE_DIR/ids/$(key "$ref")"
  local d
  : > "$DOCKER_STATE_DIR/repodigests/$(key "$id")"
  for d in "$@"; do
    printf '%s' "$id" > "$DOCKER_STATE_DIR/ids/$(key "$d")"
    printf '%s
' "$d" >> "$DOCKER_STATE_DIR/repodigests/$(key "$id")"
  done
}

# Forces a docker control knob (e.g. pull_fail, start_fail_<name>).
shim_force() {
  local knob="$1"
  mkdir -p "$DOCKER_STATE_DIR/control"
  : > "$DOCKER_STATE_DIR/control/$knob"
}

# Pre-marks the lock as held by a (simulated) prior execution, so the next
# invocation observes TARGET_BUSY deterministically -- this is the shim's
# stand-in for "a concurrent run is already in progress" (real concurrency
# and real kernel-lock semantics are Gate C / T-33, see header).
shim_pre_acquire_lock() {
  local lock_key="$1" execution_id="$2" fencing_token="$3"
  mkdir -p "$CICD_LOCK_DIR"
  local lock_file="$CICD_LOCK_DIR/${lock_key}.lock"
  {
    printf 'executionId=%s\n' "$execution_id"
    printf 'fencingToken=%s\n' "$fencing_token"
    printf 'pid=999999\n'
    printf 'startTime=2026-01-01T00:00:00Z\n'
  } > "$lock_file"
  mkdir "${lock_file}.d"
}

# A fixed 40-hex commit for the --commit-sha argument (audit only in the script).
TEST_COMMIT_SHA="$(printf 'c%.0s' {1..40})"

# Writes the target-side configuration file of <target-id> from KEY=VALUE lines
# (design §6.5: the script maps each unit to its own trusted image repository).
# Usage: write_target_config <target-id> "unit.server.repository=..." ...
write_target_config() {
  local target="$1"; shift
  printf '%s\n' "$@" > "$CICD_TARGET_CONFIG_DIR/${target}.conf"
}

# Runs the script under test EXACTLY with the given arguments (the design §6.5
# argument vector the Executor sends), capturing stdout/stderr/exit code.
run_raw() {
  set +e
  STDOUT_FILE="$SANDBOX_DIR/stdout"
  STDERR_FILE="$SANDBOX_DIR/stderr"
  bash "$SCRIPT_UNDER_TEST" "$@" > "$STDOUT_FILE" 2> "$STDERR_FILE"
  SCRIPT_EXIT=$?
  set -e
}

# Test-side adapter for the behavioral cases (ordering, restore, pruning, mutex,
# secrets, idempotency). Each case still states its per-unit settings in the
# compact form it always used; the adapter writes them to the target
# configuration file and invokes the script with ONLY the design §6.5 vector:
#   --lock-key K               -> --target-id K (the target id is the mutex key)
#   --fencing-token tok-N      -> --fencing-token N (digits only in §6.5)
#   --artifact C=<repo>@<dig>  -> config unit.C.repository=<repo>, unit.C.container=C;
#                                 argument --artifact C=<dig>
#   --port / --health / --runtime-secret C=V -> config unit.C.<field>=V
#   --migrate C [--migration-check X] [--migration-run Y] -> config unit.C.migrate.*
#   --migration-mode M         -> config migration-mode=M
#   --unit U                   -> dropped (not part of §6.5)
# Any other argument (e.g. a removed flag) is passed through unchanged, so the
# script's own rejection is what the case observes. The interface itself is
# tested directly with run_raw (cases/test_interface_v65.sh).
run_script() {
  local -a pass_through=()
  local -A conf=()
  local -a conf_order=()
  local target="" execution_id="" token="" mig=""
  local key value unit ref
  set_conf() { [[ -n "${conf[$1]+x}" ]] || conf_order+=("$1"); conf["$1"]="$2"; }
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --execution-id) execution_id="$2"; shift 2 ;;
      --unit) shift 2 ;;
      --lock-key) target="$2"; shift 2 ;;
      --fencing-token)
        token="$2"
        if [[ "$token" =~ ^tok-([0-9]+)$ ]]; then token="${BASH_REMATCH[1]}"; fi
        shift 2 ;;
      --artifact)
        unit="${2%%=*}"; ref="${2#*=}"
        if [[ "$ref" == *"@"* ]]; then
          set_conf "unit.${unit}.repository" "${ref%@*}"
          set_conf "unit.${unit}.container" "$unit"
          pass_through+=(--artifact "${unit}=${ref##*@}")
        else
          pass_through+=(--artifact "${unit}=${ref}")
        fi
        shift 2 ;;
      --port|--health|--runtime-secret)
        key="${1#--}"; value="$2"
        set_conf "unit.${value%%=*}.${key}" "${value#*=}"
        shift 2 ;;
      --migrate) mig="$2"; set_conf "unit.${mig}.migrate.check" ""; shift 2 ;;
      --migration-check) set_conf "unit.${mig}.migrate.check" "$2"; shift 2 ;;
      --migration-run) set_conf "unit.${mig}.migrate.run" "$2"; shift 2 ;;
      --migration-mode) set_conf "migration-mode" "$2"; shift 2 ;;
      *) pass_through+=("$1"); shift ;;
    esac
  done
  if [[ -n "$target" && "$target" != */* ]]; then
    local -a lines=()
    for key in "${conf_order[@]}"; do lines+=("${key}=${conf[$key]}"); done
    write_target_config "$target" "${lines[@]}"
  fi
  local -a vector=()
  [[ -n "$target" ]] && vector+=(--target-id "$target")
  [[ -n "$execution_id" ]] && vector+=(--execution-id "$execution_id")
  [[ -n "$token" ]] && vector+=(--fencing-token "$token")
  vector+=(--commit-sha "$TEST_COMMIT_SHA")
  run_raw "${vector[@]}" "${pass_through[@]}"
}

container_is_running() {
  local name="$1"
  [[ -f "$DOCKER_STATE_DIR/containers/$name" ]]
}

container_running_image() {
  local name="$1"
  cat "$DOCKER_STATE_DIR/containers/$name" 2>/dev/null || true
}

image_is_present() {
  local image="$1"
  local repo="${image%@*}" digest="${image##*@}"
  [[ -f "$DOCKER_STATE_DIR/images/$(printf '%s' "$repo" | tr '/' '_')/$digest" ]]
}

docker_log_contains() {
  grep -qF -- "$1" "$DOCKER_LOG"
}

last_stdout_line() {
  tail -n 1 "$STDOUT_FILE"
}

# Extracts the JSON payload after the "CICD_RESULT " prefix on the last line.
cicd_result_json() {
  local line
  line="$(last_stdout_line)"
  printf '%s' "${line#CICD_RESULT }"
}

json_is_valid() {
  local json="$1"
  if command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' <<< "$json" >/dev/null 2>&1
  else
    # Crude fallback: balanced-looking braces, non-empty.
    [[ -n "$json" && "$json" == \{*\} ]]
  fi
}

json_get() {
  local json="$1" path="$2"
  node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const path = process.argv[1].split(".");
    let v = data;
    for (const p of path) { v = (v === undefined || v === null) ? undefined : v[p]; }
    if (v === undefined) { process.exit(1); }
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
  ' "$path" <<< "$json"
}

assert_eq() {
  local expected="$1" actual="$2" msg="$3"
  if [[ "$expected" != "$actual" ]]; then
    fail "$msg (expected '$expected', got '$actual')"
    return 1
  fi
  return 0
}

pass() {
  printf '  PASS: %s\n' "$1"
}

fail() {
  printf '  FAIL: %s\n' "$1"
}

skip() {
  printf '  SKIP: %s\n' "$1"
}

# For ONE assertion inside an otherwise-runnable test that cannot be
# validated in this environment (e.g. POSIX permission bits on a filesystem
# that doesn't reflect them). Does NOT mark the whole test skipped and does
# NOT affect its pass/fail outcome -- the test's other, real assertions
# still determine PASS/FAIL normally. Tracked in its own counter so a run
# stays honest about what it could and couldn't check, without using that
# as cover to go quiet on a real failure.
skip_assertion() {
  ASSERTIONS_SKIPPED=$((ASSERTIONS_SKIPPED + 1))
  printf '  SKIP (assertion only, test still reports PASS/FAIL on the rest): %s\n' "$1"
}

# Runs a test-case function in an isolated sandbox, tracking pass/fail/skip.
# A test case that cannot run AT ALL in this environment sets TEST_SKIPPED=1
# (and calls skip "...") before returning 0; it is reported and counted as
# SKIPPED, never as PASSED. A real failure ALWAYS wins over TEST_SKIPPED:
# a test that found something wrong is FAILED, never SKIPPED, even if it
# also hit an environment limitation along the way (that case should use
# skip_assertion() instead, precisely so it doesn't reach this ambiguity).
# Usage: run_test "<name>" test_function_name
run_test() {
  local name="$1" fn="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  echo "TEST: $name"
  sandbox_init "$name"
  TEST_SKIPPED=0
  local rc=0
  if ! "$fn"; then
    rc=1
  fi
  if [[ $rc -ne 0 ]]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo "  ===> TEST FAILED: $name"
  elif [[ "$TEST_SKIPPED" -eq 1 ]]; then
    TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
    echo "  ===> TEST SKIPPED: $name"
  fi
  sandbox_cleanup
}

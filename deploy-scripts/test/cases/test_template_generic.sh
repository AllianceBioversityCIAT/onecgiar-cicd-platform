#!/usr/bin/env bash
# architecture-change-03 G-4: the technology-neutral template. Each case GENERATES a script from
# deploy-scripts/templates/deploy-script-template.sh by replacing only the PLATFORM block (exactly
# how platform scripts are produced from Jenkins stages) and runs it as the Executor would: with no
# argument (scriptArguments: none) or with the standard vector. No Docker is involved: the phases
# below only touch marker files, standing in for PM2, Tomcat or any other procedure.

TEMPLATE="$DEPLOY_SCRIPTS_DIR/templates/deploy-script-template.sh"
TPL_COMMIT="$(printf 'd%.0s' {1..40})"

# Usage: make_template_script <platform block text>; sets GEN_SCRIPT.
make_template_script() {
  local block="$1"
  GEN_SCRIPT="$SANDBOX_DIR/gen/deploy-example-dev.sh"
  mkdir -p "$SANDBOX_DIR/gen" "$SANDBOX_DIR/markers"
  export TPL_MARKERS="$SANDBOX_DIR/markers"
  awk -v block="$block" '
    /^# ===== BEGIN PLATFORM/ { print; print block; skip = 1; next }
    /^# ===== END PLATFORM/ { skip = 0 }
    !skip { print }
  ' "$TEMPLATE" > "$GEN_SCRIPT"
  chmod +x "$GEN_SCRIPT"
}

run_generated() {
  set +e
  STDOUT_FILE="$SANDBOX_DIR/stdout"; STDERR_FILE="$SANDBOX_DIR/stderr"
  bash "$GEN_SCRIPT" "$@" < /dev/null > "$STDOUT_FILE" 2> "$STDERR_FILE"
  SCRIPT_EXIT=$?
  set -e
}

# A platform block whose phases record what ran; FAIL_AT=<phase> makes that phase fail midway.
tpl_block() {
  local fail_at="${1:-}" restore_ok="${2:-yes}"
  cat <<EOF
TARGET_LOCK_NAME="example-app-dev"
mark() { : > "\$TPL_MARKERS/\$1"; }
phase_prepare()    { mark prepare;    if [[ "$fail_at" == prepare ]]; then false; mark prepare-after-failure; fi; }
phase_pre_switch() { mark pre_switch; [[ "$fail_at" != pre_switch ]] || exit 1; }
phase_switch()     { mark switch;     [[ "$fail_at" != switch ]] || exit 1; DEPLOYED_COMMIT="\${REQUESTED_COMMIT:-$TPL_COMMIT}"; }
phase_verify()     { mark verify;     [[ "$fail_at" != verify ]] || exit 1; }
phase_restore()    { mark restore;    [[ "$restore_ok" == yes ]]; }
EOF
}

std_vector() {
  printf '%s\n' --target-id example-app-dev --execution-id example-app-dev-9 --fencing-token 9 --commit-sha "$TPL_COMMIT"
}

ran() { [[ -f "$TPL_MARKERS/$1" ]]; }

test_template_none_mode() {
  local ok=0
  make_template_script "$(tpl_block)"
  run_generated
  assert_eq "0" "$SCRIPT_EXIT" "no-argument run deploys (exit 0)" || ok=1
  local json; json="$(cicd_result_json)"
  assert_eq "SUCCESS" "$(json_get "$json" status)" "CICD_RESULT status" || ok=1
  assert_eq "$TPL_COMMIT" "$(json_get "$json" deployedCommit)" "the commit the platform block reports is in CICD_RESULT" || ok=1
  if grep -qx "lockName=example-app-dev" "$CICD_LOCK_DIR/example-app-dev.lock"; then pass "mutex taken under the configured TARGET_LOCK_NAME"; else fail "lock file: $(cat "$CICD_LOCK_DIR"/*.lock 2>/dev/null)"; ok=1; fi
  return $ok
}

test_template_standard_mode() {
  local ok=0
  make_template_script "$(tpl_block)"
  local -a v=(); mapfile -t v < <(std_vector)
  run_generated "${v[@]}" --artifact "app=sha256:$(printf 'e%.0s' {1..64})"
  assert_eq "0" "$SCRIPT_EXIT" "standard vector deploys (exit 0)" || ok=1
  assert_eq "$TPL_COMMIT" "$(json_get "$(cicd_result_json)" deployedCommit)" "deployedCommit = the requested commit" || ok=1
  if grep -qx "fencingToken=9" "$CICD_LOCK_DIR/example-app-dev.lock"; then pass "mutex keyed by --target-id records the fencing token"; else fail "lock file: $(cat "$CICD_LOCK_DIR"/*.lock 2>/dev/null)"; ok=1; fi
  return $ok
}

test_template_failure_mapping() {
  local ok=0 case_ fail_at restore expected
  for case_ in "prepare yes 10" "pre_switch yes 20" "switch yes 30" "verify yes 40" "switch no 70" "verify no 70"; do
    read -r fail_at restore expected <<< "$case_"
    rm -rf "$SANDBOX_DIR/markers" "$CICD_LOCK_DIR"/*
    make_template_script "$(tpl_block "$fail_at" "$restore")"
    run_generated
    assert_eq "$expected" "$SCRIPT_EXIT" "failure in $fail_at (restore=$restore) -> exit $expected" || ok=1
    if [[ "$expected" == "70" ]]; then
      if grep -q '^CICD_RESULT' "$STDOUT_FILE"; then fail "no CICD_RESULT expected when the state cannot be restored"; ok=1; else pass "unrestorable failure: no CICD_RESULT (reported as unknown, never as restored)"; fi
    else
      json_is_valid "$(cicd_result_json)" || { fail "CICD_RESULT invalid for exit $expected"; ok=1; }
    fi
  done
  # A failing command stops its phase (set -e is effective inside phases) and later phases never run.
  rm -rf "$SANDBOX_DIR/markers" "$CICD_LOCK_DIR"/*
  make_template_script "$(tpl_block prepare)"
  run_generated
  if ran prepare-after-failure || ran switch; then fail "execution continued after a failing command"; ok=1; else pass "a failing command stops the phase; switch never ran"; fi
  # A failing command substitution inside a phase also fails the phase (inherit_errexit).
  rm -rf "$CICD_LOCK_DIR"/* "$SANDBOX_DIR/markers"
  make_template_script 'TARGET_LOCK_NAME="example-app-dev"
phase_prepare() { local v; v="$(false; echo continued)"; : > "$TPL_MARKERS/after-substitution"; }'
  run_generated
  assert_eq "10" "$SCRIPT_EXIT" "a failing \$(...) in a phase -> exit 10" || ok=1
  if ran after-substitution; then fail "execution continued after a failing command substitution"; ok=1; else pass "a failing command substitution stops the phase"; fi
  # A platform block that implements nothing fails safely before any change.
  rm -rf "$CICD_LOCK_DIR"/*
  make_template_script 'TARGET_LOCK_NAME="example-app-dev"'
  run_generated
  assert_eq "10" "$SCRIPT_EXIT" "unimplemented platform block -> exit 10 (nothing changed)" || ok=1
  return $ok
}

test_template_busy_and_usage() {
  local ok=0
  make_template_script "$(tpl_block)"
  shim_pre_acquire_lock "example-app-dev" "other-execution" "1"
  run_generated
  assert_eq "50" "$SCRIPT_EXIT" "held mutex -> exit 50" || ok=1
  if ran prepare; then fail "a phase ran while the mutex was held"; ok=1; else pass "no phase ran while busy"; fi
  assert_eq "TARGET_BUSY" "$(json_get "$(cicd_result_json)" status)" "busy CICD_RESULT" || ok=1
  rm -rf "$CICD_LOCK_DIR"/* "$SANDBOX_DIR/markers"
  local bad
  for bad in "--unit x" "--target-id example-app-dev" "--commit-sha nothex" "--artifact app=v1" \
             "--target-id other-target --execution-id e1 --fencing-token 1 --commit-sha $TPL_COMMIT"; do
    # shellcheck disable=SC2086
    run_generated $bad
    assert_eq "2" "$SCRIPT_EXIT" "usage error for '$bad'" || ok=1
  done
  if ran prepare; then fail "a phase ran on a usage error"; ok=1; else pass "no phase ran on usage errors"; fi
  return $ok
}

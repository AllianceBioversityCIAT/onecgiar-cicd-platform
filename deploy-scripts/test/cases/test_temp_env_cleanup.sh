#!/usr/bin/env bash
# FR-13 "temporary configuration" scenario.
# GIVEN the runtime configuration materialized in a temporary file
# THEN ... it is removed on the target on any outcome
#
# Exercises the per-execution tmp dir (/tmp/cicd-{executionId}/, design §5.3)
# across every deploy-outcome exit path: 0, 10, 20, 30, 40, 50. Each run uses
# its own unique executionId so sub-cases cannot contaminate one another, and
# each sub-case removes any leftover directory defensively before asserting.
test_temp_env_cleanup() {
  local ok=0

  _assert_tmp_gone() {
    local execution_id="$1" label="$2"
    local dir="/tmp/cicd-${execution_id}"
    if [[ -e "$dir" ]]; then
      fail "temp dir $dir still exists after exit path '$label'"
      rm -rf "$dir" 2>/dev/null || true
      return 1
    fi
    pass "temp dir removed after exit path '$label'"
    return 0
  }

  # Each sub-case below is a logically independent deploy invocation; reset
  # the fake docker's container/image state between them so one sub-case's
  # resulting "running" container cannot make the NEXT sub-case look
  # idempotent (same image already running) by accident.
  _reset_docker_world() {
    rm -rf "$DOCKER_STATE_DIR/containers" "$DOCKER_STATE_DIR/images" "$DOCKER_STATE_DIR/control"
    mkdir -p "$DOCKER_STATE_DIR/containers" "$DOCKER_STATE_DIR/images" "$DOCKER_STATE_DIR/control"
  }

  # --- exit 0 (success), with a runtime secret present ---
  local id_ok="t14-tmp-ok-$$-$RANDOM"
  run_script \
    --execution-id "$id_ok" --unit demo-unit \
    --artifact server="$IMG_V2" \
    --lock-key demo-lock --fencing-token tok-1 \
    --runtime-secret server=fake-secret-ref
  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "expected exit 0 for success sub-case, got $SCRIPT_EXIT"; ok=1; }
  _assert_tmp_gone "$id_ok" "0 (success)" || ok=1

  # --- exit 10 (pull failed) ---
  _reset_docker_world
  shim_force "pull_fail"
  local id_10="t14-tmp-10-$$-$RANDOM"
  run_script \
    --execution-id "$id_10" --unit demo-unit \
    --artifact server="$IMG_V2" \
    --lock-key demo-lock2 --fencing-token tok-1
  [[ "$SCRIPT_EXIT" -eq 10 ]] || { fail "expected exit 10 for pull-fail sub-case, got $SCRIPT_EXIT"; ok=1; }
  _assert_tmp_gone "$id_10" "10 (pull failed)" || ok=1
  rm -f "$DOCKER_STATE_DIR/control/pull_fail"

  # --- exit 20 (migration failed) ---
  _reset_docker_world
  local id_20="t14-tmp-20-$$-$RANDOM"
  run_script \
    --execution-id "$id_20" --unit demo-unit \
    --artifact server="$IMG_V2" \
    --lock-key demo-lock3 --fencing-token tok-1 \
    --migrate server --migration-check "exit 1" --migration-run "exit 1"
  [[ "$SCRIPT_EXIT" -eq 20 ]] || { fail "expected exit 20 for migration-fail sub-case, got $SCRIPT_EXIT"; ok=1; }
  _assert_tmp_gone "$id_20" "20 (migration failed)" || ok=1

  # --- exit 30 (start failed) ---
  _reset_docker_world
  shim_force "start_fail_server"
  local id_30="t14-tmp-30-$$-$RANDOM"
  run_script \
    --execution-id "$id_30" --unit demo-unit \
    --artifact server="$IMG_V2" \
    --lock-key demo-lock4 --fencing-token tok-1
  [[ "$SCRIPT_EXIT" -eq 30 ]] || { fail "expected exit 30 for start-fail sub-case, got $SCRIPT_EXIT"; ok=1; }
  _assert_tmp_gone "$id_30" "30 (start failed)" || ok=1
  rm -f "$DOCKER_STATE_DIR/control/start_fail_server"

  # --- exit 40 (health failed) ---
  _reset_docker_world
  local id_40="t14-tmp-40-$$-$RANDOM"
  run_script \
    --execution-id "$id_40" --unit demo-unit \
    --artifact server="$IMG_V2" \
    --lock-key demo-lock5 --fencing-token tok-1 \
    --health server="exit 1"
  [[ "$SCRIPT_EXIT" -eq 40 ]] || { fail "expected exit 40 for health-fail sub-case, got $SCRIPT_EXIT"; ok=1; }
  _assert_tmp_gone "$id_40" "40 (health failed)" || ok=1

  # --- exit 50 (target busy) ---
  _reset_docker_world
  shim_pre_acquire_lock "demo-lock6" "someone-else" "fencing-x"
  local id_50="t14-tmp-50-$$-$RANDOM"
  run_script \
    --execution-id "$id_50" --unit demo-unit \
    --artifact server="$IMG_V2" \
    --lock-key demo-lock6 --fencing-token tok-1
  [[ "$SCRIPT_EXIT" -eq 50 ]] || { fail "expected exit 50 for busy sub-case, got $SCRIPT_EXIT"; ok=1; }
  _assert_tmp_gone "$id_50" "50 (target busy)" || ok=1

  return $ok
}

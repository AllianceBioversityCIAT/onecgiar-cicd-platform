#!/usr/bin/env bash
# FR-13 "second barrier on the target" scenario / FR-16 F18 / DD-22.
# GIVEN a deploy operation in progress on the unit
# WHEN another deploy is started on the same unit
# THEN the second one exits with 50, with no pull, migration, or swap
#
# NOTE (scope): this shim proves the SCRIPT reacts correctly to a busy lock
# (reported by the `flock` shim's mkdir-atomicity emulation). It does NOT
# prove real kernel-lock semantics under real concurrency -- that is
# DEFERRED to Gate C (T-33), on real Linux with real flock(2).
test_target_busy() {
  local ok=0

  shim_pre_acquire_lock "demo-lock" "other-execution-id" "other-fencing-token"

  run_script \
    --execution-id "t14-busy-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock \
    --fencing-token tok-1

  if [[ "$SCRIPT_EXIT" -ne 50 ]]; then
    fail "exit code: expected 50, got $SCRIPT_EXIT"; ok=1
  else
    pass "exit code 50"
  fi

  if [[ -s "$DOCKER_LOG" ]]; then
    fail "docker was invoked while the lock was busy (expected NO effects): $(cat "$DOCKER_LOG")"
    ok=1
  else
    pass "no docker invocation recorded (no pull, no migration, no swap)"
  fi

  local json; json="$(cicd_result_json)"
  if json_is_valid "$json"; then
    local status holder
    status="$(json_get "$json" "status")" || status="<missing>"
    holder="$(json_get "$json" "mutexHolder")" || holder="<missing>"
    if [[ "$status" == "TARGET_BUSY" ]]; then
      pass "CICD_RESULT reports status=TARGET_BUSY"
    else
      fail "CICD_RESULT status unexpected: $status"
      ok=1
    fi
    if [[ "$holder" == *"other-execution-id"* ]]; then
      pass "CICD_RESULT reports mutexHolder identifying the current holder"
    else
      fail "CICD_RESULT mutexHolder did not identify the holder: $holder"
      ok=1
    fi
  else
    fail "CICD_RESULT is not valid JSON: $json"
    ok=1
  fi

  return $ok
}

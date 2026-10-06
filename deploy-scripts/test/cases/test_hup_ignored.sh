#!/usr/bin/env bash
# design §5.3 / §6.4: "the script's critical section ignores the session
# hangup signal (HUP): an SSH cut does not interrupt a migration or a swap
# in progress."
#
# BEST-EFFORT only, as instructed: this Windows/Git-Bash/MSYS environment
# does not reliably reproduce POSIX signal-delivery semantics to background
# process trees the way a real Linux SSH session would. This test sends
# SIGHUP to the running script while it is inside a (slow, deliberately
# delayed) migration step and checks the run still completes successfully.
# If signal delivery is not usable in this environment at all, the test
# reports SKIPPED rather than a false FAIL -- real HUP-during-critical-
# section behavior on Linux is DEFERRED validation (Gate C, T-33).
test_hup_ignored() {
  local ok=0

  if ! command -v kill >/dev/null 2>&1; then
    TEST_SKIPPED=1
    skip "no 'kill' available in this environment (informational only)"
    return 0
  fi

  shim_set_running "server" "$IMG_V1"

  local out="$SANDBOX_DIR/hup_stdout" err="$SANDBOX_DIR/hup_stderr"
  bash "$SCRIPT_UNDER_TEST" \
    --execution-id "t14-hup-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --migrate server \
    --migration-check "exit 1" \
    --migration-run "sleep 1; exit 0" \
    > "$out" 2> "$err" &
  local script_pid=$!

  sleep 0.3
  if ! kill -HUP "$script_pid" 2>/dev/null; then
    TEST_SKIPPED=1
    skip "could not signal the background script in this environment (informational only)"
    wait "$script_pid" 2>/dev/null || true
    return 0
  fi

  local wait_rc=0
  wait "$script_pid" 2>/dev/null || wait_rc=$?

  if [[ "$wait_rc" -eq 0 ]]; then
    pass "script survived SIGHUP during the critical section and completed successfully"
  else
    fail "script did not complete successfully after SIGHUP (exit $wait_rc); HUP may not have been ignored -- note this environment cannot fully validate real session-hangup semantics (Gate C, T-33)"
    ok=1
  fi

  return $ok
}

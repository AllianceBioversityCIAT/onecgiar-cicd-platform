#!/usr/bin/env bash
# requirements FR-13 "target's AWS credentials" + FR-17 "redaction":
# the runtime secret value must never appear in stdout or stderr, and the
# fetch must exclude the leftover ~/.aws/credentials file (asserted by the
# fake aws shim itself, which fails loudly if
# AWS_SHARED_CREDENTIALS_FILE != /dev/null).
#
# Also checks the materialized secret file's permission bits (FR-13
# "temporary configuration": 0600), via a side-channel the docker shim
# records while the file still exists (the real script deletes it on exit).
test_secret_not_leaked() {
  local ok=0
  local sentinel="SUPER_SECRET_DO_NOT_LEAK_12345"
  # Neutral, generic reference -- never a real project identifier (DD-23).
  local secret_ref="example-unit/server-runtime-secret"

  export FAKE_SECRET_VALUE="$sentinel"

  run_script \
    --execution-id "t14-secret-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --runtime-secret "server=$secret_ref"

  unset FAKE_SECRET_VALUE

  if [[ "$SCRIPT_EXIT" -ne 0 ]]; then
    fail "expected success (exit 0), got $SCRIPT_EXIT. stderr: $(cat "$STDERR_FILE")"
    ok=1
  else
    pass "exit code 0"
  fi

  if grep -qF -- "$sentinel" "$STDOUT_FILE"; then
    fail "secret value leaked into stdout"
    ok=1
  else
    pass "secret value not present in stdout"
  fi

  if grep -qF -- "$sentinel" "$STDERR_FILE"; then
    fail "secret value leaked into stderr"
    ok=1
  else
    pass "secret value not present in stderr"
  fi

  if grep -qF -- "$sentinel" "$DOCKER_LOG"; then
    fail "secret value leaked into the docker invocation log"
    ok=1
  else
    pass "secret value not present in the docker invocation log"
  fi

  # The fake aws shim exits 9 and prints a complaint if it ever sees a
  # non-/dev/null AWS_SHARED_CREDENTIALS_FILE; a clean exit 0 above already
  # proves the leftover credentials file was excluded, but check explicitly.
  if grep -q "expected AWS_SHARED_CREDENTIALS_FILE" "$STDERR_FILE"; then
    fail "the script invoked aws without excluding ~/.aws/credentials"
    ok=1
  else
    pass "aws was invoked with AWS_SHARED_CREDENTIALS_FILE=/dev/null (leftover credentials excluded)"
  fi

  # 0600 permission check, via the docker shim's recording of the
  # --env-file path's mode at the moment it was used (while the file still
  # existed; the real script deletes it on exit). This machine's filesystem
  # (Windows + Git Bash/MSYS) does not reliably reflect POSIX permission
  # bits -- self-probe first.
  #
  # IMPORTANT: this is skip_assertion(), NOT TEST_SKIPPED/skip(). The leak
  # assertions above are the actual security gate (FR-13/DD-23) and MUST
  # still report PASS/FAIL on their own merits regardless of what happens
  # here -- marking the WHOLE test skipped would hide a real secret leak
  # behind an unrelated, environment-only permission-bit limitation.
  local probe_file="$SANDBOX_DIR/perm_probe"
  : > "$probe_file"
  chmod 600 "$probe_file" 2>/dev/null || true
  local probe_mode
  probe_mode="$(stat -c '%a' "$probe_file" 2>/dev/null || echo '')"
  rm -f "$probe_file"

  if [[ "$probe_mode" != "600" ]]; then
    skip_assertion "0600 permission check: this environment's filesystem does not reflect POSIX permission bits (chmod 600 reports '$probe_mode') -- deferred to Gate C (T-33)"
  else
    local recorded_mode
    recorded_mode="$(cat "$DOCKER_STATE_DIR/control/last_env_file_mode" 2>/dev/null || echo '')"
    if [[ "$recorded_mode" == "600" ]]; then
      pass "runtime secret file was 0600 when used by docker (--env-file)"
    else
      fail "runtime secret file mode was '$recorded_mode', expected 600"
      ok=1
    fi
  fi

  return $ok
}

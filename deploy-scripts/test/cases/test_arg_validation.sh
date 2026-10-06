#!/usr/bin/env bash
# Hardening requested on review: --execution-id, --lock-key and container
# names are validated against a strict charset (letters, digits, '.', '_',
# '-') and rejected BEFORE any effect -- in particular, path traversal via
# '..' must be rejected (these identifiers become part of filesystem paths:
# the lock file, the per-execution tmp dir, temp-container names).
test_arg_validation() {
  local ok=0

  # --- case 1: path traversal in --execution-id ---
  run_script \
    --execution-id "../../etc/passwd" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock \
    --fencing-token tok-1

  if [[ "$SCRIPT_EXIT" -eq 2 ]]; then
    pass "case 1 (path traversal in --execution-id): rejected with exit 2"
  else
    fail "case 1: expected exit 2, got $SCRIPT_EXIT"
    ok=1
  fi
  if [[ -s "$DOCKER_LOG" ]]; then
    fail "case 1: docker was invoked despite the invalid --execution-id (expected NO effects): $(cat "$DOCKER_LOG")"
    ok=1
  else
    pass "case 1: no docker invocation recorded"
  fi
  if grep -q '^CICD_RESULT ' "$STDOUT_FILE"; then
    fail "case 1: a CICD_RESULT line was printed for a usage error (it must not be -- this is not a deploy outcome)"
    ok=1
  else
    pass "case 1: no CICD_RESULT line printed for the usage error"
  fi

  # --- case 2: path traversal in --lock-key ---
  : > "$DOCKER_LOG"
  run_script \
    --execution-id "t14-argval-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key "../../var/lock/cicd/other.lock" \
    --fencing-token tok-1

  if [[ "$SCRIPT_EXIT" -eq 2 ]]; then
    pass "case 2 (path traversal in --lock-key): rejected with exit 2"
  else
    fail "case 2: expected exit 2, got $SCRIPT_EXIT"
    ok=1
  fi
  if [[ -s "$DOCKER_LOG" ]]; then
    fail "case 2: docker was invoked despite the invalid --lock-key"
    ok=1
  else
    pass "case 2: no docker invocation recorded"
  fi

  # --- case 3: disallowed character ('/') in a container name ---
  : > "$DOCKER_LOG"
  run_script \
    --execution-id "t14-argval-$$-$RANDOM" \
    --unit demo-unit \
    --artifact "server/evil=$IMG_V2" \
    --lock-key demo-lock \
    --fencing-token tok-1

  if [[ "$SCRIPT_EXIT" -eq 2 ]]; then
    pass "case 3 (disallowed '/' in a container name): rejected with exit 2"
  else
    fail "case 3: expected exit 2, got $SCRIPT_EXIT"
    ok=1
  fi
  if [[ -s "$DOCKER_LOG" ]]; then
    fail "case 3: docker was invoked despite the invalid container name"
    ok=1
  else
    pass "case 3: no docker invocation recorded"
  fi

  # --- case 4 (sanity): a valid, ordinary set of identifiers is accepted ---
  : > "$DOCKER_LOG"
  run_script \
    --execution-id "t14-argval-ok.1_2-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key "demo-lock.unit_1" \
    --fencing-token tok-1

  if [[ "$SCRIPT_EXIT" -eq 0 ]]; then
    pass "case 4 (valid identifiers with '.', '_', '-'): accepted, exit 0"
  else
    fail "case 4: expected exit 0 for valid identifiers, got $SCRIPT_EXIT. stderr: $(cat "$STDERR_FILE")"
    ok=1
  fi

  return $ok
}

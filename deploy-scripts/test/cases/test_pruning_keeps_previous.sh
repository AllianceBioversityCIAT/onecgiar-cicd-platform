#!/usr/bin/env bash
# FR-13 "previous image" scenario.
# GIVEN any outcome
# THEN N's image remains available on the host
# BUT it must NOT run cleanup of the previous image
# (and must NOT be a host-wide prune: only this repo's stale tags are
# removed, matching DD-11/proposal C8's "no unscoped docker prune" concern)
test_pruning_keeps_previous() {
  local ok=0

  shim_set_running "server" "$IMG_V1"
  shim_seed_image "$IMG_V0"
  shim_seed_image "$IMG_V1"

  run_script \
    --execution-id "t14-prune-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock \
    --fencing-token tok-1

  if [[ "$SCRIPT_EXIT" -ne 0 ]]; then
    fail "exit code: expected 0, got $SCRIPT_EXIT"; ok=1
  else
    pass "exit code 0"
  fi

  if image_is_present "$IMG_V1"; then
    pass "previous image ($IMG_V1) was never removed"
  else
    fail "previous image ($IMG_V1) was removed -- MUST always be kept"
    ok=1
  fi

  if image_is_present "$IMG_V2"; then
    pass "newly deployed image ($IMG_V2) is present"
  else
    fail "newly deployed image ($IMG_V2) is missing"
    ok=1
  fi

  if image_is_present "$IMG_V0"; then
    fail "stale older image ($IMG_V0) was NOT pruned"
    ok=1
  else
    pass "stale older image ($IMG_V0) was pruned"
  fi

  if docker_log_contains "RMI $IMG_V1"; then
    fail "an RMI of the previous image ($IMG_V1) was recorded"
    ok=1
  else
    pass "no RMI of the previous image was recorded"
  fi

  return $ok
}

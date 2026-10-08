#!/usr/bin/env bash
# design §6.5 (task R-9a): there is no --previous hint. The authoritative
# source for "previous" is the image the container is actually running when
# the script starts; when no container exists there is no previous image and
# none is invented.
test_previous_hint() {
  local ok=0

  # --- case A: container does not exist -> no previous image ---
  run_script \
    --execution-id "t14-hintA-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock-a \
    --fencing-token tok-1

  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "case A: expected exit 0, got $SCRIPT_EXIT"; ok=1; }
  local json_a; json_a="$(cicd_result_json)"
  local previous_a; previous_a="$(json_get "$json_a" "previousImages.server")" || previous_a="<absent>"
  if [[ -z "$previous_a" || "$previous_a" == "<absent>" ]]; then
    pass "case A (no running container): no previous image reported (none invented)"
  else
    fail "case A: expected no previous image, got $previous_a"
    ok=1
  fi

  # --- case B: container IS running a different image -> that image is the previous one ---
  shim_set_running "server" "$IMG_V1"
  run_script \
    --execution-id "t14-hintB-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock-b \
    --fencing-token tok-1

  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "case B: expected exit 0, got $SCRIPT_EXIT"; ok=1; }
  local json_b; json_b="$(cicd_result_json)"
  local previous_b; previous_b="$(json_get "$json_b" "previousImages.server")" || previous_b="<missing>"
  if [[ "$previous_b" == "$IMG_V1" ]]; then
    pass "case B (running container present): the ACTUAL running image ($IMG_V1) is the previous image"
  else
    fail "case B: expected previousImages.server=$IMG_V1 (actual running image), got $previous_b"
    ok=1
  fi

  return $ok
}

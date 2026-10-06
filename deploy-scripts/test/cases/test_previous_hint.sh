#!/usr/bin/env bash
# design §6.4: "--previous ... The authoritative source for restoring is the
# image the container is actually running on the host when the script
# starts; the hint is used only if the container doesn't exist."
test_previous_hint() {
  local ok=0

  # --- case A: container does not exist -> hint IS used ---
  run_script \
    --execution-id "t14-hintA-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --previous server=$IMG_V0 \
    --lock-key demo-lock-a \
    --fencing-token tok-1

  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "case A: expected exit 0, got $SCRIPT_EXIT"; ok=1; }
  local json_a; json_a="$(cicd_result_json)"
  local previous_a; previous_a="$(json_get "$json_a" "previousImages.server")" || previous_a="<missing>"
  if [[ "$previous_a" == "$IMG_V0" ]]; then
    pass "case A (no running container): --previous hint ($IMG_V0) was used"
  else
    fail "case A: expected previousImages.server=$IMG_V0 (the hint), got $previous_a"
    ok=1
  fi

  # --- case B: container IS running a DIFFERENT image -> hint is IGNORED ---
  shim_set_running "server" "$IMG_V1"
  run_script \
    --execution-id "t14-hintB-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --previous server=$IMG_V0 \
    --lock-key demo-lock-b \
    --fencing-token tok-1

  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "case B: expected exit 0, got $SCRIPT_EXIT"; ok=1; }
  local json_b; json_b="$(cicd_result_json)"
  local previous_b; previous_b="$(json_get "$json_b" "previousImages.server")" || previous_b="<missing>"
  if [[ "$previous_b" == "$IMG_V1" ]]; then
    pass "case B (running container present): the ACTUAL running image ($IMG_V1) was used, hint ($IMG_V0) ignored"
  else
    fail "case B: expected previousImages.server=$IMG_V1 (actual running image, not the hint), got $previous_b"
    ok=1
  fi

  return $ok
}

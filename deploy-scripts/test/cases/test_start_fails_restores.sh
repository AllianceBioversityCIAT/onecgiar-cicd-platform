#!/usr/bin/env bash
# FR-13 exit-code table: code 30 (start failed) -> "previous restored".
# Unlike test_temp_env_cleanup's code-30 sub-case (no running container, just
# proving tmp-dir cleanup), this test seeds an ACTUAL running previous
# container and asserts it is running AGAIN afterwards -- the shim's
# "start_fail" control is consumed on first use, so the swap's start attempt
# (new image) fails but the subsequent restore attempt (old image) succeeds,
# exactly like a transient one-off start error would behave for real.
test_start_fails_restores() {
  local ok=0

  shim_set_running "server" "$IMG_V1"
  shim_force "start_fail_server"

  run_script \
    --execution-id "t14-startfail-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock \
    --fencing-token tok-1

  if [[ "$SCRIPT_EXIT" -ne 30 ]]; then
    fail "exit code: expected 30, got $SCRIPT_EXIT"; ok=1
  else
    pass "exit code 30"
  fi

  if ! container_is_running "server"; then
    fail "container 'server' is not present after rollback (it must be restored)"
    ok=1
  elif [[ "$(container_running_image "server")" != "$IMG_V1" ]]; then
    fail "container 'server' running '$(container_running_image "server")', expected restored '$IMG_V1'"
    ok=1
  else
    pass "container 'server' is running again on the previous image ($IMG_V1) after the failed start"
  fi

  local json; json="$(cicd_result_json)"
  if json_is_valid "$json"; then
    local status; status="$(json_get "$json" "status")" || status="<missing>"
    if [[ "$status" == "START_FAILED" ]]; then
      pass "CICD_RESULT reports status=START_FAILED"
    else
      fail "CICD_RESULT status unexpected: $status"
      ok=1
    fi
  else
    fail "CICD_RESULT is not valid JSON: $json"
    ok=1
  fi

  return $ok
}

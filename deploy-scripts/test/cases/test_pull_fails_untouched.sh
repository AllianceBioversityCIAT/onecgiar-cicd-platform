#!/usr/bin/env bash
# FR-13 exit-code table: code 10 (login/pull failed) -> "previous intact".
# Disqualifier guard: checking only the exit code doesn't prove availability
# -- this test inspects the shim's container STATE, and that no stop/rm was
# ever recorded for the running container.
test_pull_fails_untouched() {
  local ok=0

  shim_set_running "server" "$IMG_V1"
  shim_force "pull_fail"

  run_script \
    --execution-id "t14-pullfail-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock \
    --fencing-token tok-1

  if [[ "$SCRIPT_EXIT" -ne 10 ]]; then
    fail "exit code: expected 10, got $SCRIPT_EXIT"; ok=1
  else
    pass "exit code 10"
  fi

  if ! container_is_running "server"; then
    fail "container 'server' is no longer present in docker state (it must NOT be touched on a pull failure)"
    ok=1
  elif [[ "$(container_running_image "server")" != "$IMG_V1" ]]; then
    fail "container 'server' running '$(container_running_image "server")', expected it to keep serving '$IMG_V1' untouched"
    ok=1
  else
    pass "container 'server' keeps serving $IMG_V1, untouched"
  fi

  if docker_log_contains "docker stop server" || docker_log_contains "docker rm server"; then
    fail "a stop/rm of the container was recorded despite the pull having failed before any swap"
    ok=1
  else
    pass "no stop/rm of the container was recorded"
  fi

  local json; json="$(cicd_result_json)"
  if json_is_valid "$json"; then
    local status; status="$(json_get "$json" "status")" || status="<missing>"
    if [[ "$status" == "PULL_FAILED" ]]; then
      pass "CICD_RESULT reports status=PULL_FAILED"
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

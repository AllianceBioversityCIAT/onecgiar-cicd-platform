#!/usr/bin/env bash
# FR-13 "failed health check" scenario / FR-16 F13.
# GIVEN N+1 started but does not pass the health check
# THEN the script restores N and exits with 40
test_health_fails() {
  local ok=0

  shim_set_running "server" "$IMG_V1"

  run_script \
    --execution-id "t14-healthfail-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --previous server=$IMG_V1 \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --health server="exit 1"

  if [[ "$SCRIPT_EXIT" -ne 40 ]]; then
    fail "exit code: expected 40, got $SCRIPT_EXIT"; ok=1
  else
    pass "exit code 40"
  fi

  if ! container_is_running "server"; then
    fail "container 'server' is not present after rollback (it must be restored)"
    ok=1
  elif [[ "$(container_running_image "server")" != "$IMG_V1" ]]; then
    fail "container 'server' running '$(container_running_image "server")', expected restored '$IMG_V1'"
    ok=1
  else
    pass "previous image ($IMG_V1) restored after failed health check"
  fi

  # Disqualifier guard: the shim's container STATE (not merely the exit
  # code) is what proves availability was restored -- inspected above.

  local json; json="$(cicd_result_json)"
  if json_is_valid "$json"; then
    local status healthy
    status="$(json_get "$json" "status")" || status="<missing>"
    healthy="$(json_get "$json" "healthy")" || healthy="<missing>"
    if [[ "$status" == "HEALTH_FAILED" && "$healthy" == "false" ]]; then
      pass "CICD_RESULT reports status=HEALTH_FAILED, healthy=false"
    else
      fail "CICD_RESULT status/healthy unexpected: status=$status healthy=$healthy"
      ok=1
    fi
  else
    fail "CICD_RESULT is not valid JSON: $json"
    ok=1
  fi

  return $ok
}

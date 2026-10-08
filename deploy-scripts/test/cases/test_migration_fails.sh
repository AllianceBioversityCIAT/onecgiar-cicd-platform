#!/usr/bin/env bash
# FR-13 "failed migration" scenario / FR-16 F11.
# GIVEN version N in service and the migration of N+1 fails
# WHEN the script runs
# THEN it exits with 20 and N keeps serving
# BUT it must NOT stop or remove N's containers
test_migration_fails() {
  local ok=0

  shim_set_running "server" "$IMG_V1"

  run_script \
    --execution-id "t14-migfail-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --migrate server \
    --migration-check "exit 1" \
    --migration-run "exit 1"

  if [[ "$SCRIPT_EXIT" -ne 20 ]]; then
    fail "exit code: expected 20, got $SCRIPT_EXIT"; ok=1
  else
    pass "exit code 20"
  fi

  if ! container_is_running "server"; then
    fail "old container 'server' is no longer present in docker state (it must NOT be stopped/removed)"
    ok=1
  elif [[ "$(container_running_image "server")" != "$IMG_V1" ]]; then
    fail "old container image changed to '$(container_running_image "server")', expected it to keep serving '$IMG_V1'"
    ok=1
  else
    pass "old container 'server' keeps serving $IMG_V1, untouched"
  fi

  if docker_log_contains "docker stop server" || docker_log_contains "RMI $IMG_V1"; then
    fail "a stop/rm/rmi of the old container or its image was recorded; migration-before-swap ordering is broken"
    ok=1
  else
    pass "no stop/rm/rmi of the old container was recorded"
  fi

  local json; json="$(cicd_result_json)"
  if json_is_valid "$json"; then
    local status migrations
    status="$(json_get "$json" "status")" || status="<missing>"
    migrations="$(json_get "$json" "migrations")" || migrations="<missing>"
    if [[ "$status" == "MIGRATION_FAILED" && "$migrations" == "FAILED" ]]; then
      pass "CICD_RESULT reports status=MIGRATION_FAILED, migrations=FAILED"
    else
      fail "CICD_RESULT status/migrations unexpected: status=$status migrations=$migrations"
      ok=1
    fi
  else
    fail "CICD_RESULT is not valid JSON: $json"
    ok=1
  fi

  return $ok
}

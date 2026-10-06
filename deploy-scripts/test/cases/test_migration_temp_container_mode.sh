#!/usr/bin/env bash
# DD-11 / P-5 fallback variant (--migration-mode temp-container): when the
# image cannot migrate in ephemeral one-shot mode, the new image is started
# under a TEMPORARY name instead, migrated via `docker exec`, then removed --
# the old container is never touched in this branch, preserving
# "migrate before stopping old".
#
# GIVEN version N in service and the migration of N+1 fails (temp-container
#       variant)
# THEN it exits with 20, N keeps serving untouched, AND the temporary
#      migration container is cleaned up (not left running/registered).
test_migration_temp_container_mode() {
  local ok=0

  shim_set_running "server" "$IMG_V1"
  local execution_id="t14-tempmig-$$-$RANDOM"
  local temp_name="server-migrating-${execution_id}"

  run_script \
    --execution-id "$execution_id" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --previous server=$IMG_V1 \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --migrate server \
    --migration-check "exit 1" \
    --migration-run "exit 1" \
    --migration-mode temp-container

  if [[ "$SCRIPT_EXIT" -ne 20 ]]; then
    fail "exit code: expected 20, got $SCRIPT_EXIT"; ok=1
  else
    pass "exit code 20"
  fi

  if ! container_is_running "server"; then
    fail "old container 'server' is no longer present (it must NOT be stopped/removed)"
    ok=1
  elif [[ "$(container_running_image "server")" != "$IMG_V1" ]]; then
    fail "old container image changed to '$(container_running_image "server")', expected it to keep serving '$IMG_V1'"
    ok=1
  else
    pass "old container 'server' keeps serving $IMG_V1, untouched"
  fi

  if container_is_running "$temp_name"; then
    fail "temporary migration container '$temp_name' was left behind (must be stopped/removed regardless of outcome)"
    ok=1
  else
    pass "temporary migration container '$temp_name' was cleaned up"
  fi

  # Exact-line match (NOT substring): "docker stop server" is itself a
  # prefix of the expected "docker stop server-migrating-...", so a
  # substring check would false-positive on the temp container's own
  # legitimate stop/rm.
  if grep -qxF "docker stop server" "$DOCKER_LOG" || grep -qxF "docker rm server" "$DOCKER_LOG"; then
    fail "a stop/rm of the OLD container ('server') was recorded; the temp-container variant must never touch it"
    ok=1
  else
    pass "no stop/rm of the old container 'server' was recorded"
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

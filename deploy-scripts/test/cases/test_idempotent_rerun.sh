#!/usr/bin/env bash
# FR-13 "previous image" + "script idempotency" scenarios, together:
# GIVEN the script run twice with the same images (v1 -> v2, then v2 -> v2
#       again, with the SAME --previous hint the caller would still supply)
# THEN the second result is equivalent to the first (no second migration,
#      deployedImages/previousImages unchanged) AND N's image (v1) remains
#      available on the host in BOTH outcomes -- a re-run's pruning must not
#      delete it just because the "previous" slot now looks like "current".
test_idempotent_rerun() {
  local ok=0

  shim_set_running "server" "$IMG_V1"
  shim_seed_image "$IMG_V1"

  # --- first run: v1 -> v2 ---
  run_script \
    --execution-id "t14-idemp-1-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --previous server=$IMG_V1 \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --migrate server --migration-check "exit 0"

  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "first run: expected exit 0, got $SCRIPT_EXIT"; ok=1; }
  local json_1; json_1="$(cicd_result_json)"
  local deployed_1 previous_1 migrations_1
  deployed_1="$(json_get "$json_1" "deployedImages.server")" || deployed_1="<missing>"
  previous_1="$(json_get "$json_1" "previousImages.server")" || previous_1="<missing>"
  migrations_1="$(json_get "$json_1" "migrations")" || migrations_1="<missing>"

  if [[ "$deployed_1" == "$IMG_V2" && "$previous_1" == "$IMG_V1" ]]; then
    pass "first run: deployedImages.server=$IMG_V2, previousImages.server=$IMG_V1"
  else
    fail "first run: unexpected deployed=$deployed_1 previous=$previous_1"
    ok=1
  fi

  if image_is_present "$IMG_V1"; then
    pass "first run: previous image ($IMG_V1) still present"
  else
    fail "first run: previous image ($IMG_V1) was removed"
    ok=1
  fi

  local docker_log_lines_after_first
  docker_log_lines_after_first="$(wc -l < "$DOCKER_LOG")"

  # --- second run: SAME args (caller still passes --previous server=$IMG_V1,
  #     exactly as a real caller would, since DynamoDB's view of "previous"
  #     does not change just because this run turns out to be a no-op) ---
  run_script \
    --execution-id "t14-idemp-2-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --previous server=$IMG_V1 \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --migrate server --migration-check "exit 0"

  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "second run: expected exit 0, got $SCRIPT_EXIT"; ok=1; }

  local json_2; json_2="$(cicd_result_json)"
  local deployed_2 previous_2 migrations_2
  deployed_2="$(json_get "$json_2" "deployedImages.server")" || deployed_2="<missing>"
  previous_2="$(json_get "$json_2" "previousImages.server")" || previous_2="<missing>"
  migrations_2="$(json_get "$json_2" "migrations")" || migrations_2="<missing>"

  if [[ "$deployed_2" == "$deployed_1" && "$previous_2" == "$previous_1" ]]; then
    pass "second run: result is equivalent to the first (deployedImages/previousImages unchanged)"
  else
    fail "second run: NOT equivalent to the first (first: deployed=$deployed_1 previous=$previous_1 / second: deployed=$deployed_2 previous=$previous_2)"
    ok=1
  fi

  if image_is_present "$IMG_V1"; then
    pass "second (re-)run: previous image ($IMG_V1) STILL present (not pruned by the no-op re-run)"
  else
    fail "second (re-)run: previous image ($IMG_V1) was deleted by pruning -- this is the bug this test guards against"
    ok=1
  fi

  # No second migration with effects: the migration-check command should not
  # have run again on the second invocation. We cannot directly observe "did
  # not run" from the docker log alone (a run would just add more entries),
  # so instead assert no NEW migration-check invocation was logged: compare
  # that no `sh -c exit 0` entry was appended after the first run's tail,
  # other than what pull/health would add (none configured here beyond the
  # migrate step), by checking migrations status stays NONE on both runs and
  # the container was never stopped a second time (idempotent swap skip).
  if [[ "$migrations_1" == "NONE" && "$migrations_2" == "NONE" ]]; then
    pass "migrations=NONE on both runs (check said 'up to date' both times, run-cmd never needed)"
  else
    fail "unexpected migrations status: first=$migrations_1 second=$migrations_2"
    ok=1
  fi

  if docker_log_contains "docker stop server" ; then
    local stop_count
    stop_count="$(grep -c -- '^docker stop server$' "$DOCKER_LOG" || true)"
    if [[ "$stop_count" -le 1 ]]; then
      pass "container 'server' was stopped at most once total (second run skipped the swap, idempotent)"
    else
      fail "container 'server' was stopped $stop_count times; expected the second (no-op) run to skip the swap entirely"
      ok=1
    fi
  else
    pass "container 'server' was never stopped (swap skipped both times is also acceptable if nothing changed)"
  fi

  return $ok
}

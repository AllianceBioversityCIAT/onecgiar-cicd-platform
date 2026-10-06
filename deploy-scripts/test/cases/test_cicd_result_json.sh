#!/usr/bin/env bash
# design §6.4: "as the last stdout line, CICD_RESULT followed by a JSON with
# status, deployedImages, previousImages, migrations (APPLIED|NONE|FAILED),
# healthy, mutexHolder (the latter only with 50)".
test_cicd_result_json() {
  local ok=0

  shim_set_running "server" "$IMG_V1"

  run_script \
    --execution-id "t14-json-$$-$RANDOM" \
    --unit demo-unit \
    --artifact server=$IMG_V2 \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --migrate server --migration-check "exit 0" \
    --health server="exit 0"

  if [[ "$SCRIPT_EXIT" -ne 0 ]]; then
    fail "expected a clean success run (exit 0), got $SCRIPT_EXIT. stderr: $(cat "$STDERR_FILE")"
    return 1
  fi

  local last_line; last_line="$(last_stdout_line)"
  if [[ "$last_line" == CICD_RESULT\ * ]]; then
    pass "last stdout line starts with 'CICD_RESULT '"
  else
    fail "last stdout line is not a CICD_RESULT line: '$last_line'"
    ok=1
  fi

  local n_cicd_lines
  n_cicd_lines="$(grep -c '^CICD_RESULT ' "$STDOUT_FILE" || true)"
  if [[ "$n_cicd_lines" -eq 1 ]]; then
    pass "exactly one CICD_RESULT line was printed"
  else
    fail "expected exactly one CICD_RESULT line, found $n_cicd_lines"
    ok=1
  fi

  local json; json="$(cicd_result_json)"
  if json_is_valid "$json"; then
    pass "CICD_RESULT payload is valid JSON"
  else
    fail "CICD_RESULT payload is not valid JSON: $json"
    ok=1
    return $ok
  fi

  local status migrations healthy deployed previous
  status="$(json_get "$json" "status")" || status="<missing>"
  migrations="$(json_get "$json" "migrations")" || migrations="<missing>"
  healthy="$(json_get "$json" "healthy")" || healthy="<missing>"
  deployed="$(json_get "$json" "deployedImages.server")" || deployed="<missing>"
  previous="$(json_get "$json" "previousImages.server")" || previous="<missing>"

  if [[ "$status" == "SUCCESS" ]]; then pass "status=SUCCESS"; else fail "status=$status"; ok=1; fi
  if [[ "$migrations" == "NONE" ]]; then pass "migrations=NONE (check command returned 0 -> no pending migrations)"; else fail "migrations=$migrations"; ok=1; fi
  if [[ "$healthy" == "true" ]]; then pass "healthy=true"; else fail "healthy=$healthy"; ok=1; fi
  if [[ "$deployed" == "$IMG_V2" ]]; then pass "deployedImages.server=$IMG_V2"; else fail "deployedImages.server=$deployed"; ok=1; fi
  if [[ "$previous" == "$IMG_V1" ]]; then pass "previousImages.server=$IMG_V1"; else fail "previousImages.server=$previous"; ok=1; fi

  return $ok
}

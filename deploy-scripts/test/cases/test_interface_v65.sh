#!/usr/bin/env bash
# design §6.5 (task R-9a): the script accepts EXACTLY the argument vector the
# Executor sends (deployPlanOf in executor/src/application/deploy-coordinator):
#   --target-id <id> --execution-id <id> --fencing-token <digits>
#   --commit-sha <40-hex> --artifact <unit>=sha256:<64-hex> (repeatable)
# and maps each unit to its own trusted image repository and container through
# the target-side configuration file <CICD_TARGET_CONFIG_DIR>/<target-id>.conf.
# Anything else is a usage error: exit 2, no CICD_RESULT, no effect at all.

V65_TARGET="example-app-dev"
V65_DIGEST_SERVER="sha256:$(printf '2%.0s' {1..64})"
V65_DIGEST_CLIENT="sha256:$(printf '3%.0s' {1..64})"
V65_REPO_SERVER="registry.example.invalid/team/app-server"
V65_REPO_CLIENT="registry.example.invalid/team/app-client"

v65_config() {
  write_target_config "$V65_TARGET" \
    "# example-app DEV (comments and blank lines are ignored)" \
    "" \
    "unit.server.repository=$V65_REPO_SERVER" \
    "unit.server.container=example-app-server" \
    "unit.server.port=8080:3000" \
    "unit.client.repository=$V65_REPO_CLIENT" \
    "unit.client.container=example-app-client"
}

# The vector deployPlanOf builds: units sorted, one --artifact per unit.
v65_vector() {
  printf '%s\n' --target-id "$V65_TARGET" --execution-id "example-app-dev-7" --fencing-token 7 \
    --commit-sha "$TEST_COMMIT_SHA" \
    --artifact "client=$V65_DIGEST_CLIENT" --artifact "server=$V65_DIGEST_SERVER"
}

run_v65() {
  local -a base=()
  mapfile -t base < <(v65_vector)
  run_raw "${base[@]}" "$@"
}

# The same vector with the extra arguments placed FIRST, so a parser that skipped
# an unknown flag would still reach a complete, valid vector and deploy.
run_v65_prefixed() {
  local -a base=()
  mapfile -t base < <(v65_vector)
  run_raw "$@" "${base[@]}"
}

# A single-unit vector (server only): each configuration case then fails only
# because of the configuration defect it states, never because a unit is missing.
run_v65_server_only() {
  run_raw --target-id "$V65_TARGET" --execution-id "example-app-dev-8" --fencing-token 8 \
    --commit-sha "$TEST_COMMIT_SHA" --artifact "server=$V65_DIGEST_SERVER"
}

test_v65_executor_vector_deploys() {
  local ok=0
  v65_config
  run_v65
  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "expected exit 0, got $SCRIPT_EXIT; stderr: $(cat "$STDERR_FILE")"; ok=1; }
  local ref
  for ref in "$V65_REPO_SERVER@$V65_DIGEST_SERVER" "$V65_REPO_CLIENT@$V65_DIGEST_CLIENT"; do
    if grep -qFx -- "docker pull $ref" "$DOCKER_LOG"; then
      pass "pulled by digest from the configured repository: $ref"
    else
      fail "missing 'docker pull $ref'; docker log: $(cat "$DOCKER_LOG")"; ok=1
    fi
  done
  assert_eq "$V65_REPO_SERVER@$V65_DIGEST_SERVER" "$(container_running_image example-app-server)" "configured container 'example-app-server' runs the server digest" || ok=1
  assert_eq "$V65_REPO_CLIENT@$V65_DIGEST_CLIENT" "$(container_running_image example-app-client)" "configured container 'example-app-client' runs the client digest" || ok=1
  if grep -q -- "-p 8080:3000" "$DOCKER_LOG"; then pass "configured port published"; else fail "configured port not used: $(cat "$DOCKER_LOG")"; ok=1; fi
  local json; json="$(cicd_result_json)"
  if json_is_valid "$json"; then
    assert_eq "SUCCESS" "$(json_get "$json" status)" "CICD_RESULT status=SUCCESS" || ok=1
    assert_eq "$V65_REPO_SERVER@$V65_DIGEST_SERVER" "$(json_get "$json" deployedImages.example-app-server)" "deployedImages keyed by the configured container" || ok=1
  else
    fail "CICD_RESULT is not valid JSON: $json"; ok=1
  fi
  local lock_file="$CICD_LOCK_DIR/${V65_TARGET}.lock"
  if grep -qx "targetId=$V65_TARGET" "$lock_file" && grep -qx "fencingToken=7" "$lock_file" && grep -qx "commitSha=$TEST_COMMIT_SHA" "$lock_file"; then
    pass "the target mutex (keyed by the target id) records targetId, fencingToken and commitSha"
  else
    fail "lock diagnostics incomplete: $(cat "$lock_file" 2>/dev/null)"; ok=1
  fi
  return $ok
}

test_v65_removed_flags_rejected() {
  local ok=0 flag
  v65_config
  # Control: the plain vector deploys with this configuration.
  run_v65
  assert_eq "0" "$SCRIPT_EXIT" "control: the valid vector deploys" || ok=1
  for flag in "--unit demo" "--lock-key demo" "--port server=1:1" "--health server=true" "--previous server=x" \
              "--runtime-secret server=ref" "--migrate server" "--migration-mode ephemeral" "--image server=x"; do
    : > "$DOCKER_LOG"; : > "$AWS_FAKE_LOG"; rm -rf "${CICD_LOCK_DIR:?}"/*
    # shellcheck disable=SC2086
    run_v65_prefixed $flag
    assert_no_effect "removed flag ${flag%% *}" || ok=1
  done
  return $ok
}

test_v65_bad_arguments_rejected() {
  local ok=0 label
  v65_config
  # Control: the same configuration accepts the full valid vector.
  run_v65
  assert_eq "0" "$SCRIPT_EXIT" "control: the valid vector deploys with this configuration" || ok=1
  rm -rf "${CICD_LOCK_DIR:?}"/*
  local good_sha="$TEST_COMMIT_SHA" d="$V65_DIGEST_SERVER"
  local -a cases=(
    "missing --target-id|--execution-id e1 --fencing-token 7 --commit-sha $good_sha --artifact server=$d"
    "missing --execution-id|--target-id $V65_TARGET --fencing-token 7 --commit-sha $good_sha --artifact server=$d"
    "missing --fencing-token|--target-id $V65_TARGET --execution-id e1 --commit-sha $good_sha --artifact server=$d"
    "missing --commit-sha|--target-id $V65_TARGET --execution-id e1 --fencing-token 7 --artifact server=$d"
    "no --artifact|--target-id $V65_TARGET --execution-id e1 --fencing-token 7 --commit-sha $good_sha"
    "non-numeric fencing token|--target-id $V65_TARGET --execution-id e1 --fencing-token tok-1 --commit-sha $good_sha --artifact server=$d"
    "short commit sha|--target-id $V65_TARGET --execution-id e1 --fencing-token 7 --commit-sha abc123 --artifact server=$d"
    "artifact with a repository|--target-id $V65_TARGET --execution-id e1 --fencing-token 7 --commit-sha $good_sha --artifact server=$V65_REPO_SERVER@$d"
    "artifact with a tag|--target-id $V65_TARGET --execution-id e1 --fencing-token 7 --commit-sha $good_sha --artifact server=v2"
    "uppercase unit|--target-id $V65_TARGET --execution-id e1 --fencing-token 7 --commit-sha $good_sha --artifact Server=$d"
    "duplicate unit|--target-id $V65_TARGET --execution-id e1 --fencing-token 7 --commit-sha $good_sha --artifact server=$d --artifact server=$d"
    "target id traversal|--target-id ../$V65_TARGET --execution-id e1 --fencing-token 7 --commit-sha $good_sha --artifact server=$d"
    "unknown unit|--target-id $V65_TARGET --execution-id e1 --fencing-token 7 --commit-sha $good_sha --artifact worker=$d"
  )
  local entry
  for entry in "${cases[@]}"; do
    label="${entry%%|*}"
    : > "$DOCKER_LOG"; : > "$AWS_FAKE_LOG"; rm -rf "${CICD_LOCK_DIR:?}"/*
    # shellcheck disable=SC2086
    run_raw ${entry#*|}
    assert_no_effect "$label" || ok=1
  done
  return $ok
}

test_v65_config_errors_rejected() {
  local ok=0 label
  # Control: the valid single-unit configuration deploys, so every case below
  # fails only because of its own defect.
  write_target_config "$V65_TARGET" "unit.server.repository=$V65_REPO_SERVER" "unit.server.container=s"
  run_v65_server_only
  assert_eq "0" "$SCRIPT_EXIT" "control: a valid single-unit configuration deploys" || ok=1
  local -a cases=(
    "unknown key|unit.server.repository=$V65_REPO_SERVER;unit.server.container=s;unit.server.command=rm -rf /"
    "line without key=value|unit.server.repository=$V65_REPO_SERVER;unit.server.container=s;just text"
    "repository with a tag|unit.server.repository=$V65_REPO_SERVER:v2;unit.server.container=s"
    "repository with a digest|unit.server.repository=$V65_REPO_SERVER@$V65_DIGEST_SERVER;unit.server.container=s"
    "repository with ..|unit.server.repository=registry.example.invalid/../x;unit.server.container=s"
    "unsafe container name|unit.server.repository=$V65_REPO_SERVER;unit.server.container=../s"
    "unit without repository|unit.server.container=s"
    "unit without container|unit.server.repository=$V65_REPO_SERVER"
    "two units, one container|unit.server.repository=$V65_REPO_SERVER;unit.server.container=s;unit.client.repository=$V65_REPO_CLIENT;unit.client.container=s"
    "duplicate key|unit.server.repository=$V65_REPO_SERVER;unit.server.container=s;unit.server.repository=registry.example.invalid/other/app"
    "bad migration mode|unit.server.repository=$V65_REPO_SERVER;unit.server.container=s;migration-mode=inline"
  )
  local entry
  for entry in "${cases[@]}"; do
    label="${entry%%|*}"
    local -a lines=()
    IFS=';' read -r -a lines <<< "${entry#*|}"
    write_target_config "$V65_TARGET" "${lines[@]}"
    : > "$DOCKER_LOG"; : > "$AWS_FAKE_LOG"; rm -rf "${CICD_LOCK_DIR:?}"/*
    if [[ "$label" == "two units, one container" ]]; then run_v65; else run_v65_server_only; fi
    assert_no_effect "config: $label" || ok=1
  done
  rm -f "$CICD_TARGET_CONFIG_DIR/${V65_TARGET}.conf"
  : > "$DOCKER_LOG"; : > "$AWS_FAKE_LOG"; rm -rf "${CICD_LOCK_DIR:?}"/*
  run_v65_server_only
  assert_no_effect "config: missing file" || ok=1
  if grep -q "configuration" "$STDERR_FILE"; then pass "the usage error names the missing configuration"; else fail "stderr does not explain: $(cat "$STDERR_FILE")"; ok=1; fi
  return $ok
}

# The Executor runs the script over a non-interactive SSH exec: no TTY, no stdin,
# a minimal environment and a short PATH, and CRLF may sneak into a config file.
test_v65_non_interactive_minimal_env() {
  local ok=0
  v65_config
  sed -i 's/$/\r/' "$CICD_TARGET_CONFIG_DIR/${V65_TARGET}.conf"
  local -a base=()
  mapfile -t base < <(v65_vector)
  set +e
  env -i HOME="$SANDBOX_DIR" PATH="$SHIMS_DIR:/usr/bin:/bin" \
    CICD_LOCK_DIR="$CICD_LOCK_DIR" CICD_TARGET_CONFIG_DIR="$CICD_TARGET_CONFIG_DIR" \
    DOCKER_STATE_DIR="$DOCKER_STATE_DIR" DOCKER_LOG="$DOCKER_LOG" AWS_FAKE_LOG="$AWS_FAKE_LOG" \
    bash "$SCRIPT_UNDER_TEST" "${base[@]}" < /dev/null > "$SANDBOX_DIR/stdout" 2> "$SANDBOX_DIR/stderr"
  SCRIPT_EXIT=$?
  set -e
  STDOUT_FILE="$SANDBOX_DIR/stdout"; STDERR_FILE="$SANDBOX_DIR/stderr"
  if [[ "$SCRIPT_EXIT" -eq 0 ]]; then
    pass "exit 0 with no TTY, stdin closed, a minimal environment and a CRLF config"
  else
    fail "expected exit 0, got $SCRIPT_EXIT; stderr: $(cat "$STDERR_FILE")"; ok=1
  fi
  local last; last="$(last_stdout_line)"
  if [[ "$last" == CICD_RESULT\ * ]] && json_is_valid "${last#CICD_RESULT }"; then
    pass "the last stdout line is a valid CICD_RESULT"
  else
    fail "last stdout line is not a valid CICD_RESULT: $last"; ok=1
  fi
  return $ok
}

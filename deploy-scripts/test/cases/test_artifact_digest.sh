#!/usr/bin/env bash
# FR-13 "immutable artifact references" (DD-26, design §6.5), three scenarios:
#   (a) a tag (or any non repo@sha256:<64-hex> form) is a usage error: exit 2
#       with NO effect -- asserted on the shim call logs, not on the exit code
#       alone;
#   (b) the new image is pulled (and started) BY DIGEST;
#   (c) "already running these digests": exit 0 with no migration and no
#       swap effects (no docker run / stop / rm recorded).

# Asserts that nothing at all was attempted: zero docker calls, zero aws calls,
# no CICD_RESULT, no lock file, nothing on stdout.
assert_no_effect() {
  local label="$1" ok=0
  if [[ "$SCRIPT_EXIT" -eq 2 ]]; then
    pass "$label: rejected with usage exit 2"
  else
    fail "$label: expected exit 2, got $SCRIPT_EXIT"; ok=1
  fi
  if [[ -s "$DOCKER_LOG" ]]; then
    fail "$label: docker was invoked (expected zero calls): $(cat "$DOCKER_LOG")"; ok=1
  else
    pass "$label: zero docker calls recorded"
  fi
  if [[ -s "$AWS_FAKE_LOG" ]]; then
    fail "$label: aws was invoked (expected zero calls)"; ok=1
  else
    pass "$label: zero aws calls recorded"
  fi
  if grep -q '^CICD_RESULT ' "$STDOUT_FILE"; then
    fail "$label: CICD_RESULT printed for a usage error"; ok=1
  else
    pass "$label: no CICD_RESULT line"
  fi
  if compgen -G "$CICD_LOCK_DIR/*" >/dev/null; then
    fail "$label: the lock directory was touched: $(ls "$CICD_LOCK_DIR")"; ok=1
  else
    pass "$label: lock directory untouched"
  fi
  return $ok
}

test_artifact_tag_rejected() {
  local ok=0 ref
  for ref in "${IMG_REPO}:v2" "$IMG_REPO" "${IMG_REPO}:v2@sha256:$(printf 'a%.0s' {1..63})" "${IMG_REPO}@sha256:abc123" "${IMG_REPO}@sha256:$(printf 'G%.0s' {1..64})"; do
    : > "$DOCKER_LOG"; : > "$AWS_FAKE_LOG"
    shim_set_running "server" "$IMG_V1"
    run_script \
      --execution-id "n15-tag-$$-$RANDOM" \
      --unit demo-unit \
      --artifact "server=$ref" \
      --lock-key demo-lock \
      --fencing-token tok-1
    assert_no_effect "artifact '${ref#"$IMG_REPO"}'" || ok=1
    if [[ "$(container_running_image server)" == "$IMG_V1" ]]; then
      pass "artifact '${ref#"$IMG_REPO"}': running container untouched"
    else
      fail "artifact '${ref#"$IMG_REPO"}': running container changed"; ok=1
    fi
  done

  # A tag in the --previous hint is rejected the same way.
  : > "$DOCKER_LOG"; : > "$AWS_FAKE_LOG"
  run_script \
    --execution-id "n15-tag-prev-$$-$RANDOM" \
    --unit demo-unit \
    --artifact "server=$IMG_V2" \
    --previous "server=${IMG_REPO}:v1" \
    --lock-key demo-lock \
    --fencing-token tok-1
  assert_no_effect "--previous with a tag" || ok=1

  # The removed --image flag is an unknown argument (usage exit 2, no effect).
  : > "$DOCKER_LOG"; : > "$AWS_FAKE_LOG"
  run_script \
    --execution-id "n15-noimage-$$-$RANDOM" \
    --unit demo-unit \
    --image "server=$IMG_V2" \
    --lock-key demo-lock \
    --fencing-token tok-1
  assert_no_effect "legacy --image flag" || ok=1
  return $ok
}

test_artifact_pulled_by_digest() {
  local ok=0
  shim_set_running "server" "$IMG_V1"
  run_script \
    --execution-id "n15-pull-$$-$RANDOM" \
    --unit demo-unit \
    --artifact "server=$IMG_V2" \
    --previous "server=$IMG_V1" \
    --lock-key demo-lock \
    --fencing-token tok-1

  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "expected exit 0, got $SCRIPT_EXIT"; ok=1; }
  if grep -qFx -- "docker pull $IMG_V2" "$DOCKER_LOG"; then
    pass "recorded exactly: docker pull <repo>@sha256:<digest>"
  else
    fail "digest pull not recorded; docker log: $(cat "$DOCKER_LOG")"; ok=1
  fi
  if grep '^docker pull ' "$DOCKER_LOG" | grep -qv '@sha256:'; then
    fail "a pull without a digest was recorded"; ok=1
  else
    pass "no pull by tag recorded"
  fi
  if [[ "$(container_running_image server)" == "$IMG_V2" ]]; then
    pass "container started from the digest reference"
  else
    fail "container runs '$(container_running_image server)', expected the digest reference"; ok=1
  fi
  local json; json="$(cicd_result_json)"
  assert_eq "$IMG_V2" "$(json_get "$json" deployedImages.server)" "deployedImages.server is the digest ref" || ok=1
  assert_eq "$IMG_V1" "$(json_get "$json" previousImages.server)" "previousImages.server is recorded by digest" || ok=1
  return $ok
}

test_artifact_already_running_skips() {
  local ok=0
  shim_set_running "server" "$IMG_V2"
  shim_seed_image "$IMG_V2"
  shim_seed_image "$IMG_V1"
  # The migration check fails and the run command would succeed: if the
  # migration ran, migrations would be APPLIED and a docker run would be logged.
  run_script \
    --execution-id "n15-same-$$-$RANDOM" \
    --unit demo-unit \
    --artifact "server=$IMG_V2" \
    --previous "server=$IMG_V1" \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --migrate server --migration-check "exit 1" --migration-run "exit 0"

  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "expected exit 0 (already running these digests), got $SCRIPT_EXIT"; ok=1; }
  local verb
  for verb in run stop rm exec; do
    if grep -q "^docker $verb " "$DOCKER_LOG" || grep -qx "docker $verb" "$DOCKER_LOG"; then
      fail "docker $verb was recorded; an already-running skip must have no migration or swap effects: $(cat "$DOCKER_LOG")"; ok=1
    else
      pass "no docker $verb recorded"
    fi
  done
  local json; json="$(cicd_result_json)"
  assert_eq "NONE" "$(json_get "$json" migrations)" "migrations=NONE (migration not run)" || ok=1
  assert_eq "SUCCESS" "$(json_get "$json" status)" "status=SUCCESS" || ok=1
  assert_eq "$IMG_V2" "$(json_get "$json" deployedImages.server)" "deployedImages.server unchanged" || ok=1
  assert_eq "$IMG_V1" "$(json_get "$json" previousImages.server)" "previousImages.server kept from the hint" || ok=1
  image_is_present "$IMG_V1" && pass "previous image kept" || { fail "previous image removed"; ok=1; }
  return $ok
}

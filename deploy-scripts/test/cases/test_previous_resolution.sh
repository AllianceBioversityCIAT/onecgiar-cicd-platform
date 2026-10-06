#!/usr/bin/env bash
# DD-26 / FR-13 "previous image ... identified by digest": whatever a container
# is running at deploy start (possibly started by a TAG, e.g. by another
# tool on the same target) is resolved to an immutable identity before it is
# recorded, restored or protected from pruning. A tag is never used.

PREV_TAG_REF="${IMG_REPO}:7"

# Common arguments for the tag-started scenarios.
run_over_tag_started() {
  run_script \
    --execution-id "n15-prev-$$-$RANDOM" \
    --unit demo-unit \
    --artifact "server=$IMG_V2" \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    "$@"
}

# Fails when any recorded docker call pulled/ran/removed anything by tag.
assert_no_tag_usage() {
  local label="$1"
  if grep -E "^docker (pull|run|rmi) " "$DOCKER_LOG" | grep -qF -- "$PREV_TAG_REF"; then
    fail "$label: the tag '$PREV_TAG_REF' was used: $(grep -F -- "$PREV_TAG_REF" "$DOCKER_LOG")"
    return 1
  fi
  pass "$label: no pull/run/rmi by tag recorded"
}

test_previous_resolved_to_digest() {
  local ok=0
  shim_define_image "$PREV_TAG_REF" "$IMG_ID_V1" "$IMG_V1"
  shim_set_running "server" "$PREV_TAG_REF"
  shim_seed_image "$IMG_V0"
  shim_seed_image "$IMG_V1"

  # --- success path: previous reported by digest and kept through pruning ---
  run_over_tag_started
  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "success path: expected exit 0, got $SCRIPT_EXIT"; ok=1; }
  local json; json="$(cicd_result_json)"
  assert_eq "$IMG_V1" "$(json_get "$json" previousImages.server)" "previousImages.server is the digest, not the tag" || ok=1
  image_is_present "$IMG_V1" && pass "previous digest image survives pruning" || { fail "previous digest image was pruned"; ok=1; }
  image_is_present "$IMG_V0" && { fail "stale older image was not pruned"; ok=1; } || pass "stale older image pruned"
  assert_no_tag_usage "success path" || ok=1

  # --- failure path: restore by digest ---
  : > "$DOCKER_LOG"
  shim_set_running "server" "$PREV_TAG_REF"
  run_over_tag_started --health 'server=exit 1'
  [[ "$SCRIPT_EXIT" -eq 40 ]] || { fail "health failure: expected exit 40, got $SCRIPT_EXIT"; ok=1; }
  if grep -qE "^docker run -d --name server .*${IMG_V1}\$" "$DOCKER_LOG"; then
    pass "restore ran 'docker run' by digest"
  else
    fail "restore by digest not recorded: $(cat "$DOCKER_LOG")"; ok=1
  fi
  assert_eq "$IMG_V1" "$(container_running_image server)" "container restored on the previous digest" || ok=1
  json="$(cicd_result_json)"
  assert_eq "$IMG_V1" "$(json_get "$json" previousImages.server)" "previousImages.server (restore case) is the digest" || ok=1
  assert_no_tag_usage "restore path" || ok=1
  return $ok
}

test_previous_unresolved_fallback() {
  local ok=0
  # The running image has NO RepoDigest: only its image ID is known.
  # IMG_V0 is the same image (same ID) seen through another digest ref: it must
  # be kept by the pruning keep-set; IMG_V1 is a different image: pruned.
  shim_define_image "$IMG_V0" "$IMG_ID_V1"
  shim_define_image "$PREV_TAG_REF" "$IMG_ID_V1"
  shim_set_running "server" "$PREV_TAG_REF"
  shim_seed_image "$IMG_V0"
  shim_seed_image "$IMG_V1"

  run_over_tag_started
  [[ "$SCRIPT_EXIT" -eq 0 ]] || { fail "fallback success: expected exit 0, got $SCRIPT_EXIT"; ok=1; }
  local json; json="$(cicd_result_json)"
  json_is_valid "$json" && pass "CICD_RESULT is valid JSON" || { fail "CICD_RESULT is not valid JSON"; ok=1; }
  assert_eq "unresolved:$IMG_ID_V1" "$(json_get "$json" previousImages.server)" "previousImages.server marks the image ID as unresolved" || ok=1
  image_is_present "$IMG_V0" && pass "same-ID image protected by the keep-set" || { fail "previous image (same ID) was pruned"; ok=1; }
  image_is_present "$IMG_V1" && { fail "unrelated old image was not pruned"; ok=1; } || pass "unrelated old image pruned"
  assert_no_tag_usage "fallback success" || ok=1

  : > "$DOCKER_LOG"
  shim_set_running "server" "$PREV_TAG_REF"
  run_over_tag_started --health 'server=exit 1'
  [[ "$SCRIPT_EXIT" -eq 40 ]] || { fail "fallback health failure: expected exit 40, got $SCRIPT_EXIT"; ok=1; }
  if grep -qE "^docker run -d --name server .*${IMG_ID_V1}\$" "$DOCKER_LOG"; then
    pass "restore ran 'docker run' by image ID"
  else
    fail "restore by image ID not recorded: $(cat "$DOCKER_LOG")"; ok=1
  fi
  assert_eq "$IMG_ID_V1" "$(container_running_image server)" "container restored on the image ID" || ok=1
  assert_no_tag_usage "fallback restore" || ok=1
  return $ok
}

# A failure on one container must not roll back a container this run did not
# change (it was already running the requested digest).
test_already_current_not_restored() {
  local ok=0
  shim_set_running "server" "$IMG_V2"
  shim_set_running "worker" "$IMG_V0"
  run_script \
    --execution-id "n15-cur-$$-$RANDOM" \
    --unit demo-unit \
    --artifact "server=$IMG_V2" \
    --artifact "worker=$IMG_V2" \
    --previous "server=$IMG_V1" \
    --lock-key demo-lock \
    --fencing-token tok-1 \
    --health 'worker=exit 1'
  [[ "$SCRIPT_EXIT" -eq 40 ]] || { fail "expected exit 40, got $SCRIPT_EXIT"; ok=1; }
  if grep -qE '^docker (stop|rm) server$|^docker run -d --name server ' "$DOCKER_LOG"; then
    fail "the already-current container 'server' was touched: $(cat "$DOCKER_LOG")"; ok=1
  else
    pass "already-current 'server' was neither stopped, removed nor restarted"
  fi
  assert_eq "$IMG_V2" "$(container_running_image server)" "'server' still runs the requested digest" || ok=1
  assert_eq "$IMG_V0" "$(container_running_image worker)" "'worker' (changed by this run) was restored" || ok=1
  return $ok
}

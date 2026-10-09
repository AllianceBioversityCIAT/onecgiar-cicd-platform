#!/usr/bin/env bash
# Local test runner for deploy-container.sh (T-14, Gate A).
#
# SCOPE AND LIMITS (read before trusting a green run):
#   This machine (Windows + Git Bash) has NO Docker daemon and NO real
#   `flock`. Every test below runs deploy-container.sh for real, but with
#   SHIMS on PATH (fake docker / flock / aws, under test/lib/shims/) that
#   record invocations and simulate containers, images, and exit codes.
#
#   What this DOES prove: the script's own control flow -- argument
#   handling, ordering (migration BEFORE swap, swap BEFORE health), exit
#   codes, cleanup of the per-execution temp dir on every exit path,
#   never-prune-the-previous-image, --previous-hint-only-when-absent, the
#   shape of CICD_RESULT, and that secret values never reach stdout/stderr.
#
#   What this does NOT and CANNOT prove (DEFERRED to Gate C, T-33, on real
#   Linux with a real Docker daemon and real flock(2)):
#     - Real kernel-lock semantics (true non-blocking mutual exclusion,
#       release-on-process-death).
#     - Real Docker behavior (real image pulls, real container lifecycle,
#       real health checks against a real process).
#     - Any other Linux-specific behavior (signal delivery nuances, which
#       provider actually resolves in the AWS CLI's credential chain on a
#       real target, real ECR auth).
#   No test here is a substitute for T-33. Do not report this run as proof
#   of production readiness on a real target.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPTS_DIR="$(cd "$SELF_DIR/.." && pwd)"
SCRIPT_UNDER_TEST="$DEPLOY_SCRIPTS_DIR/deploy-container.sh"

overall_rc=0

echo "== bash -n (syntax check) =="
if bash -n "$SCRIPT_UNDER_TEST"; then
  echo "OK: deploy-container.sh has valid bash syntax"
else
  echo "FAIL: deploy-container.sh has a syntax error"
  overall_rc=1
fi
echo

echo "== shellcheck =="
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -s bash "$SCRIPT_UNDER_TEST"; then
    echo "OK: shellcheck reported no issues"
  else
    echo "FAIL: shellcheck reported issues (see above)"
    overall_rc=1
  fi
else
  echo "SKIPPED: shellcheck is not installed on this machine -- not run, not claimed as PASS"
fi
echo

# shellcheck source=lib/harness.sh
source "$SELF_DIR/lib/harness.sh"

for case_file in "$SELF_DIR"/cases/test_*.sh; do
  # shellcheck source=/dev/null
  source "$case_file"
done

echo "== control-flow tests (shimmed docker/flock/aws) =="
run_test "migration fails -> exit 20, old container keeps serving"            test_migration_fails
run_test "health check fails -> exit 40, previous restored"                   test_health_fails
run_test "concurrent run while locked -> exit 50, no docker calls"            test_target_busy
run_test "pruning always keeps the previous image (scoped, not host-wide)"    test_pruning_keeps_previous
run_test "per-execution temp dir removed on every exit path (0/10/20/30/40/50)" test_temp_env_cleanup
run_test "CICD_RESULT is the last stdout line and valid JSON"                 test_cicd_result_json
run_test "runtime secret value never appears in stdout/stderr/logs"          test_secret_not_leaked
run_test "previous = the image actually running; none invented when absent"   test_previous_hint
run_test "HUP ignored during the critical section (best-effort)"             test_hup_ignored
run_test "idempotent re-run: previous image survives pruning, no re-migration" test_idempotent_rerun
run_test "pull fails -> exit 10, previous container state untouched"         test_pull_fails_untouched
run_test "start fails (running previous) -> exit 30, previous running again" test_start_fails_restores
run_test "temp-container migration mode: failed migration -> exit 20, old untouched, temp removed" test_migration_temp_container_mode
run_test "unsafe identifiers (path traversal) rejected before any effect"    test_arg_validation
run_test "tag or malformed artifact reference -> exit 2, zero docker/aws calls (FR-13)" test_artifact_tag_rejected
run_test "new image is pulled and started by digest, previous recorded by digest" test_artifact_pulled_by_digest
run_test "already running these digests -> exit 0, no migration, no stop/rm/run"  test_artifact_already_running_skips
run_test "tag-started running container: previous resolved to a digest, restored and kept by digest" test_previous_resolved_to_digest
run_test "no RepoDigest: previous restored by image ID, marked unresolved, never a tag" test_previous_unresolved_fallback
run_test "already-current container is not rolled back by a failure elsewhere"  test_already_current_not_restored
run_test "§6.5: the exact Executor vector deploys each unit from its configured repository and container" test_v65_executor_vector_deploys
run_test "§6.5: removed CLI flags are usage errors with no effect"                 test_v65_removed_flags_rejected
run_test "§6.5: missing or malformed arguments and unknown units are usage errors with no effect" test_v65_bad_arguments_rejected
run_test "§6.5: a missing or invalid target configuration is a usage error with no effect" test_v65_config_errors_rejected
run_test "§6.5: works over a non-interactive SSH exec (no TTY or stdin, minimal env, CRLF config)" test_v65_non_interactive_minimal_env
run_test "AC-03 template: no-argument run deploys, reports the commit and takes the mutex" test_template_none_mode
run_test "AC-03 template: standard vector deploys with the target-id mutex and fencing token" test_template_standard_mode
run_test "AC-03 template: phase failures map to 10/20/30/40, unrestorable failures to unknown" test_template_failure_mapping
run_test "AC-03 template: busy mutex -> 50 with no effect; usage errors -> 2" test_template_busy_and_usage

echo
echo "== summary =="
echo "Tests run:          $TESTS_RUN"
echo "Tests failed:       $TESTS_FAILED"
echo "Tests skipped:      $TESTS_SKIPPED (whole test could not run at all in this environment; not counted as passed)"
echo "Assertions skipped: $ASSERTIONS_SKIPPED (single environment-limited checks inside otherwise-PASS/FAIL tests; those tests still report PASS/FAIL on their real assertions)"
echo
echo "Reminder: this run validates CONTROL FLOW ONLY, under shims, on a"
echo "non-Linux machine with no Docker and no real flock. Real kernel-lock"
echo "semantics, real Docker behavior, and other Linux-specific behavior are"
echo "DEFERRED to Gate C (T-33) and are NOT claimed as PASS here."

if [[ "$TESTS_FAILED" -gt 0 ]]; then
  overall_rc=1
fi

exit "$overall_rc"

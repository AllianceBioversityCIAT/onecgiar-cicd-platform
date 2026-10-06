#!/usr/bin/env bash
# @akili-spec changes/cicd-executor-poc gate-b-plan K-7 (D-5), design §6.5
#
# OWNER-RUN, READ-ONLY target probe. It is NOT a deploy script: it is not in the
# `deployScript` allowlist, it never lives under deploy-scripts/ and it is never
# copied into the Executor image.
#
# Reports: bash version, `flock` presence, Docker CLI presence (client version
# only), /tmp mode and sticky bit, current uid/gids (numbers only), and a
# `flock -n` contention check on a PROBE-ONLY lock file.
#
# It NEVER pulls, runs, stops or removes containers, never uses sudo and writes
# nothing except the probe lock file named below (removed again on exit when this
# run created it). The last stdout line is the single CICD_RESULT line.
set -euo pipefail

probe_lock="${TMPDIR:-/tmp}/cicd-probe.lock"
lock_created="no"
lock_ok="yes"
holder_pid=""
failed=()

cleanup() {
  if [ -n "$holder_pid" ]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  if [ "$lock_created" = "yes" ]; then
    rm -f -- "$probe_lock"
  fi
}
trap cleanup EXIT

report() { printf 'probe.%s=%s\n' "$1" "$2"; }

# --- bash ------------------------------------------------------------------
report bash_version "${BASH_VERSION}"

# --- flock -----------------------------------------------------------------
flock_present="no"
if command -v flock >/dev/null 2>&1; then
  flock_present="yes"
else
  failed+=("flock_missing")
fi
report flock_present "$flock_present"

# --- Docker CLI (client only; the daemon is never contacted) -----------------
docker_cli="no"
if command -v docker >/dev/null 2>&1; then
  docker_cli="yes"
  docker_version="$(docker --version 2>/dev/null || echo unknown)"
  report docker_client_version "${docker_version}"
else
  failed+=("docker_cli_missing")
fi
report docker_cli_present "$docker_cli"

# --- /tmp permissions ----------------------------------------------------------
tmp_mode="$(stat -c '%a' /tmp 2>/dev/null || stat -f '%Lp' /tmp 2>/dev/null || echo unknown)"
report tmp_mode "$tmp_mode"
if [ -k /tmp ]; then report tmp_sticky "yes"; else report tmp_sticky "no"; fi

# --- identity (numeric ids only, no names, no secrets) -------------------------
report uid "$(id -u)"
report gids "$(id -G)"

# --- probe lock file safety ------------------------------------------------------
# Refuse a symlink or a non-regular file. Create the file with noclobber so only the
# run that actually created it removes it (no check-then-create race); open it only
# in append mode (never truncate).
lock_unsafe() { [ -L "$probe_lock" ] || { [ -e "$probe_lock" ] && [ ! -f "$probe_lock" ]; }; }
if lock_unsafe; then
  lock_ok="no"
  failed+=("lock_path_unsafe")
elif [ ! -e "$probe_lock" ] && ( set -o noclobber; : > "$probe_lock" ) 2>/dev/null; then
  lock_created="yes"
fi
if [ "$lock_ok" = "yes" ] && lock_unsafe; then
  lock_ok="no" # swapped between the checks
  failed+=("lock_path_unsafe")
fi

# --- flock -n contention on the probe-only lock file ---------------------------
contention="skipped"
release="skipped"
if [ "$flock_present" = "yes" ] && [ "$lock_ok" = "yes" ] && [ ! -w "$probe_lock" ]; then
  lock_ok="no"
  contention="open_failed"
  failed+=("lock_open_failed")
fi
if [ "$flock_present" = "yes" ] && [ "$lock_ok" = "yes" ]; then
  contention="not_observed"
  # Holder: takes the lock, then becomes `sleep` (so `kill` frees the lock).
  ( flock -w 5 9 || exit 3; exec sleep 30 ) 9>>"$probe_lock" &
  holder_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ( exec 8>>"$probe_lock"; flock -n 8 ) 2>/dev/null; then
      sleep 0.2 # the holder has not taken the lock yet: retry
    else
      contention="busy"
      break
    fi
  done
  kill "$holder_pid" 2>/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  holder_pid=""
  if ( exec 8>>"$probe_lock"; flock -n 8 ) 2>/dev/null; then
    release="free"
  else
    release="still_busy"
  fi
  [ "$contention" = "busy" ] || failed+=("contention_not_busy")
  [ "$release" = "free" ] || failed+=("lock_not_released")
fi
report flock_contention "$contention"
report flock_release "$release"

# --- result --------------------------------------------------------------------
if [ "${#failed[@]}" -eq 0 ]; then
  printf 'CICD_RESULT {"status":"PROBE_OK","healthy":true}\n'
  exit 0
fi
report failed_checks "$(IFS=,; echo "${failed[*]}")"
printf 'CICD_RESULT {"status":"PROBE_FAILED","healthy":false}\n'
exit 10

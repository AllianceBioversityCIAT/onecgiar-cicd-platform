# Gate B owner probe tooling (K-7, D-5)

Owner-run tools to validate SSH and `flock` behaviour on a target in B4. They are
**not** deploy scripts: they never live under `deploy-scripts/` or
`deployment-definitions/`, are never copied into the Executor image and are never a
target's `deployScript`. Nothing here is run by CI or by the Executor, and none of it
was run against a real host by the implementer. AC-02 V1: nothing is uploaded; you
install `target-probe.sh` on the target yourself.

| File | What it does | What it never does |
|---|---|---|
| `ssh-preflight` | Prints the commands (`ssh-keyscan`, `ssh-keygen -lf`, strict-host-key `ssh`) you run from your workstation | Executes or contacts anything itself |
| `target-probe.sh` | Read-only report on the target: bash version, `flock`, Docker CLI client version, `/tmp` mode and sticky bit, numeric uid/gids, a `flock -n` contention check on `${TMPDIR:-/tmp}/cicd-probe.lock` | Pulls, runs, stops or removes containers; uses `sudo`; writes anything but the probe lock file; prints names or secrets |
| `executor-ssh-probe` | Reuses the Executor's V1 adapters: reads the target record (`GetItem`, schema-validated), pins its host key, reads the credential through `credentialRef`, runs the INSTALLED `target-probe.sh` (path given by `--probe-script`) with no arguments, parses `CICD_RESULT` | Uploads anything, runs a path whose file name is not `target-probe.sh` or that equals the target's `deployScript`, runs any other command, prints the host, port, user, credential reference, secrets or raw SSH errors |

## Order

1. `tools/gate-b/probe/ssh-preflight` prints the commands. Run them yourself: fetch the host key, compare its fingerprint with the out-of-band value, test a strict-host-key login.
2. Install `target-probe.sh` on the target at an absolute path whose file name is `target-probe.sh` (never the `deployScript`), owned by an administrator and not writable by the deploy user; compare its `sha256sum` with the dry-run digest; run it manually (`bash <PROBE_DIR>/target-probe.sh`). Expected: `probe.flock_contention=busy`, `probe.flock_release=free` and a last line `CICD_RESULT {"status":"PROBE_OK","healthy":true}` (exit 0). A missing `flock` or Docker CLI gives `PROBE_FAILED`, exit 10 and a `probe.failed_checks=` line.
3. `executor-ssh-probe` (after `npm run build` in `executor/`), with credentials that may `GetItem` the registry and read the credential secret (the isolated Executor profile):

   ```bash
   tools/gate-b/probe/executor-ssh-probe \
     --target-id '<TARGET_ID>' --probe-script '<PROBE_DIR>/target-probe.sh' \
     --registry-table '<REGISTRY_TABLE_NAME>' --secret-id-prefix '<SECRET_ID_PREFIX>' --region '<AWS_REGION>'
   ```

   Add `--dry-run` first: it prints the plan and the sha256 of the repository's `target-probe.sh` and makes no AWS or SSH call. Exit codes: 0 probe OK, 1 failure (target record, host key, connection, script), 2 usage error.
   Expected success output: `target record read and validated`, `host key verified against the pinned key`, the `probe.*` lines, `CICD_RESULT parsed: yes (status PROBE_OK)` and `probe OK`.

## Testing a deliberate host-key mismatch

Write a scratch target record (administrative principal, conditional put) that copies the real one with another `targetId` and a DIFFERENT valid public key line in `hostKey`, run the tool with that `--target-id`. Expected: `probe FAILED: HOST_KEY_MISMATCH`, exit 1; the credential is never sent. Delete the scratch record afterwards ([06](../../../docs/gate-b/06-target-validation.md) section 4).

## Leftovers and manual cleanup

`target-probe.sh` refuses (`PROBE_FAILED`, `probe.failed_checks=lock_path_unsafe`) when `${TMPDIR:-/tmp}/cicd-probe.lock` is a symlink or not a regular file, and opens it in append mode only (never truncates). If the run is killed with SIGKILL the cleanup trap cannot run, so the bounded leftovers are: the lock-holder `sleep` process lives for at most 30 seconds, and the lock file stays behind and is then never removed by later runs (only the run that created the file removes it). Remove it manually on the target when no probe is running:

```bash
rm -f -- "${TMPDIR:-/tmp}/cicd-probe.lock"
```

`probe.flock_contention=open_failed` means the lock file could not be opened for writing (not "busy"); it fails the probe.

## Notes

- V1: host, port, user and the host-key lines are inline in the target record; only the credential secret (private key) is in Secrets Manager, referenced by `credentialRef`.
- Keep real hosts, users, account IDs and fingerprints out of the repository: use the logical references above.

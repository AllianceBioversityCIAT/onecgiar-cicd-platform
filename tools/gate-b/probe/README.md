# Gate B owner probe tooling (K-7, D-5)

Owner-run tools to validate SSH and `flock` behaviour on a target before B4. They are
**not** deploy scripts: they are outside the `deployScript` allowlist
(`schemas/deployment.schema.json`), never live under `deploy-scripts/` or
`deployment-definitions/`, and are never copied into the Executor image. Nothing here
is run by CI or by the Executor, and none of it was run against a real host by the
implementer.

| File | What it does | What it never does |
|---|---|---|
| `ssh-preflight` | Prints the commands (`ssh-keyscan`, `ssh-keygen -lf`, strict-host-key `ssh`) you run from your workstation | Executes or contacts anything itself |
| `target-probe.sh` | Read-only report on the target: bash version, `flock`, Docker CLI client version, `/tmp` mode and sticky bit, numeric uid/gids, a `flock -n` contention check on `${TMPDIR:-/tmp}/cicd-probe.lock` | Pulls, runs, stops or removes containers; uses `sudo`; writes anything but the probe lock file; prints names or secrets |
| `executor-ssh-probe` | Reuses the Executor's `Ssh2DeployTransport` and the Secrets Manager provider: pinned host key, fresh 0700 SFTP directory, read-back sha256, runs `target-probe.sh` with no arguments, parses `CICD_RESULT`, cleans up | Reads definitions, runs anything but the probe script, prints secrets or raw SSH errors |

## Order

1. `tools/gate-b/probe/ssh-preflight` prints the commands. Run them yourself: fetch the host key, compare its fingerprint with the out-of-band value, test a strict-host-key login.
2. Copy `target-probe.sh` to the target by a means you trust and run it manually (`bash target-probe.sh`). Expected: `probe.flock_contention=busy`, `probe.flock_release=free` and a last line `CICD_RESULT {"status":"PROBE_OK","healthy":true}` (exit 0). A missing `flock` or Docker CLI gives `PROBE_FAILED`, exit 10 and a `probe.failed_checks=` line.
3. `executor-ssh-probe` (after `npm run build` in `executor/`), with the AWS credentials of your own session in the environment:

   ```bash
   tools/gate-b/probe/executor-ssh-probe \
     --connection-ref '<TARGET_CONNECTION>' --host-key-ref '<TARGET_HOST_KEY>' \
     --credential-ref '<TARGET_CREDENTIAL>' \
     --secret-id-prefix '<SECRET_ID_PREFIX>' --region '<AWS_REGION>'
   ```

   Add `--dry-run` first: it prints the refs and the sha256 of the probe script and makes no AWS or SSH call. Exit codes: 0 probe OK, 1 failure (host key, connection, delivery, script), 2 usage error.
   Expected success output: `host key verified against the pinned key`, the delivery line with the verified sha256, the `probe.*` lines, `CICD_RESULT parsed: yes (status PROBE_OK)` and `probe OK`.

## Testing a deliberate host-key mismatch

Create a scratch secret that holds a DIFFERENT valid public key line, point `--host-key-ref` at it and run the tool. Expected: `probe FAILED: HOST_KEY_MISMATCH`, exit 1. The handshake is aborted before authentication, so the SSH credential is never sent. Delete the scratch secret afterwards.

## Leftovers and manual cleanup

`target-probe.sh` refuses (`PROBE_FAILED`, `probe.failed_checks=lock_path_unsafe`) when `${TMPDIR:-/tmp}/cicd-probe.lock` is a symlink or not a regular file, and opens it in append mode only (never truncates). If the run is killed with SIGKILL the cleanup trap cannot run, so the bounded leftovers are: the lock-holder `sleep` process lives for at most 30 seconds, and the lock file stays behind and is then never removed by later runs (only the run that created the file removes it). Remove it manually on the target when no probe is running:

```bash
rm -f -- "${TMPDIR:-/tmp}/cicd-probe.lock"
```

`probe.flock_contention=open_failed` means the lock file could not be opened for writing (not "busy"); it fails the probe.

## Notes

- The connection secret holds identity only (`{"host": ..., "port": ..., "user": ...}`); the host-key secret holds the OpenSSH public key line(s); the credential secret holds the private key. Same shapes as the production registry.
- Keep real hosts, users, account IDs and fingerprints out of the repository: use the logical references above.

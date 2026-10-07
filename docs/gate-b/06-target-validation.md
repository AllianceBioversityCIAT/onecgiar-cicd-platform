<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §3 (B4), §6; D-5; tools/gate-b/probe -->
# 06. Target validation (B4, non-destructive)

**Answer first.** You run three owner tools in a fixed order: the SSH preflight commands, the
read-only `target-probe.sh` manually on the target, then `executor-ssh-probe` from your
workstation. Together they prove the pinned host key, the `flock` busy detection, a fresh 0700
delivery directory, the checksum and the parsed `CICD_RESULT`, without deploying anything.

The tools, their guarantees and cleanup are described in [`../../tools/gate-b/probe/README.md`](../../tools/gate-b/probe/README.md); read it first. They are outside the production `deployScript` allowlist and are never copied into the image. Claude did not run them against any host.

**Prerequisites.** A target `<TARGET_HOST>` with a dedicated deploy user `<DEPLOY_USER>`, SSH port `<TARGET_PORT>`, the out-of-band host-key fingerprint, the deploy user's authorized key, the secrets of [02](02-secrets.md) (connection, host key, private key) created, and the Executor built ([05](05-run-executor-node22.md)).

## 1. Preflight: host key and strict login

Print the commands, then run them yourself (the tool prints and executes nothing):

```bash
tools/gate-b/probe/ssh-preflight
```

Run the printed commands with your real values: `ssh-keyscan`, `ssh-keygen -lf ... -E sha256`, then the strict-host-key login that runs only `true`.

Expected: the fingerprint equals the one you obtained out of band; the strict login exits 0 with no prompt.

**Stop if** the fingerprints differ or the strict login fails. Do not create the host-key secret; the target may be impersonated or the key type differs. Investigate out of band.

The public key line from `ssh-keyscan` (without the host name column) is what the host-key secret stores ([02](02-secrets.md), kind 2).

## 2. `target-probe.sh` manually on the target

1. Copy `tools/gate-b/probe/target-probe.sh` to the target by a means you trust (for example `scp` using the same strict options as the preflight).
2. On the target, as the deploy user: `bash target-probe.sh`.

Expected output lines include `probe.flock_contention=busy`, `probe.flock_release=free`, and a last line `CICD_RESULT {"status":"PROBE_OK","healthy":true}` with exit code 0.

**Stop if** you see `PROBE_FAILED` (exit 10): a `probe.failed_checks=` line names the cause (missing `flock`, missing Docker CLI, unsafe lock path). Fix the target (or decide the target is not suitable) before continuing. `probe.flock_contention=open_failed` means the lock file could not be opened for writing, which is not "busy" and fails the probe.

3. Remove the leftovers (the cleanup trap normally does it; if the run was killed, do it by hand when no probe is running):

   ```bash
   rm -f -- "${TMPDIR:-/tmp}/cicd-probe.lock"
   rm -f -- target-probe.sh
   ```

## 3. `executor-ssh-probe` from the workstation

It reuses the Executor's SSH adapter and secrets provider, so it needs the built `dist` and credentials that may read the secrets (the Executor profile does). Dry run first (no AWS and no SSH call):

```powershell
$env:AWS_CONFIG_FILE = (Resolve-Path executor/.local/aws/config).Path
$env:AWS_SHARED_CREDENTIALS_FILE = (Resolve-Path executor/.local/aws/credentials).Path
$env:AWS_PROFILE = "cicd-executor"
& executor/.local/node22/node.exe tools/gate-b/probe/executor-ssh-probe.mjs --connection-ref '<TARGET_CONNECTION>' --host-key-ref '<TARGET_HOST_KEY>' --credential-ref '<TARGET_CREDENTIAL>' --secret-id-prefix '<SECRET_ID_PREFIX>' --region '<AWS_REGION>' --dry-run
```

Expected: the refs and the sha256 of the probe script; nothing else.

Then the real run: the same command without `--dry-run`. Expected output: `host key verified against the pinned key`, the delivery line with the verified sha256, the `probe.*` lines, `CICD_RESULT parsed: yes (status PROBE_OK)` and `probe OK`, exit 0. Afterwards clear the process variable: `Remove-Item Env:AWS_PROFILE`.

Exit codes: 0 probe OK, 1 failure (host key, connection, delivery, script), 2 usage error.

**Stop if** exit is 1. The tool prints a redacted reason (for example `HOST_KEY_MISMATCH`); share it. Never retry in a loop.

## 4. Deliberate host-key mismatch (negative)

1. Create a scratch secret holding a **different but valid** public key line (for example a freshly generated `ssh-keygen -t ed25519` public key) under `<SECRET_ID_PREFIX><SCRATCH_HOST_KEY_REF>` ([02](02-secrets.md), same command as kind 2).
2. Run the real probe with `--host-key-ref '<SCRATCH_HOST_KEY_REF>'`.

Expected: `probe FAILED: HOST_KEY_MISMATCH`, exit 1. The handshake is aborted before authentication, so the SSH credential is never sent.

3. Delete the scratch secret:

   ```powershell
   aws secretsmanager delete-secret --secret-id "<SECRET_ID_PREFIX><SCRATCH_HOST_KEY_REF>" --force-delete-without-recovery --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
   ```

**Stop if** the probe succeeds with the wrong key. That is a security failure of the host-key pin: stop Gate B and report.

## 5. What must be true before B5

- Preflight fingerprint matched; host-key secret holds that key.
- `target-probe.sh` ended `PROBE_OK` with `flock` busy then free (real contention is observed here for the first time).
- `executor-ssh-probe` ended `probe OK`, and the mismatch check was rejected.
- The probe lock file and script are removed from the target.
- **OD-Q5 is decided** (how the target gets credentials to pull from ECR and read its runtime secret). B5 does not start without it, and this kit does not assume an answer.
- If the target is shared with another deployer, the deploy window policy and external deployers are filled in ([04](04-definitions-and-target.md)).

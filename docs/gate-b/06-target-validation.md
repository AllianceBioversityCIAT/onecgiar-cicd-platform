<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §3 (B4), §6; D-5; tools/gate-b/probe; tasks R-5 (AC-02 V1, B4 probe option A) -->
# 06. Target validation (B4, non-destructive)

**Answer first.** You run three owner steps in a fixed order: the SSH preflight commands, the
read-only `target-probe.sh` installed and run manually on the target, then `executor-ssh-probe`
from your workstation. Together they prove the pinned host key, the `flock` busy detection and
that the Executor's real V1 SSH adapter can read the target record, verify the host key, read
the credential through `credentialRef`, run an installed script with quoted arguments and parse
`CICD_RESULT`, without deploying anything. **AC-02 V1: nothing is uploaded** — the Executor and
the probe only run scripts that are already on the target.

The tools, their guarantees and cleanup are described in [`../../tools/gate-b/probe/README.md`](../../tools/gate-b/probe/README.md); read it first. They are never a target's `deployScript` and are never copied into the image. Claude did not run them against any host.

**Prerequisites.** A target `<TARGET_HOST>` with a dedicated deploy user `<DEPLOY_USER>`, SSH port `<TARGET_PORT>`, the out-of-band host-key fingerprint, the deploy user's authorized key, the SSH credential secret (private key) under the Executor's secret prefix, the deployed Target Registry table (stack output `RegistryTableName`, task R-2), the target's record in it (`targetId`, host, port, user, host key, `credentialRef`, `deployScript`, window policy, `sourceRepositoryId`; written with your administrative principal through `tools/target-registry` ([09](09-target-registry.md)), never with the Executor profile), and the Executor built ([05](05-run-executor-node22.md)).

## 1. Preflight: host key and strict login

Print the commands, then run them yourself (the tool prints and executes nothing):

```bash
tools/gate-b/probe/ssh-preflight
```

Run the printed commands with your real values: `ssh-keyscan`, `ssh-keygen -lf ... -E sha256`, then the strict-host-key login that runs only `true`.

Expected: the fingerprint equals the one you obtained out of band; the strict login exits 0 with no prompt.

**Stop if** the fingerprints differ or the strict login fails. Do not write the host key into the target record; the target may be impersonated or the key type differs. Investigate out of band.

The public key line from `ssh-keyscan` (without the host name column) is what the target record's `hostKey` list holds (AC-02 V1: inline in the record, not a secret).

## 2. Install `target-probe.sh` on the target and run it manually

The Executor never uploads anything in V1, so you install the read-only probe yourself, once, and it stays at a fixed path for step 3.

1. Pick an absolute path whose file name is exactly `target-probe.sh`, for example `<PROBE_DIR>/target-probe.sh` (letters, digits, `.`, `_`, `/`, `-` only). It must **not** be the target's `deployScript`.
2. Copy `tools/gate-b/probe/target-probe.sh` there by a means you trust (for example `scp` with the same strict options as the preflight).
3. Make it owned by an administrator and **not writable by the deploy user** (for example `sudo chown root:root` and `sudo chmod 0755` on the file, and the same ownership on its directory). The same rule protects the real `deployScript` (V1-R3).
4. Compare its digest with the repository copy: `sha256sum <PROBE_DIR>/target-probe.sh` on the target must equal the `sha256=` the dry run of step 3 prints.
5. On the target, as the deploy user: `bash <PROBE_DIR>/target-probe.sh`.

Expected output lines include `probe.flock_contention=busy`, `probe.flock_release=free`, and a last line `CICD_RESULT {"status":"PROBE_OK","healthy":true}` with exit code 0.

**Stop if** you see `PROBE_FAILED` (exit 10): a `probe.failed_checks=` line names the cause (missing `flock`, missing Docker CLI, unsafe lock path). Fix the target (or decide the target is not suitable) before continuing. `probe.flock_contention=open_failed` means the lock file could not be opened for writing, which is not "busy" and fails the probe. **Stop also if** the digest differs or the deploy user can write the file or its directory.

If a run was killed, remove the lock file by hand when no probe is running: `rm -f -- "${TMPDIR:-/tmp}/cicd-probe.lock"`.

## 3. `executor-ssh-probe` from the workstation

It reuses the Executor's V1 SSH adapter, Target Registry adapter and secrets provider, so it needs the built `dist` and credentials that may `GetItem` the registry and read the credential secret (the isolated Executor profile does). **B4 restriction:** `--probe-script` must be a safe absolute path whose file name is `target-probe.sh`, and the tool refuses it if it equals the target's `deployScript`. There is no option to run any other command. Dry run first (no AWS and no SSH call):

```powershell
$env:AWS_CONFIG_FILE = (Resolve-Path executor/.local/aws/config).Path
$env:AWS_SHARED_CREDENTIALS_FILE = (Resolve-Path executor/.local/aws/credentials).Path
$env:AWS_PROFILE = "cicd-executor"
& executor/.local/node22/node.exe tools/gate-b/probe/executor-ssh-probe.mjs --target-id '<TARGET_ID>' --probe-script '<PROBE_DIR>/target-probe.sh' --registry-table '<REGISTRY_TABLE_NAME>' --secret-id-prefix '<SECRET_ID_PREFIX>' --region '<AWS_REGION>' --dry-run
```

Expected: the target id, the probe path and the `sha256=` of the repository's `target-probe.sh` (compare it in step 2); nothing else.

Then the real run: the same command without `--dry-run`. Expected output: `target record read and validated`, `host key verified against the pinned key`, the `probe.*` lines, `CICD_RESULT parsed: yes (status PROBE_OK)` and `probe OK`, exit 0. The tool never prints the host, port, user, credential reference or any secret. Afterwards clear the process variable: `Remove-Item Env:AWS_PROFILE`.

Exit codes: 0 probe OK, 1 failure (`TARGET_UNKNOWN`, `TARGET_INVALID`, host key, connection, script), 2 usage error.

**Stop if** exit is 1. The tool prints a redacted reason (for example `HOST_KEY_MISMATCH` or `TARGET_INVALID` with the violated rule); share it. Never retry in a loop.

## 4. Deliberate host-key mismatch (negative)

The host key lives in the target record, so the negative check uses a **scratch target record**, never an edit of the real one.

1. With your administrative principal, write a scratch record `<TARGET_ID>-hkcheck` that is a copy of the real record except for `targetId` and `hostKey`, which holds a **different but valid** public key line (for example from a freshly generated `ssh-keygen -t ed25519`). Write it with the Target Registry tool ([09](09-target-registry.md)): a create is conditional, so nothing existing is overwritten, and the record is schema-validated:

   ```bash
   tools/target-registry put --file <SCRATCH_RECORD_JSON> --updated-by <YOUR_NAME> --secret-id-prefix <SECRET_ID_PREFIX> --registry-table <REGISTRY_TABLE_NAME> --region <AWS_REGION> --profile <AWS_PROFILE_ADMIN> --checklist-confirmed
   ```

   `<SCRATCH_RECORD_JSON>` is a local file you keep out of the repository (for example under `executor/.local/targets/`), in the plain JSON form of [09](09-target-registry.md) section 2.
2. Run the real probe with `--target-id '<TARGET_ID>-hkcheck'`.

Expected: `probe FAILED: HOST_KEY_MISMATCH`, exit 1. The handshake is aborted before authentication, so the SSH credential is never sent.

3. Delete the scratch record:

   ```powershell
   aws dynamodb delete-item --table-name <REGISTRY_TABLE_NAME> --key '{"pk":{"S":"TARGET#<TARGET_ID>-hkcheck"},"sk":{"S":"META"}}' --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
   ```

**Stop if** the probe succeeds with the wrong key. That is a security failure of the host-key pin: stop Gate B and report.

## 5. What must be true before B5

- Preflight fingerprint matched; the target record's `hostKey` holds that key.
- `target-probe.sh` ended `PROBE_OK` with `flock` busy then free (real contention is observed here for the first time).
- `executor-ssh-probe` ended `probe OK`, and the mismatch check was rejected; the scratch record is deleted.
- The probe lock file is removed; the installed probe stays only if you want to rerun B4 (it is read-only, not writable by the deploy user), otherwise remove it.
- The real `deployScript` is installed on the target with the same ownership rule (not writable by the deploy user) and implements the §6.5 interface, including the target mutex (V1-R3).
- **OD-Q5 is decided** (how the target gets credentials to pull from ECR and read its runtime secret). B5 does not start without it, and this kit does not assume an answer.
- If the target is shared with another deployer, its record's `deployWindowPolicy` is `required`; the external jobs are listed in the coexistence runbook (V1-R5).

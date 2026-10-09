# deploy-scripts

Version-controlled deployment scripts executed on target hosts (design §6.5, DD-11, DD-22).

**The Executor does not deploy applications: it runs the target's authorized script** (architecture-change-03). Every platform and environment has its own script, installed on its server; any technology may be used (Docker, PM2, Tomcat, Java, Node.js…). This folder holds:

| File | What it is |
|---|---|
| `templates/deploy-script-template.sh` | The **technology-neutral starting point** for a platform script (for example one derived from Jenkins deploy stages): optional standard arguments, target mutex, phase-to-exit-code mapping, `CICD_RESULT` with `deployedCommit`. Replace only its PLATFORM block |
| `deploy-container.sh` | The **Docker specialization** (standard mode, artifacts = image digests resolved against an admin-owned per-target configuration). Not a requirement for other platforms. A Docker target must always receive at least one artifact (its caller passes `units` or `artifacts`): a request without artifacts makes it exit 2, reported as `UNKNOWN_TARGET_STATE`. Known limitation: its image pruning is scoped to a repository, so two Docker targets sharing one ECR repository on the same server must not use it until that is fixed |

## Common contract (every script, architecture-change-03 §3)

- **Invocation** (target record `scriptArguments`): `none` → no argument; `standard` (default) → `--target-id <id> --execution-id <id> --fencing-token <n> --commit-sha <40-hex> [--artifact <name>=sha256:<64-hex> …]`. A script may use any subset and ignore the rest, or reject what it does not expect (exit 2 → `UNKNOWN_TARGET_STATE`).
- **Mutex**: take the target mutex before any effect; busy → exit 50 with no effect.
- **Exit codes**: 0 deployed; 10 failed before any change; 20 failed in a pre-switch step; 30 switch failed **and the previous state was restored**; 40 verification failed **and the previous state was restored**; 50 busy; anything else (1, 2, 70, 126, 127, a timeout) is reported as `UNKNOWN_TARGET_STATE`. A script that cannot restore never exits 30/40.
- **Result**: last stdout line `CICD_RESULT {"status":…, "deployedCommit":"<40-hex>"?, "deployedImages":{…}?}`; the Executor compares what is reported with the requested version (`versionCheck`: VERIFIED, MISMATCH or NOT_REPORTED).
- **Jenkins stages**: a Jenkins step fails with `exit 1`; put each stage in the template phase that matches its effect (prepare, pre-switch, switch, verify, restore) so its failure maps to the right code instead of an unknown state.
- **Shared resources** across targets on one server (Docker daemon, Tomcat, ports, directories, reverse proxy, configuration files, system services): every script that touches one takes the same additional lock, or the platforms are one target. The Executor never models them.

## `deploy-container.sh` (Docker specialization)

`deploy-container.sh` is the Docker specialization of the target-side deploy script interface (AC-02 V1, design §6.5, task R-9a; architecture-change-03). A target's administrator installs it (or an adaptation of it) at the path the target record names as `deployScript`, **mode 0755, owned by an administrator and not writable by the deploy user** (V1-R3), together with its target configuration file (mode 0644, same ownership). The Executor runs it over a non-interactive SSH exec and never delivers it (no SFTP). Nothing project-specific is hardcoded in the script.

### Interface (standard mode)

The Executor sends exactly this argument vector (built by `deployPlanOf`, shell-quoted by the SSH transport):

```
deploy-container.sh --target-id <id> --execution-id <id> --fencing-token <digits> \
  --commit-sha <40-hex> --artifact <unit>=sha256:<64-hex> [--artifact <unit>=sha256:<64-hex> ...]
```

- Any other argument, a missing one, a non-numeric fencing token, a short commit, an artifact that is not `sha256:<64-hex>` (a tag, a repository), an invalid or duplicate unit, or an unknown unit is a **usage error**: exit 2, no `CICD_RESULT`, no effect (no lock, no docker, no aws). The Executor maps exit 2 to `UNKNOWN_TARGET_STATE` (design §6.5), so these are prevented upstream by the caller configuration.
- Exit codes: 0 success (including "already running these digests"), 10 pull, 20 migration, 30 start (previous restored), 40 health (previous restored), 50 `TARGET_BUSY` (target mutex held, nothing done), 2 usage.
- The last stdout line on 0/10/20/30/40/50 is `CICD_RESULT {status, deployedImages, previousImages, migrations, healthy, mutexHolder?}`; `deployedImages` and `previousImages` are keyed by container name.

### Target configuration

Each unit is mapped to **its own trusted image repository** and container by the target configuration file `<CICD_TARGET_CONFIG_DIR>/<target-id>.conf` (default directory `/etc/cicd/targets`), also owned by an administrator and not writable by the deploy user. It is read as `KEY=VALUE` lines, never sourced or evaluated; blank lines and `#` comments are ignored, and unknown or repeated keys are refused. `CICD_TARGET_CONFIG_DIR` and `CICD_LOCK_DIR` exist for the local tests; on a target leave them unset (the Executor sends only arguments, never environment). See [`target-config.example.conf`](target-config.example.conf).

| Key | Required | Meaning |
|---|---|---|
| `unit.<unit>.repository` | yes | Image repository (`<registry>/<path>`), without tag or digest; the digest always comes from the request |
| `unit.<unit>.container` | yes | Container name the unit runs as (one container per unit) |
| `unit.<unit>.port` | no | `docker run -p` mapping (`<host>:<container>`) |
| `unit.<unit>.health` | no | `http(s)://` URL checked with `curl`, or a command run in the container |
| `unit.<unit>.runtime-secret` | no | Secret reference fetched on the target with the target's own permissions into a 0600 env file |
| `unit.<unit>.migrate.check` / `unit.<unit>.migrate.run` | no | Migration check and run commands, executed with the NEW image before the swap |
| `migration-mode` | no | `ephemeral` (default) or `temp-container` |

The deployed image of a unit is `<repository>@<digest>`. Images are pulled, started and recorded by digest; pruning is scoped to the repository and always keeps the previous image.

### Behavior kept from the previous version

- Target mutex: a non-blocking kernel `flock` keyed by the target id under `CICD_LOCK_DIR` (default `/var/lock/cicd`); the lock file records `targetId`, `executionId`, `fencingToken`, `commitSha`, PID and start time for the runbook. A held mutex returns 50 with no effect.
- ECR login for ECR registries, then pull by digest; `aws` runs with `AWS_SHARED_CREDENTIALS_FILE=/dev/null` so leftover keys are never used (the target's own credential mechanism is OD-Q5).
- Order: pull, runtime secret, migration (old container keeps serving), swap, health check, restore of the previous image on start or health failure, scoped pruning.
- "Previous" is the image the container is actually running when the script starts, resolved to a digest (or to its image ID, reported as `unresolved:`); when no container exists, or on an idempotent re-run, there is no known previous image: `previousImages` has no entry for it (nothing is invented). There is no `--previous` hint in §6.5.
- `SIGHUP` is ignored for the whole run, so an SSH cut does not interrupt a migration or a swap. A short `PATH` of a non-interactive SSH exec is extended with the usual system locations.

## Local tests

```
bash deploy-scripts/test/run-tests.sh
bash -n deploy-scripts/deploy-container.sh
```

This machine (Windows + Git Bash) has no Docker daemon and no real `flock`. `test/run-tests.sh` runs the real script with shims on `PATH` (`test/lib/shims/{docker,flock,aws}`) that record invocations and simulate containers, images and exit codes. The §6.5 interface is tested directly (`cases/test_interface_v65.sh`); the behavioral cases express their per-unit settings as a target configuration through the harness adapter and call the script with the §6.5 vector. `executor/test/contract/deploy-script-interface.contract.test.ts` runs the Executor's own `deployPlanOf` vector, as the exact SSH command line, through this script and parses the result with the Executor's parser.

These tests prove the script's control flow and its interface. They do **not** validate real kernel-lock semantics, real Docker behavior, real ECR authentication or other Linux-specific behavior: that is validated on the first real target (B4/B5) and is never reported as proven here.

## Template tests

`cases/test_template_generic.sh` generates scripts from `templates/deploy-script-template.sh` by replacing only the PLATFORM block and runs them with no argument and with the standard vector: phase failures map to 10/20/30/40, an unrestorable failure to an unknown code with no `CICD_RESULT`, a held mutex to 50, usage errors to 2. `executor/test/contract/deploy-script-interface.contract.test.ts` drives such a generated non-Docker script with the Executor's own plan in both modes and checks the reported version.

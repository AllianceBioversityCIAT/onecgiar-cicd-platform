# deploy-scripts

Version-controlled deployment scripts executed on target hosts (design §6.5, DD-11, DD-22).

`deploy-container.sh` is the **reference implementation** of the target-side deploy script interface (AC-02 V1, design §6.5, task R-9a). A target's administrator installs it (or an adaptation of it) at the path the target record names as `deployScript`, **mode 0755, owned by an administrator and not writable by the deploy user** (V1-R3), together with its target configuration file (mode 0644, same ownership). The Executor runs it over a non-interactive SSH exec and never delivers it (no SFTP). Nothing project-specific is hardcoded in the script.

## Interface (design §6.5)

The Executor sends exactly this argument vector (built by `deployPlanOf`, shell-quoted by the SSH transport):

```
deploy-container.sh --target-id <id> --execution-id <id> --fencing-token <digits> \
  --commit-sha <40-hex> --artifact <unit>=sha256:<64-hex> [--artifact <unit>=sha256:<64-hex> ...]
```

- Any other argument, a missing one, a non-numeric fencing token, a short commit, an artifact that is not `sha256:<64-hex>` (a tag, a repository), an invalid or duplicate unit, or an unknown unit is a **usage error**: exit 2, no `CICD_RESULT`, no effect (no lock, no docker, no aws). The Executor maps exit 2 to `UNKNOWN_TARGET_STATE` (design §6.5), so these are prevented upstream by the caller configuration.
- Exit codes: 0 success (including "already running these digests"), 10 pull, 20 migration, 30 start (previous restored), 40 health (previous restored), 50 `TARGET_BUSY` (target mutex held, nothing done), 2 usage.
- The last stdout line on 0/10/20/30/40/50 is `CICD_RESULT {status, deployedImages, previousImages, migrations, healthy, mutexHolder?}`; `deployedImages` and `previousImages` are keyed by container name.

## Target configuration

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

## Behavior kept from the previous version

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

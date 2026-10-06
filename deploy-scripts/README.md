# deploy-scripts

Version-controlled deployment scripts executed on target hosts (design DD-10, DD-11, §6.5).

`deploy-container.sh` (T-14, reworked by N-15) is the generic target-side deploy script. It is packaged into the Executor image and uploaded over SFTP for each execution; it is never pre-installed on hosts. Everything unit-specific (images, ports, migration commands, health checks, secret references) arrives as a CLI argument (design §6.5) — nothing PRMS-specific is hardcoded.

## Local tests (Gate A)

```
bash deploy-scripts/test/run-tests.sh
bash -n deploy-scripts/deploy-container.sh
```

This machine (Windows + Git Bash) has no Docker daemon and no real `flock`.
`test/run-tests.sh` runs the real script with shims on `PATH`
(`test/lib/shims/{docker,flock,aws}`) that record invocations and simulate
containers, images and exit codes. This proves the script's own control
flow — ordering (migration before swap, swap before health), exit codes,
cleanup of the per-execution temp dir on every exit path, never pruning the
previous image, the `--previous`-hint-only-when-absent rule, the shape of
`CICD_RESULT`, and that secret values never reach stdout/stderr.

It does **not** and cannot validate real kernel-lock semantics, real Docker
behavior, or other Linux-specific behavior. That is **deferred**
environment-dependent validation, done for real on Linux with a real Docker
daemon in **Gate C, task T-33**. A green run here is never reported as proof
of production readiness on a real target.

## Usage (artifact contract, design §6.5, DD-26)

```
deploy-container.sh --execution-id <id> --unit <unit> --lock-key <key> --fencing-token <token> \
  --artifact <container>=<repository>@sha256:<64-hex>   (repeatable; replaces --image) \
  [--previous <container>=<repository>@sha256:<64-hex>] [--port <container>=<host:container>] \
  [--runtime-secret <container>=<secretRef>] \
  [--migrate <container> [--migration-check <cmd>] [--migration-run <cmd>]] \
  [--migration-mode ephemeral|temp-container] [--health <container>=<cmd|url>]
```

- Artifacts are immutable. Anything that is not `<repository>@sha256:<64-hex>` (a tag, a bare repository, a short digest) is a usage error: exit 2, no `CICD_RESULT`, no effect at all (no lock, no docker, no aws). The same applies to `--previous`. The removed `--image` flag is an unknown argument (exit 2).
- Images are pulled, started and recorded (`deployedImages`, `previousImages`) by digest; pruning is scoped to the repository and addresses images by digest.
- If a container already runs the requested digest, the script exits 0 without running the migration or swapping the container. That path still pulls the digest (a no-op when present) and still health-checks. A failure elsewhere never rolls back such an unchanged container.
- The previous image is whatever the container actually runs at start, resolved to an immutable identity: `docker inspect` gives the image ID, then the `RepoDigests` entry of the same repository gives `<repository>@sha256:<digest>`, which is what `previousImages` reports, what a restore (exit 30/40) runs, and what pruning keeps. A tag the container may have been started with is never recorded, run or pruned by. If the image has no matching `RepoDigest`, the restore uses the image ID (content-addressed) and `previousImages` reports it as `"unresolved:sha256:<image-id>"`; the result stays valid JSON and pruning also protects any candidate with that same ID. Consumers must treat the `unresolved:` prefix as "restorable by ID only, no digest reference known".
- Exit codes: 0 success (including "already running these digests"), 10 pull, 20 migration, 30 start, 40 health, 50 `TARGET_BUSY`, 2 usage.

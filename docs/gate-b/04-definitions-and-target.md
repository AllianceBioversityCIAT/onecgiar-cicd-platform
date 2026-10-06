<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §6, §7; design §6.2, DD-19, DD-23, DD-27 -->
# 04. Definitions and target parameters

**Answer first.** You copy the example definitions into a local, ignored definitions root,
replace the sample ids, run the offline check, and store the real values in Secrets Manager under
the logical refs. Nothing real is committed. The Executor reads this root through
`CICD_DEFINITIONS_ROOT`.

## Parameters you supply (plan section 7)

| Parameter | Where it goes | Notes |
|---|---|---|
| `deploymentId` | Deployment Definition | Semantic id `<OWNER_DEPLOYMENT_ID>`, matches `^[a-z0-9][a-z0-9-]{1,62}$`, unique; also the caller's `deploymentId` input |
| `targetRef` | Deployment Definition and Target Registry key | Logical id `<OWNER_TARGET_REF>`; both files must agree |
| `lockKey` | Target Registry | One deployment per `lockKey` (DD-27). Form `deployment#<TARGET_NAME>#<UNIT_GROUP>` |
| Hostname | Secret, connection identity JSON | Never in Git |
| SSH port | Secret, connection identity JSON | Optional, default 22 |
| SSH username | Secret, connection identity JSON | A dedicated deploy user is recommended |
| Host key | Secret (`hostKeyRef`) | Obtained out of band, compared with `ssh-keyscan` ([06](06-target-validation.md)) |
| SSH private key | Secret (`credentialRef`) | Key only (gap G-1: there is no password path) |
| `deployScript` | Deployment Definition | `deploy-container.sh`, the only approved script |
| `artifacts[]` | Deployment Definition | `unit`, `container`, `imageRepositoryRef` (the secret holds the repository URI) |
| `runtimeSecretRefs` | Deployment Definition | Passed through unresolved; the Executor never reads them. How the target gets pull credentials is **OD-Q5, open** |
| `health` | Deployment Definition | URL ref or command per container |
| Source binding | `source.repositoryRef/workflowRef/environmentRef`, `allowedSenderRef` | `allowedSenderRef` = the CI role id (`CiRoleId`) |
| Deploy window policy | Target Registry | **Keep `deployWindowPolicy: required` (plus `externalDeployersRef`) with NO window open for B1 to B4**, so B2 and B3 end `FAILED (DEPLOY_WINDOW_CLOSED)` with no SSH. Change it only for B5, after OD-Q5 is decided |

Which secret holds what, per logical ref: see the table in [`examples/definitions/README.md`](examples/definitions/README.md) (not repeated here). Create the secrets with [02](02-secrets.md).

## Steps

### 1. Copy the examples into the local root

PowerShell, from the repository root:

```powershell
$dst = "executor/.local/definitions"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Recurse -Force docs/gate-b/examples/definitions/deployment-definitions "$dst/"
Copy-Item -Recurse -Force schemas "$dst/"
Copy-Item -Recurse -Force deploy-scripts "$dst/"
```

Expected: `executor/.local/definitions` contains `deployment-definitions`, `schemas`, `deploy-scripts`.

### 2. Edit the copies

Replace `example-app-dev` with `<OWNER_DEPLOYMENT_ID>` and `example-target-dev` with `<OWNER_TARGET_REF>` in both files; adjust the `lockKey`; keep ref names in `<UPPER_SNAKE>` form and consistent between the two files. Keep `deployWindowPolicy: required` with its `externalDeployersRef` (the example default) and do **not** open a window. Without an open window every accepted request ends `FAILED (DEPLOY_WINDOW_CLOSED)` before any SSH connection; that is what keeps B1 to B4 non-destructive.

**Stop if** your definition says `not-required` (or you have opened a window): do not trigger the workflow. A real request would then run a real SSH deployment on the target. Only B5 (after OD-Q5) may do that.

**Stop if** `git status` shows anything under `executor/.local/`. It must be ignored (`git check-ignore -v executor/.local/definitions`).

### 3. Run the offline check

From `executor/`:

```powershell
npm run definitions:check -- --root .local/definitions
```

This needs Node and a build (see [05](05-run-executor-node22.md) for the portable Node 22; the check itself needs only Node and `tsc`). It is offline: no AWS call, no secret read.

Expected: `OK <deployment id>` per deployment, then `definitions:check passed (N deployment(s))`, exit 0.

**Stop if** it prints `FAIL` for any file or reports zero deployments. A definition file that cannot be parsed is reported here by file, parser code and position; the Executor would instead start **without** that deployment (gap G-9), so never skip this step.

Limitation: the check does not refuse a literal migration command containing line breaks or NUL bytes; the Executor refuses it at startup. A green check does not guarantee startup.

### 4. Create the secrets

Follow [02](02-secrets.md) for every ref in your two files. Then set the Executor's principal refs in `executor.env` ([05](05-run-executor-node22.md)).

### 5. Check the mapping before the first start

For each logical ref in your two files: the matching secret `<PREFIX><REF_NAME>` exists (`describe-secret`). Startup checks the same and refuses naming the missing logical ref.

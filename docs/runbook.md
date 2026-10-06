# Operator Runbook — CI/CD Executor PoC (Model B)

<!-- @akili-spec changes/cicd-executor-poc design §5.1, §7.7, §12, §12.1, §12.2, DD-24, DD-25, DD-27; requirements FR-17, FR-18, FR-25, NFR-06; proposal §12 -->

Operator procedures for the Executor. There is no UI (design §8): the operator's surface is
Slack notifications, CloudWatch Logs/alarms, and reading persisted state in DynamoDB.

**Model B:** CI (GitHub Actions) builds and pushes images and sends one `DEPLOY_REQUESTED`
message; the Executor only coordinates the deploy. There is no CodeBuild, Lambda, S3 artifact
step or webhook ingress to troubleshoot.

**Publication policy:** no real host, account ID, job name, ARN or secret name appears below.
Logical references (`<…>`) stand in for them, per design §4.1/DD-23.

## Quick path

1. Something looks wrong → check Slack for the thread and CloudWatch for the alarm that fired.
2. Find the `executionId` → **Reconstructing an execution** below.
3. If it is a DLQ, rejected-sender, lock or mutex alarm, or `UNKNOWN_TARGET_STATE` → the
   matching section below has the decision table.
4. Record any manual intervention in `docs/jenkins-coexistence-log.md` if it touched a
   Jenkins-shared target.

## Manual trigger

A deploy is requested only by the pinned platform reusable workflow running in the bound
repository's Environment, on the bound ref, for the `push` or `workflow_dispatch` event
(DD-24, DD-29). To deploy manually, **re-run or dispatch that workflow**; never hand-craft a
`DEPLOY_REQUESTED` message. An operator cannot send `DEPLOY_REQUESTED` (an operator redeploy
path is OD-A8, open): the sender binding rejects it as `UNAUTHORIZED_SENDER` (DD-25).

The operator CLI (`tools/`) sends only the operator message types: `DEPLOY_WINDOW_OPEN_REQUESTED`,
`DEPLOY_WINDOW_CLOSE_REQUESTED` and `TARGET_RESOLUTION_RECORDED` (design §6.4). It runs under the
operator principal, the only sender the queue policy and the consumer accept for those types.

## Deploy windows: open and close

Real deploys onto a target shared with Jenkins (`deployWindowPolicy: required`, e.g.
`<PRMS_REPORTING_DEV_TARGET>`, design §7.7) only run inside an **open, valid** window (DD-21).
The operator CLI issues `DEPLOY_WINDOW_OPEN_REQUESTED` and `DEPLOY_WINDOW_CLOSE_REQUESTED`.

| Step | Requirement |
|---|---|
| Open | Supply `openedBy` and an `externalJobsDisabled[]` that **covers every** `externalDeployers` entry declared for that target in the registry. A partial list is rejected (design §7.7's coverage rule) |
| Before opening | Announce the window to the owning application team; confirm in Jenkins that none of the jobs in `externalJobsDisabled[]` have a build in progress; disable those jobs ("Disable Project", reversible, no Jenkinsfile change — proposal §12) |
| Duration | Maximum 8 h; the reconciler auto-closes it on expiry via the GSI2 index (design §7.7) |
| Close | On request, or automatically at `closesAt`. Re-enable the Jenkins jobs and record the window in `docs/jenkins-coexistence-log.md` (who, when, jobs, executions, migration state before/after, DB snapshot taken, incidents) |
| Revalidation | The window is re-checked at four points during a deploy attempt (V1–V4, design §7.7). If it has closed, the execution fails with `DEPLOY_WINDOW_CLOSED` **without ever opening SSH** |
| If the window closes mid-script | The running script is **not** interrupted (killing a migration mid-flight is worse). `windowClosedDuringRun` is recorded and a notification sent; close the window manually afterward if the reconciler has not yet |

## Reconstructing an execution from DynamoDB and CloudWatch (FR-17, NFR-06)

Given only an `executionId` (no access to Jenkins is needed or used):

1. **DynamoDB**, table `cicd-executions-dev`: read `EXEC#{executionId}` / `META`. It holds who
   requested it (`senderRef`), the commit (`commitSha`), the digests (`artifacts`), the
   definition (`definitionRef`) and `scriptChecksum`, the order (`order`), the GitHub run link
   (`ci.runUrl`), `status`, `result`/`error`, `lockLostDuringRun`, `targetWriteRejected`,
   `windowClosedDuringRun` and timestamps. There are no step items in Model B.
2. **CloudWatch Logs**: every entry carries `executionId`, `requestId` and `deploymentId`. Use
   the saved "execution timeline" Logs Insights query, or filter directly, for the ordered
   sequence and exact durations (`LockWaitMs`, `DispatchLatencyMs`, `DeployDurationMs`).
3. **Slack**: the root message and its thread give a human-readable timeline with the GitHub
   run link.
4. Open the GitHub run (`ci.runUrl`) only to see how the images were built and pushed.

No secret, credential, or token appears in any of the above — the logger redacts them
(design §12 "Redaction").

## DLQ triage and redrive

An alarm fires when `cicd-events-dev-dlq` depth is **> 0**.

| Kind | How to recognize it | What it means | Action |
|---|---|---|---|
| **Poison message** | Repeated delivery of the same message, same failure; a bug in the consumer or a handler | A genuine defect — reprocessing it as-is will fail again | Inspect with CloudWatch Logs (`eventId`, `executionId`, error), fix the root cause, then redrive. If it maps to nothing live, record it and discard |
| **Executor down or slow** | Heartbeat alarm active; many messages exhausted `maxReceiveCount` | Transient outage, not a message defect | Confirm the Executor is healthy (heartbeat), then redrive |

Malformed, unauthorized or superseded requests are **not** DLQ traffic: they are recorded as
`REJECTED` (`REJECT#…` item, 30 d) or `SUPERSEDED` and acknowledged (design §5.1, DD-25).

Redrive: use the standard SQS DLQ redrive (console or CLI) to move messages back onto
`cicd-events-dev` once the cause is understood. Never edit a message's body before
redriving; if its content needs correction, trigger a **new** workflow run and discard the
original.

## Rejected sender alarm (`UNAUTHORIZED_SENDER`)

The alarm fires when `RejectedRequests` with reason `UNAUTHORIZED_SENDER` is **> 0** (DD-25).

1. Find the `REJECT#…` item or the log line: it carries the reason, `senderRef` and
   `deploymentId`. The `SenderId` session suffix is **untrusted audit data** only.
2. Decide which case it is:

| Case | Evidence | Action |
|---|---|---|
| Recreated role (new role ID) | The expected principal was recreated; the reference still resolves to the old role ID | Update the non-sensitive identifier reference (`allowedSenderRef`, `executorPrincipalRef`, `schedulerPrincipalRef` or `operatorPrincipalRef`) and restart; this is the fail-closed design (DD-25) |
| Wrong principal for the type | A CI role sent a type or `deploymentId` not assigned to it, or the operator sent `DEPLOY_REQUESTED` | Treat as misconfiguration or abuse; check the queue policy and CI role trust; do not widen the binding |
| Unknown principal | A principal that is not in the queue policy | The queue policy should have denied it; review the queue policy immediately and escalate as a security event |

## CI role cannot be assumed (OIDC)

If a workflow run fails at the credential step, the trust policy did not match (FR-25). Compare
the run's claims with the role's trust shape in `infra/RESOURCES.md` (**OIDC trust shape**):
audience, `repository_id`, `repository_owner_id`, `environment`, `job_workflow_ref` at the
pinned `<PINNED_COMMIT_SHA>`, and the environment-form `sub`. A caller that references the
reusable workflow at any other ref, or a run from another event or ref, is **meant** to fail.
If the pin is moved, change the trust policy in the same change. Never relax a condition to
`StringLike` or add a wildcard to make a run pass. A missing or empty `CICD_BOUND_REF`
Environment variable also fails closed (DD-24).

## Stale distributed lock

The distributed lock (`LOCK#{lockKey}`, DynamoDB, DD-09) self-heals: its lease expires if the
owner stops renewing (e.g. the Executor died or lost connectivity), and the next contender
acquires it. No manual deletion is ever needed or safe — deleting a lock item while its true
owner is still alive would let two executions run concurrently (DD-09's entire point).
If a lock appears "stuck" (an execution stays in `WAITING_LOCK` far longer than the schedule
in design §7.6 would predict), check:

1. Is the owning execution still `DEPLOYING`, with a live SSH session and a renewing lease? If
   so, it is not stuck — wait.
2. Has the owning Executor instance lost its heartbeat (no `ExecutorHeartbeat` metric)? If so,
   the lease will expire on its own within its TTL; no action beyond confirming the instance
   restarts.
3. Only if the lease has demonstrably expired **and** no new owner has acquired it after a
   reasonable margin, escalate — this would indicate a defect in the lock-acquisition path,
   not an operator fix.

An execution past its deadline raises the `ExecutionsPastDeadline` alarm (once wired, see
`infra/RESOURCES.md` **Alarms**): the reconciler re-drives overdue `QUEUED` and `WAITING_LOCK`
executions (design §7.1); anything else needs the checks above.

## 12.1 Stale local mutex on the target (design §12.1, kept)

**Principle:** the mutex is the **kernel's lock** on the file, not the file's existence. If
the process that held it died, the operating system has already released it. A "stuck"
mutex can only be a **live** process holding it. **Never delete the lock file to "release"
it**: that releases nothing if the holder is alive, and if it isn't, there is no need.

| Step | Evidence the operator checks | What it indicates |
|---|---|---|
| 1 | Notification: repeated `TARGET_BUSY`, `LOCK_TIMEOUT` with `contentionCount > 0`, or `UNKNOWN_TARGET_STATE` | The target must be looked at |
| 2 | Lock file content: `executionId`, `fencingToken`, PID, and start time | Who claims to hold it |
| 3 | Is the lock taken? (an OS tool that lists file locks, or a non-blocking test-only attempt) | Not taken → **there is no mutex**: the file is residual and harmless, nothing to release |
| 4 | Does the PID exist and is it the deploy script? Process tree: `docker pull`, migration container, `docker run` | Process alive and working → **active deploy**, even if coordination with DynamoDB failed |
| 5 | DynamoDB state for that `executionId` (`DEPLOYING`, `execStartedAt`, `lockLostDuringRun`) and the Executor's and script's logs in CloudWatch | When it last spoke; whether the session was cut |
| 6 | Real progress: migration container logs, `migration:check:ci` in read-only mode, the unit's container states, elapsed time against `timeoutMinutes` | Advancing → **wait**. No progress for more than 2× `timeoutMinutes` → candidate for being stuck |

**Decision:**

| Case | Action |
|---|---|
| Active deploy (advancing) | Do not touch anything. Wait for it to finish; the OS releases the mutex. Record it in the coexistence log |
| Stuck and **no migration in progress** (the process is in pull, health, or wait) | Terminate the script's process in an orderly way (termination signal first, not a forced kill). The OS releases the mutex. Then verify which image each container is running and restore the previous one with the script if needed |
| Stuck **with a migration in progress** | **Escalate** to the application team and the DB owner before acting: interrupting a migration can leave the schema half-done |
| After any intervention | Record who, when, and the evidence in `docs/jenkins-coexistence-log.md`. Trigger a **new** deploy (re-run or dispatch the workflow); never replay the old request by hand |

## 12.2 Resolve `UNKNOWN_TARGET_STATE` or a rejected target write (design §12.2)

**Invariant while unresolved:** no older version deploys on the `lockKey` (`highestDispatched`,
design §7.3). Newer requests may proceed; the target mutex and the script's "restore from the
running image" keep them safe. The unresolved entry stays in `unresolved[]` on
`TARGET#{lockKey}` until it is cleared by step 6 below.

| Step | Operator action | Evidence recorded |
|---|---|---|
| 1 | From the notification, read `executionId`, `lockKey`, `execStartedAt`, `lockLostDuringRun`, `targetWriteRejected` | DynamoDB execution item |
| 2 | Run §12.1 steps 2–4: is the script still running? If yes, wait for it to end | Process and lock evidence |
| 3 | On the target, list the digest each unit's container is running and compare with the execution's `artifacts` and the previous digests | Digests (logical names only in Git) |
| 4 | If a migration may have run, check migration state read-only (`migration:check:ci`) and escalate to the application team on any doubt | Migration state |
| 5 | Decide: target healthy on the new digests, healthy on the previous ones, or broken. If broken: re-run the **newest** workflow (a newer-or-equal deploy; the script restores automatically on start/health failure, FR-13) or escalate. **Deploying an older digest on purpose, or resetting the order state, is OD-A8: open, and not available in the PoC** | Decision and actor |
| 6 | Record the resolution with the operator CLI: `tools/ resolve-target --lock-key <k> --execution-id <id> --observed <unit>=<digest>…`. It sends `TARGET_RESOLUTION_RECORDED` | `LOG#` audit entry; coexistence log line |

Step 6 details (design §12.2):

- **Who:** the operator principal only (DD-25 per-type binding); any other sender is `REJECTED`.
- **Preconditions** (checked by the Executor): the execution is `UNKNOWN_TARGET_STATE` and is
  listed in `unresolved[]`; the `lockKey` has no live lock owner.
- **Effect:** removes that entry (conditional write) and writes an audit `LOG#` item (actor =
  `SenderId` role plus `resolvedBy`, time, observed digests).
- **It never edits** `lastDeployed`, `highestDispatched`, `highestAccepted` or any terminal
  state. Resetting order is OD-A8 and does not exist in the PoC.

## Rollback

| Scope | Procedure |
|---|---|
| **Execution rollback** (a single failed deploy) | A failed start or health check automatically restores the previous image **inside the script** (exit codes 30/40, FR-13) — **safe only if the target's migrations are backward-compatible (P-23, attested in the registry as `migrationCompatibility: backward-compatible`)**. A failed migration never stopped the previous version, so there is nothing to roll back |
| **Operator redeploy of an older digest** | **OD-A8 (open): not available in the PoC.** Otherwise redeploy through Jenkins during a window |
| **PoC rollback** (abandon the PoC for a target) | Jenkins is left intact throughout — jobs are only ever *disabled*, never removed or rewritten (NFR-10). Re-enable the jobs, destroy the `cicd-poc` resources per `infra/RESOURCES.md`, and redeploy through Jenkins during a window |
| **Shared DEV DB risk** (P-24) | Neither lock layer covers concurrent migrations from Jenkins variants against the same DB. Mitigation is procedural: real deploys only inside a DD-21 window with the other variants' jobs disabled, a DEV DB snapshot before the first test, and `migration:check:ci` state recorded before and after each test in `docs/jenkins-coexistence-log.md` |

## Environment-dependent deferred validations (before deployment)

Some validations cannot run in every environment (no Docker daemon, no Linux target) and are
**deferred, not skipped** — they are mandatory before any real DEV deployment:

| Validation | Command | Why it may be deferred |
|---|---|---|
| Real image inspection | `npm run inspect:image` (inside `executor/`) | Requires a reachable Docker daemon to build and inspect the actual image (no toolchains, no mounted socket, non-root) |
| Deploy-script dry run | Running `deploy-container.sh` end-to-end (mutex take/release, `CICD_RESULT` shape, exit codes) | The script is written for `bash` on Linux (design §6.5) and needs a Linux host with Docker |
| First real CI run | The reusable workflow end to end (OIDC, push, one `DEPLOY_REQUESTED`) | Statically validated in Gate A; first real run in Gate C (DD-29); also observes P-G11 and P-G10 |

Each must pass, for real, before Gate B/C sign-off — a "looks right" review is not a substitute.

# Operator Runbook — CI/CD Executor PoC

<!-- @akili-spec changes/cicd-executor-poc design §7.4, §7.7, §12, §12.1; requirements FR-17, FR-18, NFR-06; proposal §12 -->

Operator procedures for the Executor. There is no UI (design §8): the operator's surface is
Slack notifications, CloudWatch Logs/alarms, and reading persisted state in DynamoDB.

**Publication policy:** no real host, account ID, job name, or secret name appears below.
Logical references (`<…>`) stand in for them, per design §4.1/DD-23.

## Quick path

1. Something looks wrong → check Slack for the thread and CloudWatch for the alarm that fired.
2. Find the `executionId` → **Reconstructing an execution** below.
3. If it's a DLQ or lock/mutex alarm → the matching section below has the decision table.
4. Record any manual intervention in `docs/jenkins-coexistence-log.md` if it touched a
   Jenkins-shared target.

## Manual trigger

The PoC has no inbound HTTP trigger of its own for manual runs (the GitHub webhook, FR-20, is
push-driven only). A manual run is requested through the operator CLI (`tools/`, **planned —
not yet implemented in Gate A**): it publishes a `PIPELINE_REQUESTED` event with a
`requestId` the operator supplies, following the same dedupe path (DD-20) as any other
trigger. Until `tools/` exists, a manual trigger is a direct, one-off publish of that event
shape to `cicd-events-dev` by someone with queue access — record who and when in this file's
change history or in Slack, since there is no CLI audit trail yet.

## Deploy windows: open and close

Real deploys onto a target shared with Jenkins (`deployWindowPolicy: required`, e.g.
`<PRMS_REPORTING_DEV_TARGET>`, design §7.7) only run inside an **open, valid** window
(DD-21). The operator CLI (`tools/`, **planned**) will issue `DEPLOY_WINDOW_OPEN_REQUESTED`
and `DEPLOY_WINDOW_CLOSE_REQUESTED` events.

| Step | Requirement |
|---|---|
| Open | Supply `openedBy` and an `externalJobsDisabled[]` that **covers every** `externalDeployers` entry declared for that target in the registry. A partial list is rejected (design §7.7's coverage rule) |
| Before opening | Announce the window to the owning application team; confirm in Jenkins that none of the jobs in `externalJobsDisabled[]` have a build in progress; disable those jobs ("Disable Project", reversible, no Jenkinsfile change — proposal §12) |
| Duration | Maximum 8 h; the reconciler auto-closes it on expiry via the GSI2 index (design §7.7) |
| Close | On request, or automatically at `closesAt`. Re-enable the Jenkins jobs and record the window in `docs/jenkins-coexistence-log.md` (who, when, jobs, executions, migration state before/after, DB snapshot taken, incidents) |
| Revalidation | The window is re-checked at four points during a deploy attempt (V1–V4, design §7.7): before the first attempt, on every lock retry, after a `TARGET_BUSY`, and immediately before the SSH exec. If it has closed by then, the step fails with `DEPLOY_WINDOW_CLOSED` **without ever opening SSH** — nothing runs on the target |
| If the window closes mid-script | The running script is **not** interrupted (killing a migration mid-flight is worse). `windowClosedDuringRun` is recorded and a notification sent; close the window manually afterward if the reconciler hasn't yet |

## Reconstructing an execution from DynamoDB and CloudWatch (FR-17, NFR-06)

Given only an `executionId` (no access to Jenkins is needed or used):

1. **DynamoDB**, table `cicd-executions-dev`: read `EXEC#{executionId}` / `META` for the
   execution-level record (`pipelineId`, `status`, `targets[]`, `error`, timestamps), then
   `Query` the same partition for every `EXEC#{executionId}` / `STEP#{stepId}` item to get
   each step's `type`, `status`, `attempt`, `externalRef`, `outputs`, and `error`.
2. **CloudWatch Logs**: every log entry related to an execution carries `executionId` (and
   `stepId` when applicable) — use the saved "execution timeline" Logs Insights query, or
   filter directly, to get the ordered sequence of events with external identifiers
   (CodeBuild build id, Lambda request id, SSH session outcome) and exact durations.
3. **Slack**: the root message and its thread give a human-readable timeline and link to
   logs, useful to confirm what was already communicated.
4. Cross-reference `externalRef` (step) against the CodeBuild/Lambda console or CLI only if
   deeper detail on that one external system is needed — DynamoDB + CloudWatch alone are
   sufficient to answer "which steps ran, with which external identifiers, how long they
   took, and why it failed" (FR-17's reconstruction scenario).

No secret, credential, or token appears in any of the above — the logger redacts them
(design §12 "Security").

## DLQ triage and redrive

An alarm fires when `cicd-events-dev-dlq` depth is **> 0**. Not every message in the DLQ is
the same kind of problem:

| Kind | How to recognize it | What it means | Action |
|---|---|---|---|
| **Poison message** | Repeated delivery of the same message, same failure, structurally invalid envelope, or a bug in `event-router`/a handler that will never resolve on its own | A genuine defect — reprocessing it as-is will fail again | Inspect with CloudWatch Logs (`eventId`, `executionId`, error), fix the root cause if it's a bug, then redrive manually. If it cannot be mapped to any live execution, treat it as `ORPHAN_EVENT` noise (design §6.1) and discard after recording it |
| **`RETRY_LATER` race, not poison** | A CodeBuild event arrives before the Executor's own write of that attempt's `externalRef` has landed (`event-router`'s `RETRY_LATER` outcome, `DISPATCHING` with no `externalRef` yet). It is deliberately **not acknowledged** so SQS redelivers it | A transient, expected ordering race (design §6.1's normalization), not a defect. It should resolve itself on redelivery once the `externalRef` write completes | Normally needs **no action** — it will succeed on a later delivery before `maxReceiveCount` is reached. It only reaches the DLQ if redeliveries are exhausted while the Executor is unusually slow or down; in that case, confirm the Executor is healthy (heartbeat alarm), then redrive |
| **Expired/stale event** | The envelope's `executionId`/`stepId` no longer exists, or the external identifier does not match the current attempt (`ORPHAN_EVENT`, design §6.1) | A result from a superseded or already-closed attempt | No redrive — this is correctly inert. Record and delete |

Redrive: use the standard SQS DLQ redrive (console or CLI) to move messages back onto
`cicd-events-dev` once the cause is understood. Never edit a message's body before redriving;
if the content needs correction, publish a fresh event instead and discard the original.

## Stale distributed lock

The distributed lock (`LOCK#{lockKey}`, DynamoDB, DD-09) self-heals: its lease expires if the
owner stops renewing (e.g. the Executor died or lost connectivity), and the next contender
acquires it. No manual deletion is ever needed or safe — deleting a lock item while its true
owner is still alive would let two executions run concurrently (DD-09's entire point).
If a lock appears "stuck" (an execution stays in `WAITING_LOCK` far longer than the schedule
in design §7.6 would predict), check:

1. Is the owning execution's step actually still `RUNNING`, with a live SSH session and a
   renewing lease? If so, it is not stuck — wait.
2. Has the owning execution's Executor instance lost its heartbeat (no `ExecutorHeartbeat`
   metric)? If so, the lease will expire on its own within its TTL; no action needed beyond
   confirming the instance restarts (its lease acquisition at startup, design §7.4).
3. Only if the lease has demonstrably expired **and** no new owner has acquired it after a
   reasonable margin, escalate — this would indicate a defect in the lock-acquisition path,
   not an operator fix.

## Stale local mutex on the target (§12.1, verbatim intent)

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
| 5 | DynamoDB state for that `executionId` and step (`RUNNING`, `lockLostDuringRun`, `UNKNOWN_TARGET_STATE`) and the Executor's and script's logs in CloudWatch | When it last spoke; whether the session was cut |
| 6 | Real progress: migration container logs, `migration:check:ci` in read-only mode, the unit's container states, elapsed time against the step's timeout | Advancing → **wait**. No progress for more than 2× the step's timeout → candidate for being stuck (stalled) |

**Decision:**

| Case | Action |
|---|---|
| Active deploy (advancing) | Do not touch anything. Wait for it to finish; the OS releases the mutex. Record it in the coexistence log |
| Stuck and **no migration in progress** (the process is in pull, health, or wait) | Terminate the script's process in an orderly way (termination signal, not a forced kill from the start). The OS releases the mutex. Then verify which image each container is running and restore the previous one with the script if needed |
| Stuck **with a migration in progress** | **Escalate** to the application team and the DB owner before acting: interrupting a migration can leave the schema half-done |
| After any intervention | Record who, when, and the evidence in `docs/jenkins-coexistence-log.md`. Trigger the pipeline again (a new execution); never retry the previous one by hand |

## Rollback

| Scope | Procedure |
|---|---|
| **Execution rollback** (a single failed deploy) | A failed health check automatically restores the previous image (exit code 40) — **this is safe only if the target's migrations are backward-compatible (P-23, attested in the registry as `migrationCompatibility: backward-compatible`)**. A failed migration never stopped the previous version, so there is nothing to roll back |
| **PoC rollback** (abandon the PoC for a target) | Jenkins is left intact throughout — jobs are only ever *disabled*, never removed or rewritten (NFR-10). Re-enable the jobs, destroy the PoC's own resources per `infra/RESOURCES.md`'s inventory, and on the target restore the previous image either with `deploy-container.sh --image <previous>` or by redeploying through Jenkins |
| **Shared DEV DB risk** (P-24) | Neither the distributed lock nor the local mutex cover concurrent migrations from Jenkins variants against the same DB. Mitigation is procedural, not technical: real deploys only inside a DD-21 window with the other variants' jobs disabled, a DEV DB snapshot before the first test, and `migration:check:ci` state recorded before and after each test in `docs/jenkins-coexistence-log.md` |

## Environment-dependent deferred validations (before deployment)

Some validations cannot run in this environment (no Docker daemon, no Linux target reachable
from here) and are **deferred, not skipped** — they are mandatory before any real DEV
deployment:

| Validation | Command | Why it's deferred here |
|---|---|---|
| Real image inspection | `npm run inspect:image` (inside `executor/`) | Requires a reachable Docker daemon to build and inspect the actual image (no toolchains, no mounted socket, non-root) — not available in this workspace |
| Deploy-script dry run | Running `deploy-container.sh` end-to-end (mutex take/release, `CICD_RESULT` shape, exit codes) | The script is written for `bash` on Linux (design §6.4) and needs an actual Linux host with Docker to execute meaningfully; this workspace cannot run it |

Both must pass, for real, before Gate B/C sign-off — a "looks right" code review is not a
substitute for either.

## Ingress note: missing webhook secret (T-30)

If `<WEBHOOK_SECRET_REF>` is missing or unresolvable at the ingress Lambda's start, signature
verification cannot run and the handler fails closed with a **5xx** response rather than
silently accepting or rejecting pushes. GitHub's webhook delivery retries on any non-2xx
response, so a misconfigured secret shows up as repeated redelivery attempts in GitHub's own
delivery log for the affected hook, not as a queued, wrongly-authenticated event (design
§6.6: "Missing or invalid signature → 401, nothing is queued" covers a *present but wrong*
signature; an unresolvable *secret* is a configuration failure, surfaced as 5xx instead of
401, and is the subject of a separate hardening task, T-30).

# Design — CI/CD Executor PoC (PRMS Reporting DEV)

> **In one line:** GitHub Actions does CI and sends one `DEPLOY_REQUESTED` per build; a single TypeScript Executor (hexagonal, stateless worker) authenticates the sender, validates, dedupes, orders, locks and runs **one** SSH deploy per request against the approved target script. Correctness rests **only** on DynamoDB conditional writes, never on queue order or instance count. Tier **LITE**.

---

## 1. Document Control

| Field | Value |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Phase | Phase 2: Design |
| Version | **v4.7** (owner direction, B0 acceptance 2026-10-06: G-8 minimal internal RECONCILE_TICK contract, G-9 fail-fast definition loading, G-10 role ARN as an Environment variable — no GitHub secret). v4.6 (owner direction, Gate B approval 2026-10-06: DD-24 GitHub value classification — one Environment secret, variables, values derived after OIDC; CI role adds `sqs:GetQueueUrl`; DD-29 decision and §11 security row aligned). v4.5 (Gate A closure editorial sync, no new decision: §5.1 `highestAccepted` write, implemented attributes and items; §5.2 result file and fresh 0700 directory; §6.5 `--unit` value; §12 metric names as implemented and the FR-17 alarm; §12.2 CLI path; DD-29 trailing-comment wording. Points that would need a decision are listed for the owner in `execution.md`, "Spec gaps for the owner (Gate A closure)"). v4.4 (owner approval 2026-10-06: DD-25 / OD-A2 APPROVED; DD-27 / OD-A1 APPROVED for the PoC under the single-source invariant; new action-pinning rule in DD-29 and guard 7). v4.3 (editorial E1–E5 after JD APPROVED: bound-ref source, X1 `highestAccepted`, §5.1 attribute, stale text; no new decision). v4.2 (JD round-2 correction: R2-A1, R2-1…R2-8, R2-A2…R2-A6). v4.1 (JD round-1 correction: CS-1, CS-2, CC-1, CC-2, SU-1, CW-1…CW-6). v4 (Model B). History: v3.2 (2026-10-05, owner amendments), v3.1, v3, v2 — detail in `judgment.md` |
| Depth | Full (re-checked in §14) |
| Requirements | `requirements.md` v3.5 (+ Leader rulings RL-1…RL-7) |
| Intent | `proposal.md` v3.4, under `architecture-change-01.md` (**AC-01**, APPROVED 2026-10-06) |
| Evidence | FA and ctx = local-only documents, cited by sanitized section reference only. External premises P-A1–P-A7 (AC-01 §3) |
| Repository | `https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform.git` (§4.1) |
| Skills applied | `software-architect` (Decision Spine: scenarios → tactics → patterns → DDs). No UI |
| Open decisions | OD-Q5, OD-Q7, OD-Q11–OD-Q15, OD-N1, OD-A3–OD-A9 **remain open**. **OD-A1 and OD-A2 RESOLVED (owner, 2026-10-06)**: DD-27 and DD-25 approved |
| Date | 2026-10-06 |

### 1.1 v3.2 → v4 summary

| Kept | Removed by AC-01 | New |
|---|---|---|
| Hexagonal monolith, conditional writes, intent-then-act, dedupe claim, lock + fencing + bounded wait, target mutex, deploy windows (v2 semantics, RL-1), SFTP-delivered script, migration before swap, Slack, Scheduler tick, visibility heartbeat, `DefinitionSource`, DD-23 | Step graph and planner, Lambda/CodeBuild handlers and contracts, source handler and `/work`, git client, S3 artifacts, event normalization and orphan events, webhook ingress, instance lease, GSI1 | Request contract, sender binding per message type, OIDC trust model, digest-only artifacts, supersede ordering (OD-A1 evaluation), execution-level closed state machine, reusable workflow, implementation-impact list (§15) |

---

## 2. Executive Summary

| Decision | Choice | Requirements |
|---|---|---|
| Split | GitHub Actions = CI (reusable workflow, DD-29); Executor = deploy coordination; target script = procedure | FR-22, NFR-01 |
| Style | Hexagonal modular monolith, one deployable, stateless worker (DD-01) | NFR-01, NFR-08 |
| Consistency | DynamoDB conditional writes with optimistic `version` (DD-03) | FR-05, FR-07, NFR-03 |
| Trust | OIDC `sub` = repo + Environment (DD-24); sender bound per message type via SQS `SenderId` (DD-25, **approved by the owner**) | FR-21, FR-25 |
| Artifacts | Digest only; repository from trusted config (DD-26) | FR-03, FR-13 |
| Ordering | Single source per `lockKey` + in-source `runNumber` (DD-27, **approved for the PoC by the owner**) | FR-23 |
| State | Execution-level closed list X1–X16 (§7.3); one backward edge (code 50) | FR-05 |
| Remote effect | Two-phase intent before exec (DD-28); never re-run automatically | FR-07, FR-12 |
| Locks | DynamoDB lock (lease, owner, fencing) + kernel mutex on the target (DD-09, DD-22) | FR-11, FR-13 |
| Windows | Fail fast `DEPLOY_WINDOW_CLOSED`; revalidated V1–V4 (§7.7, RL-1) | FR-24 |

---

## 3. Architecture Overview

### 3.1 C4 — Context

```text
 [Developer] --push / workflow_dispatch--> [GitHub: <PRMS_REPORTING_REPO> caller workflow]
                                                  | uses (pinned, OD-A6)
                                     [GitHub Actions: reusable workflow (this repo)]
                                        | OIDC → (IAM CI role) | push by digest → (ECR <ECR_REPOSITORY>)
                                        v
 [Operator] --window events-->  (SQS cicd-events-dev) <--RECONCILE_TICK-- (EventBridge Scheduler)
                                        |  + DLQ
                                [[CI/CD Executor]]
             +-------------+------------+--------------+-------------------+
             v             v            v              v                   v
        (DynamoDB)   (Secrets Mgr)  [Slack]   (CloudWatch)   [<PRMS_REPORTING_DEV_TARGET>] via SSH/SFTP
     state, dedupe,  SSH cred,                                     | deploy script: pull by digest
     locks, windows  Slack token                                   +--> DEV DB (migrations, from the target)

Legend: [ ] system or person · [[ ]] system under design · ( ) managed AWS resource · --> data or command flow
```

### 3.2 C4 — Executor containers

```text
+------------------------------ cicd-executor (1 container) -------------------------------+
| Inbound            | Application                | Domain (pure)        | Outbound ports    |
| SqsConsumer ------->  MessageRouter ------------> RequestContract      | StateStore        |
|  (long-poll,       |   SenderAuthorizer          | StateMachine (X1-16) | QueuePublisher    |
|   SenderId attr,   |  ExecutionService           | LockPolicy           | DefinitionSource  |
|   heartbeat)       |  DeployCoordinator ---------> SupersedePolicy      | SecretProvider    |
|                    |  DeployWindowService        | WindowPolicy         | DeployTransport   |
|                    |  Reconciler                 | Errors               |  (SSH/SFTP)       |
|                    |  NotificationService        |                      | NotificationProv. |
|                    |  DefinitionService          |                      | Clock             |
+-------------------------------------------------------------------------------------------+
Legend: arrows = call dependency. The domain has no I/O; adapters implement the ports.
```

### 3.3 Main flow (PRMS Reporting DEV)

| # | Trigger | Actor / action | Resulting state |
|---|---|---|---|
| 1 | Push to the allowed branch or `workflow_dispatch` | Caller → reusable workflow: lint, test, build server and client, push to `<ECR_REPOSITORY>`, capture digests | CI run green |
| 2 | CI green | Workflow assumes the CI role (OIDC) and sends one `DEPLOY_REQUESTED` | Message in SQS |
| 3 | Receive | Sender authorization (DD-25) → schema → definition lookup → dedupe claim (DD-20) → sequence → create execution; S1 supersede check | `QUEUED` (or `REJECTED`, `SUPERSEDED`) |
| 4 | Same pass | V1 window check → `WAITING_LOCK` | `WAITING_LOCK` (or `FAILED DEPLOY_WINDOW_CLOSED`) |
| 5 | Lock attempt (now or `LOCK_RETRY_REQUESTED`) | V2 → acquire lock (fencing) → S2 supersede (authoritative) → intent (`dispatchToken`) | `DEPLOYING` |
| 6 | Inside `DEPLOYING` | SSH semaphore → session → SFTP script → V4 → record `execStartedAt` → exec | Script running; target mutex held |
| 7 | Script exits | Map code → fenced target-state write → release lock → Slack | Terminal, or `WAITING_LOCK` on code 50 |

---

## 4. Directory Structure

### 4.1 Canonical repository and version control (unchanged)

| Aspect | Decision |
|---|---|
| Canonical repository | `onecgiar-cicd-platform` (above). The repo root is the root of §4.2 |
| Never versioned | The two local analysis files; `.gitignore` excludes them; `git status` + `git ls-files` check before every commit |
| Publication policy (DD-23) | No account IDs, hosts, IPs, credential IDs, revealing secret names, role IDs, Jenkins job names. Logical references and semantic IDs only. Extended to application repos' workflow files and CI logs (DD-24), except that the CI role ARN and the AWS account ID are owner-accepted in CI logs (G-10, design DD-24 v4.7); hosts, IPs, credential IDs, credentials and secret values stay forbidden |
| Commits | Only during execution phases |

### 4.2 Structure (K = keep, R = rework, D = delete, N = new; detail in §15)

```text
onecgiar-cicd-platform/
  .github/workflows/deploy-request.reusable.yml   N  CI contract (DD-29)
  docs/examples/caller-workflow.yml               N  caller template (OD-A6)
  executor/
    src/main                                      R  bootstrap; no /work, no instance lease
    src/inbound/sqs-consumer                      K  + requests SenderId, ApproximateReceiveCount
    src/application/{message-router N(from event-router R), sender-authorizer N, execution-service R,
                     deploy-coordinator N (replaces step-dispatcher D), deploy-window-service K,
                     reconciler K, notification-service K, definition-service R}
    src/domain/{state-machine R, request-contract N (from events R), lock-policy R,
                supersede-policy N, window-policy N, errors R}          planner D
    src/ports/  (artifact-store D, git-client D, step-handler D → deploy-transport N; others K)
    src/adapters/{dynamodb-state-store R, sqs-publisher K, secrets-manager-provider K,
                  ssh-deployer N (from handlers/ssh), notify/slack-provider K, bundled-definition-source K}
                  git-cli-client D  s3-artifact-store D  zip-packager D  handlers/{lambda,codebuild,notify} D
    src/observability/                            K
    scripts/guards/, scripts/inspect-image.mjs    R  retarget schemas; forbid git
    Dockerfile                                    R  drop git
  ingress/github-webhook/                         D
  deployment-definitions/prms/reporting-dev.yaml  R  (from pipeline-definitions/, flat)
  deployment-definitions/targets/dev.yaml         K  (moved)
  schemas/{deployment N (replaces pipeline D), deploy-request N, event R (internal only), targets K}.schema.json
  deploy-scripts/deploy-container.sh              R  --artifact by digest
  tools/                                          N  operator CLI: open/close deploy windows
  infra/RESOURCES.md                              R  OIDC provider, CI role, queue policy; no S3/CodeBuild/Lambda/ingress
  docs/{runbook R, resources R, jenkins-coexistence-log K}.md
```

---

## 5. Data Model

### 5.1 `cicd-executions-dev` (DynamoDB on-demand, TTL `expiresAt`)

| Item | PK | SK | Attributes | Write |
|---|---|---|---|---|
| Execution | `EXEC#{executionId}` | `META` | `deploymentId, definitionRef, requestId, commitSha, artifacts{unit:digest}, order{sourceRef, runNumber, runAttempt}, ci{repository, runId, workflowRef, runUrl}, senderRef, lockKey, sequence, status, version, dispatchToken, attempt, execStartedAt (per attempt; cleared at X9 and X14), fencingToken, lockWaitStartedAt, lockWaitAttempts, nextAttemptAt, contentionCount, lockLostDuringRun, targetWriteRejected, windowClosedDuringRun, cicdResultMissing, scriptChecksum, result{code, cicdResult, logTail}, error{code, message}, slackThreadTs, deadlineAt, activeStatus = EXECUTION (non-terminal only), startedAt, finishedAt, expiresAt (180 d)` | Conditional on `status` + `version` (§7.3). The write-once audit fields `scriptChecksum` (sha256 of the delivered script, FR-12) and `slackThreadTs` (Slack root reference) are set with `attribute_exists` + `attribute_not_exists(field)` and never touch `status` or `version` |
| Rejection | `REJECT#{deploymentId}#{requestId}`, or `REJECT#MSG#{sqsMessageId}` when either is unusable | `META` | `reason, senderRef, deploymentId?, receivedAt, expiresAt (30 d)` | `attribute_not_exists` |
| Dedupe | `DEDUPE#{deploymentId}#{requestId}` (scoped: `requestId` alone is unique only within a repository, P-G9) | `DEDUPE` | `state (CLAIMED/BOUND), claimToken, claimLeaseExpiresAt, sequence, executionId, expiresAt (7 d)` | DD-20 |
| Sequence | `DEPLOYMENT#{deploymentId}` | `SEQ` | `value` | Atomic `ADD` |
| Lock | `LOCK#{lockKey}` | `LOCK` | `owner, fencingToken, leaseExpiresAt, acquiredAt, expiresAt` | DD-09 |
| Target state | `TARGET#{lockKey}` | `STATE` | `currentImages{}, previousImages{}, lastDeployed{sourceRef, runNumber, commitSha, executionId}, highestDispatched{sourceRef, runNumber, executionId}, highestAccepted{sourceRef, runNumber, executionId}, unresolved[]{executionId, since}, updatedAt, version` | `lastDeployed`: conditional on lock owner + `fencingToken`. `highestDispatched`: written in the **same `TransactWriteItems` as the X9 intent** with condition `attribute_not_exists OR stored.runNumber <= new.runNumber` (equal is accepted: the same execution re-entering X9 after exit 50, and re-runs of the same run), never fenced (a lost lease cannot reject it). `highestAccepted`: conditional monotonic max (`attribute_not_exists OR stored.runNumber <= new.runNumber`), written by a **separate conditional update after X1 commits** (E2, §7.3), not in the X1 write. `unresolved[]`: appended **in the same `TransactWriteItems` as X16**, cleared only by the operator mechanism of runbook §12.2 |
| Deploy window | `WINDOW#{lockKey}` | `WINDOW` (+ `LOG#{openedAt}`) | As v3.2: `state, openedBy, openedAt, closesAt (≤ 8 h), externalJobsDisabled[], closedBy, closedReason, version`; while `OPEN`: `activeStatus = WINDOW`, `deadlineAt = closesAt` | Conditional on `state` + `version` |
| Event mark | `EXEC#{executionId}`; for a `REJECTED` notification (no Execution item exists) the rejection identity: `EXEC#REJECT#{deploymentId}#{requestId}` or `EXEC#REJECT#MSG#{sqsMessageId}` | `EVT#{eventKey}` (`eventKey` = notification kind; `DEPLOY_FAILED:{code}` for failures) | Notification already sent; `expiresAt` 7 d | `attribute_not_exists` |
| Resolution audit | `TARGET#{lockKey}` | `LOG#RESOLUTION#{eventId}` | `eventId, lockKey, executionId, resolvedBy, senderId? (role-ID prefix), observedDigests{}, note?, at, expiresAt (180 d)`. Written before the `unresolved[]` removal (runbook §12.2 step 6), so a crash leaves an audit entry without the removal, never the reverse | `attribute_not_exists` (idempotent per event) |

**Execution flags (as implemented):** `windowClosedDuringRun` is set when the post-exit window re-check (§7.7) finds the window closed; the outcome is unchanged. `cicdResultMissing` is set when the script exited with a code that guarantees `CICD_RESULT` (0/10/20/30/40) but none was parsed; `lastDeployed` is still written, while `TARGET.currentImages` is left untouched (never fabricated) and may lag `lastDeployed` (runbook §12.2).

**Removed:** Step items, Instance lease (`/work` exclusivity no longer exists), GSI1 (history is served by `executionId` lookups, CloudWatch and Slack; no requirement queries by deployment).

| Index | Key | Justification |
|---|---|---|
| GSI2 (sparse) | `activeStatus` (`EXECUTION`, `WINDOW`) + `deadlineAt` | The reconciler must find `QUEUED`/`WAITING_LOCK`/`DEPLOYING` executions past deadline and expired open windows **without scans** (FR-15; the T-08 harness forbids scans). The attribute is removed on terminal states and window closure, so the index holds only live items |

### 5.2 State on the target (v3.2 §5.3, plus the as-implemented Gate A details)

| Element | Location |
|---|---|
| Delivered script | `/tmp/cicd-{executionId}/deploy-container.sh` (deleted at the end). The Executor creates the directory **fresh with mode 0700** over SFTP; any pre-existing directory is refused (no exec, no removal). The script file is created with mode 0500 and read back for its checksum before exec (FR-12) |
| Result file | `/tmp/cicd-{executionId}.result.json`: written by the locked worker and read by the outer script to emit `CICD_RESULT`; removed by the Executor's best-effort cleanup together with the directory |
| Runtime configuration | `/tmp/cicd-{executionId}/runtime-<container>.env`, 0600, deleted at the end (T-14 accepted deviation) |
| Target mutex | Kernel `flock` on a per-`lockKey` file in a deploy-user directory; file holds `executionId`, `fencingToken`, PID, start time. Critical section ignores HUP. **The lock is the kernel's, not the file's existence** |
| Images | Current and previous kept by digest; older pruned |

---

## 6. Contracts

There is no orchestration API. Contracts are messages, schemas and a CLI.

### 6.1 Deploy request (`schemas/deploy-request.schema.json`)

| Field | Type / rule |
|---|---|
| `specVersion` | const `1` |
| `eventType` | const `DEPLOY_REQUESTED` |
| `requestId` | `^[0-9]{1,20}-[0-9]{1,4}$`; **must equal** `` `${ci.runId}-${ci.runAttempt}` `` (validated; mismatch → X2 `REJECTED (REQUEST_ID_MISMATCH)`) |
| `deploymentId` | `^[a-z0-9][a-z0-9-]{1,62}$` |
| `commitSha` | `^[0-9a-f]{40}$` |
| `artifacts` | object, 1–8 properties; key `^[a-z0-9][a-z0-9-]{0,31}$` (unit); value `^sha256:[0-9a-f]{64}$` |
| `ci.repository` | `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` (audit; must equal the definition's resolved source, consistency check only) |
| `ci.workflowRef` | string ≤ 256 (audit; consistency check against the bound workflow) |
| `ci.runId` | `^[0-9]{1,20}$` |
| `ci.runAttempt` | integer ≥ 1 |
| `ci.runNumber` | integer ≥ 1 — **ordering input under DD-27 (approved by the owner, 2026-10-06; inside the single source only)** |

`additionalProperties: false` at every level. Maximum body 8 KB. The `ci.*` fields never authorize anything (DD-25).

### 6.2 Deployment Definition (`schemas/deployment.schema.json`, replaces `pipeline.schema.json`)

| Field | Rule |
|---|---|
| `schemaVersion` | const `1` |
| `deploymentId` | semantic id (`prms-reporting-dev`) |
| `environment` | const `dev` in the PoC |
| `targetRef` | Target Registry entry |
| `source` | `{ repositoryRef, workflowRef, environmentRef }`: logical references resolved at startup (DD-23); define the **bound source** (DD-27) |
| `allowedSenderRef` | logical reference to the CI role identity (DD-25) |
| `deployScript` | enum of bundled scripts (`deploy-container.sh`) |
| `artifacts[]` | `{ unit, container, imageRepositoryRef }`; unit set must equal the request's |
| `runtimeSecretRefs` | per container; passed to the target as references, never resolved by the Executor |
| `migration` | optional `{ container, mode (ephemeral|temp-container), checkCommand, runCommand }`; requires the target's `migrationCompatibility` attestation |
| `health` | per container, command or URL |
| `timeoutMinutes` | ≤ 60 (PoC 20) |
| `notifications` | `{ slack: { channelRef, tokenRef } }` |

`additionalProperties: false`. **No** steps, `needs`, `when`, interpolation, expressions or reserved step types. Validation in CI and at startup; an invalid set prevents startup. **Fail fast (G-9, owner direction 2026-10-06, v4.7):** Deployment Definitions are trusted Executor configuration; at startup the Executor discovers every file under `deployment-definitions/`, parses and validates all of them, and on any unparsable file, file without `deploymentId`, duplicate `deploymentId` or validation failure it logs a safe error per file (path and reason, never content) and exits non-zero before any consumer, poller or SQS call starts. Under `deployment-definitions/` only regular directories and regular files named `*.yaml`/`*.yml` (lowercase) are allowed; a symbolic link, any other entry type, a wrong-case extension or any other file fails startup the same way. `npm run definitions:check` is a preflight only.

### 6.3 Target Registry (`schemas/targets.schema.json`, kept)

Unchanged from v3.2: `connectionRef`, `credentialRef` (existence-only at startup), `hostKeyRef` (mandatory), `lockKey`, logical containers and `portRef`, `deployWindowPolicy` + `externalDeployersRef | none` (§7.7), `migrationCompatibility` + `attestedBy`. Port and container-name conflicts per host rejected. **Added rule:** a `lockKey` may be referenced by **exactly one** `deploymentId` (bound source, DD-27).

### 6.4 Internal events (`schemas/event.schema.json`, reduced)

Envelope: `specVersion, eventId (UUID), eventType, timestamp, source ∈ {executor, scheduler, operator}`. **Exception (G-8, owner direction 2026-10-06, v4.7):** `RECONCILE_TICK` is a minimal internal contract `specVersion, eventType, source = scheduler, timestamp` and carries **no** `eventId` (a sender-supplied one is rejected); the Executor generates a correlation id inside its own boundary when it handles the tick. EventBridge Scheduler cannot produce a UUID, and no extra infrastructure is added for one.

| `eventType` | Fields | Allowed sender class (DD-25) |
|---|---|---|
| `LOCK_RETRY_REQUESTED` | `executionId, attempt` | Executor |
| `RECONCILE_TICK` | — (no `eventId`; correlation id generated by the Executor, G-8) | Scheduler |
| `DEPLOY_WINDOW_OPEN_REQUESTED` | `lockKey, openedBy, externalJobsDisabled[], closesAt, note?` | Operator |
| `DEPLOY_WINDOW_CLOSE_REQUESTED` | `lockKey, closedBy, note?` | Operator |
| `TARGET_RESOLUTION_RECORDED` | `lockKey, executionId, resolvedBy, observedDigests{}, note?` (runbook §12.2; removes the entry from `unresolved[]`, audit only) | Operator |

**Removed:** `PIPELINE_REQUESTED`, `QUALITY_*`, `BUILD_*`, `DEPLOYMENT_*`, `PIPELINE_*`, `STEP_RETRY_REQUESTED`; Lambda Destinations and EventBridge normalization; orphan-event handling.

### 6.5 Deploy script CLI (`deploy-container.sh`, generalized from v3.2 §6.4)

| Argument | Meaning |
|---|---|
| `--execution-id`, `--unit` | Temporary paths, logs. As implemented, `--unit` carries the execution's `deploymentId` (not an `artifacts[].unit` name; the name collision is listed as a spec gap for the owner) |
| `--artifact <container>=<repository>@sha256:<64-hex>` (repeatable) | **Replaces `--image`.** Repository from the definition's `imageRepositoryRef`; digest from the request. Anything else → usage exit 2 |
| `--previous <container>=<repository>@sha256:<digest>` (hint) | Authoritative source is the image the container is running at start; hint only if absent |
| `--lock-key`, `--fencing-token` | Target mutex identity |
| `--port <container>=<host:container>` | From the registry |
| `--runtime-secret <container>=<secretRef>` | Resolved by the target with its own permissions (OD-Q5) |
| `--migrate <container>`, `--migration-check`, `--migration-run`, `--migration-mode ephemeral|temp-container` | Migration before swap (DD-11; `--migration-mode` is a T-14 accepted deviation covering P-5) |
| `--health <container>=<cmd or url>` | Health check |

| Exit | Meaning |
|---|---|
| 0 | Success, including "already running these digests" (no swap, migration check finds nothing) |
| 10 / 20 / 30 / 40 | Pull / migration / start (restored) / health (restored) |
| 50 | `TARGET_BUSY`: mutex held; nothing done |
| 2 | Usage error (bad argument, tag instead of digest, identifier outside `[A-Za-z0-9._-]`); **no** `CICD_RESULT`. Maps to `UNKNOWN_TARGET_STATE` like any code outside 0/10/20/30/40/50 (RL-4, RL-7): the Executor cannot tell it from bash's own exit 2 after effects. Usage errors are prevented upstream by definition validation and the script's tests |

Last stdout line on 0/10/20/30/40/50: `CICD_RESULT {status, deployedImages, previousImages, migrations (APPLIED|NONE|FAILED), healthy, mutexHolder?}`. Accepted T-14 deviations kept: `--migration-mode`, `runtime-<container>.env`, usage exit 2, identifier charset validation.

### 6.6 Slack

Root message on `QUEUED`: `deploymentId`, `executionId`, short commit, GitHub run link. Thread replies: `SUPERSEDED`, `DEPLOY_WINDOW_CLOSED`, `LOCK_TIMEOUT`, failure codes, `UNKNOWN_TARGET_STATE` (with runbook link), success. Root updated with the outcome and duration. `REJECTED` goes to the platform channel (no per-definition channel may exist) with reason and sender **reference** only. Best-effort; `EVT#` marks prevent duplicates. CI failures are never posted by the Executor (OD-A5).

---

## 7. Backend Module Design

| Module | Responsibility | Requirements | Forbidden |
|---|---|---|---|
| `sqs-consumer` | Long-poll 20 s; requests `SenderId`, `ApproximateReceiveCount`; visibility heartbeat every 60 s; ack only on finish or recognized no-op | FR-04 | Business logic |
| `message-router` | Parse; unparseable → no ack (DLQ after 5); route by `eventType` | FR-04 | — |
| `sender-authorizer` | Maps `SenderId` role ID → principal class; per-type rule (§6.4); for `DEPLOY_REQUESTED`, role ID must equal the definition's resolved `allowedSenderRef` | FR-21 | Trusting any body field |
| `execution-service` | Schema validation → definition lookup → consistency checks → dedupe claim → sequence → create (X1) or reject (X2); `highestAccepted` update; S1 | FR-03, FR-07, FR-23 | — |
| `deploy-coordinator` | V1–V4, lock (DD-09), S2, intent (DD-28), semaphore, transport, mapping, fenced target-state write, release (§7.5) | FR-11, FR-12, FR-24 | Concatenating commands; aborting a running script; re-running |
| `deploy-window-service` | Open/close per §7.7; `isDeployAllowed(lockKey, needUntil)` | FR-24 | Jenkins knowledge |
| `reconciler` | Two GSI2 `Query`s per tick (`EXECUTION`, `WINDOW`, `deadlineAt < now`). **Re-drive:** an overdue `QUEUED` is re-evaluated (X3/X4/X5) and an overdue `WAITING_LOCK` with budget left gets a fresh `LOCK_RETRY_REQUESTED` for its current `attempt` (no state change); budget exhausted → X7; overdue `DEPLOYING` → X11 or X16 by `execStartedAt` | FR-15 | Scans; re-running scripts; CI state |
| `definition-service` | Loads via `DefinitionSource`; schema + semantic + registry rules; reference resolution (identifier refs resolved, credential refs existence-only) | FR-01, FR-02 | Reading secret values |
| `notification-service` | Slack provider; `EVT#` dedupe | FR-14 | Changing state |
| `observability` | JSON logger with redaction; EMF metrics; heartbeat | FR-17 | — |

### 7.1 Deadlines

| State | `deadlineAt` |
|---|---|
| `QUEUED` | created + 5 min (reconciler re-evaluates X3–X5, then schedules the first lock attempt) |
| `WAITING_LOCK` | `nextAttemptAt` + 2 min (set whenever a retry is scheduled; X5 sets `nextAttemptAt = now`). Overdue = the retry message was lost or never sent → reconciler re-drive. Order is always **persist `nextAttemptAt`, then send, then ack** |
| `DEPLOYING` | intent + `timeoutMinutes` + 5 min |

### 7.2 Failure mapping (implements FR-16)

| Origin | Outcome | Retry |
|---|---|---|
| Unparseable message / persistent processing error | DLQ after 5 receptions | SQS only |
| Schema, unknown deployment, consistency mismatch, `requestId` ≠ `ci.runId-ci.runAttempt`, unauthorized sender | `REJECTED (reason)` (X2) | 0 |
| Window invalid at V1–V4 | `FAILED (DEPLOY_WINDOW_CLOSED)` | 0 |
| Lock wait ≥ 1,800 s | `FAILED (LOCK_TIMEOUT)` (canonical, X7/X15) | 0 |
| SSH connect / host key | `FAILED (SSH_CONNECT)` after 2 retries before exec / `FAILED (HOST_KEY_MISMATCH)` | 2 / 0 |
| Exit 10/20/30/40 | `FAILED (PULL / MIGRATION / START / HEALTH)` | 0 |
| Exit 50 | `WAITING_LOCK` (X14), same budget | lock schedule |
| Other exit (incl. usage exit 2, RL-4), lost session after `execStartedAt`, crash after `execStartedAt` | `UNKNOWN_TARGET_STATE` | 0 |
| Crash in `DEPLOYING` before `execStartedAt` | `FAILED (DISPATCH_INTERRUPTED)` — script provably not started | 0 |

### 7.3 Execution state machine: closed list

General rule: **only** these transitions are valid. Every write is conditional on the source state and `version` (creations on `attribute_not_exists`). Terminal states (`SUCCEEDED, FAILED, SUPERSEDED, REJECTED, UNKNOWN_TARGET_STATE`) are immutable. Anything else is rejected and logged `INVALID_TRANSITION` with no effect.

| # | From | To | Guard / trigger | Conditional write |
|---|---|---|---|---|
| X1 | ∅ | `QUEUED` | Authorized sender, schema valid, `requestId` = `ci.runId-ci.runAttempt`, known `deploymentId`, consistency OK, dedupe claim on `{deploymentId, requestId}` owned (DD-20) | `attribute_not_exists` on `EXEC#`. `highestAccepted` is **not** a condition of X1 (E2): after X1 commits, a separate update raises it only when it is absent or `stored <= new`; a failed condition is the expected, error-free outcome for an older request, which then proceeds to S1 → X3 `SUPERSEDED` (FR-23). A crash between the two writes only delays S1; S2 stays authoritative |
| X2 | ∅ | `REJECTED` | Unauthorized sender, schema invalid, `requestId` mismatch, unknown `deploymentId` or consistency mismatch. Rejection record, **no sequence** (RL-5) | `attribute_not_exists` on `REJECT#` |
| X3 | `QUEUED` | `SUPERSEDED` | **S1** (DD-27): `TARGET.lastDeployed`, `TARGET.highestDispatched` or `TARGET.highestAccepted` is newer than this request | status + version |
| X4 | `QUEUED` | `FAILED (DEPLOY_WINDOW_CLOSED)` | **V1** fails | status + version |
| X5 | `QUEUED` | `WAITING_LOCK` | V1 OK; sets `lockWaitStartedAt`, `nextAttemptAt = now` | status + version |
| X6 | `WAITING_LOCK` | `SUPERSEDED` | **S2** under the lock (authoritative): `max(lastDeployed, highestDispatched)` is newer than this request; lock released | status + version (lock held) |
| X7 | `WAITING_LOCK` | `FAILED (LOCK_TIMEOUT)` | Wait ≥ 1,800 s — by handler or reconciler (**canonical**: both write the same result; one wins) | status + version |
| X8 | `WAITING_LOCK` | `FAILED (DEPLOY_WINDOW_CLOSED)` | **V2** fails on a retry | status + version |
| X9 | `WAITING_LOCK` | `DEPLOYING` | V2 OK, lock acquired (fencing token stored), S2 not superseded; new `dispatchToken`, `attempt+1`, **`execStartedAt` and per-attempt result fields cleared** (**intent**, DD-28 phase 1) | status + version, in one `TransactWriteItems` with `TARGET.highestDispatched` (condition `stored.runNumber <= new`; equal accepted for the same execution after exit 50 and for re-runs of the same run) (CS-2, R2-1) |
| X10 | `DEPLOYING` | `FAILED (DEPLOY_WINDOW_CLOSED)` | **V4** fails right before exec; no `execStartedAt` for the current `dispatchToken` | status + version + `dispatchToken` |
| X11 | `DEPLOYING` | `FAILED (SSH_CONNECT / HOST_KEY_MISMATCH / DISPATCH_INTERRUPTED)` | Before exec; no `execStartedAt` for the current `dispatchToken` (reconciler for `DISPATCH_INTERRUPTED`) | status + version + `dispatchToken` |
| X12 | `DEPLOYING` | `SUCCEEDED` | Exit 0 of the current `dispatchToken` | status + version + `dispatchToken` |
| X13 | `DEPLOYING` | `FAILED (PULL / MIGRATION / START / HEALTH)` | Exit 10/20/30/40 | status + version + `dispatchToken` |
| **X14** | **`DEPLOYING`** | **`WAITING_LOCK`** | **Only backward edge.** Exit 50 **and** V3 OK **and** budget remains; resources released; **`execStartedAt` and per-attempt fields cleared**, `nextAttemptAt` set | status + version + `dispatchToken` |
| X15 | `DEPLOYING` | `FAILED (LOCK_TIMEOUT / DEPLOY_WINDOW_CLOSED)` | Exit 50 and budget exhausted, or V3 fails | status + version + `dispatchToken` |
| X16 | `DEPLOYING` | `UNKNOWN_TARGET_STATE` | `execStartedAt` set for the current `dispatchToken` and: any other exit code (incl. 2), lost session, or `deadlineAt < now` (reconciler). Appends to `TARGET.unresolved[]` | status + version, in one `TransactWriteItems` with the `TARGET.unresolved[]` append (R2-8) |

**Crash recovery (CW-2):** a crash after X1 or X5 leaves no retry message; the redelivered request is a `BOUND` no-op. The GSI2 deadline (§7.1) makes the execution visible to the reconciler, which re-evaluates an overdue `QUEUED` through X3/X4/X5 and re-drives an overdue `WAITING_LOCK` with a fresh `LOCK_RETRY_REQUESTED` (no new transition). Recovery latency ≤ tick (5 min) + 2 min grace, drawn from the same lock-wait budget.

**When supersede is evaluated:** S1 at `QUEUED` (cheap, non-authoritative: may only skip, never deploy) and S2 at lock acquisition (authoritative). S2 compares against `max(lastDeployed, highestDispatched)`: `highestDispatched` records **every** ordering value that reached X9, whatever its outcome, and is written atomically with the intent, unfenced. So a newer execution that ends `UNKNOWN_TARGET_STATE`, or whose fenced `lastDeployed` write is rejected after a lost lease, still blocks every older request. **Not** re-checked right before SSH: `highestDispatched` only grows, and an older request cannot reach X9 after a newer one did.

**After `UNKNOWN_TARGET_STATE` or a lost lease (CS-2):** no older version deploys on that `lockKey` automatically, ever (`highestDispatched`). Newer requests proceed normally: the target mutex serializes physically, and the script restores from the image actually running (DD-11). Each X16 is listed in `TARGET.unresolved[]` and notified; the operator follows runbook §12.2 (verify the running digests, record the resolution, clear the entry). Deploying an older version on purpose is only possible through OD-A8. A success whose fenced write was rejected ends `SUCCEEDED` with `targetWriteRejected = true` and a notification.

**Dedupe and redelivery:** a redelivered `DEPLOY_REQUESTED` finds `DEDUPE` `BOUND` → no-op (recovery is the reconciler's). A redelivered `LOCK_RETRY_REQUESTED` with a stale `attempt` → no-op.

### 7.4 Removed: `/work` workspace

`/work`, its ownership rules and the instance lease are removed (no clone). The container mounts no working volume.

### 7.5 SSH resources: acquisition and release (kept)

Order: **window (V2) → distributed lock → S2 → intent → SSH semaphore (default 4) → session → SFTP → V4 → `execStartedAt` → exec → target mutex (by the script)**. Released in reverse on every exit.

| Exit | Target mutex | Session | Semaphore | Lock | State |
|---|---|---|---|---|---|
| 0 / 10 / 20 / 30 / 40 / other (incl. 2) | Released by the script / OS | Closed | Released | Released (owner-conditional) | X12 / X13 / X16 |
| Connect failure before exec | Never taken | n/a | Released | Released | X11 |
| 50 | Never taken | Closed | Released | Released | X14 or X15 (waiting holds **no** slot) |
| V4 fails | Never taken | Closed | Released | Released | X10 |
| Timeout with script running | Held by the script (ignores HUP) | Closed | Released | **Not released**: renewal stops, lease expires | X16 (runbook §12.1) |
| Executor crash | Held while the script lives | Cut | Gone (memory) | Lease expires | Reconciler: X16 if `execStartedAt`, else X11 |

### 7.6 Lock wait schedule (kept from v3.2)

Budget **1,800 s**; per-message delay ≤ **900 s** (P-22); schedule 30, 60, 120, 240, 480, 900 s; `delay = min(next, budget − (now − lockWaitStartedAt))` on persisted state.

| Attempt | Delay after failing | Planned accumulated wait |
|---|---|---|
| 1 (immediate after X5) | 30 s | 30 s |
| 2 | 60 s | 90 s |
| 3 | 120 s | 210 s |
| 4 | 240 s | 450 s |
| 5 | 480 s | 930 s |
| 6 | 870 s (capped) | 1,800 s |
| 7 | — | Fails → X7 `LOCK_TIMEOUT` |

Code 50 re-enters via X14 with the budget already consumed. Safety cap: 10 attempts in total → `LOCK_TIMEOUT`.

### 7.7 Deploy windows (kept; RL-1)

**Configuration safe by construction (R2-W2):** `externalDeployers` (versioned as `externalDeployersRef` or `none`) and `deployWindowPolicy` (`required | not-required`) are mandatory, no defaults. Reference ⇒ `required` only; **`none` ⇔ `not-required`** (owner amendment 2026-10-05). Validated in CI and at startup. Opening requires `openedBy` and `externalJobsDisabled[]` covering **all** resolved external deployers; maximum 8 h. The core compares opaque lists; no Jenkins logic.

**Revalidation (R2-W1)** with `needUntil = now + timeoutMinutes`:

| Point | Moment | If invalid |
|---|---|---|
| V1 | Entry, before waiting for the lock | X4 — **fail fast**, no waiting |
| V2 | Every lock attempt (incl. `LOCK_RETRY_REQUESTED`) | X8 |
| V3 | After exit 50, before requeuing | X15 |
| V4 | Immediately before exec (lock, slot, session held) | X10; all resources released |

If the window expires while the script runs: not aborted; `windowClosedDuringRun` + notification. Expired windows are closed by the reconciler via GSI2 (`activeStatus = WINDOW`), conditional on `state = OPEN` + `version`.

---

## 8. Frontend / UX

Not applicable. Operator surfaces: Slack, the GitHub run, CloudWatch Logs Insights (saved query by `executionId`), DynamoDB reads (runbook), `tools/` CLI for windows.

---

## 9. Shared Contracts

| Contract | File | Consumers |
|---|---|---|
| Deploy request | `schemas/deploy-request.schema.json` | Reusable workflow, Executor |
| Deployment Definition | `schemas/deployment.schema.json` | `definition-service`, authors, CI validation |
| Target Registry | `schemas/targets.schema.json` | `definition-service`, deploy-coordinator |
| Internal events | `schemas/event.schema.json` | Executor, `tools/`, Scheduler target |
| CI contract | `.github/workflows/deploy-request.reusable.yml` | Application caller workflows |
| Deploy script CLI | `deploy-scripts/deploy-container.sh` + runbook | deploy-coordinator; future P1 waves |

---

## 10. Design Decisions

### 10.1 Quality-attribute scenarios

| ID | Attribute | Stimulus | Measurable response | Tactics |
|---|---|---|---|---|
| QAS-1 | Reliability | A request delivered 2+ times or out of order | 0 duplicate executions, 0 second scripts, 0 invalid transitions over 100 injections | Conditional writes, dedupe claim, intent-then-act |
| QAS-2 | Availability | Container dies at any point | Every affected execution terminal ≤ deadline + 10 min; lock free ≤ lease | Stateless worker, reconciler, lease |
| QAS-3 | Performance | Valid request visible in the queue, lock free, window open | Script started ≤ 60 s p95 (NFR-05) | Long-poll, immediate first lock attempt |
| QAS-4 | Security | Foreign sender, tag, extra field, forged `ci.repository` | 100% `REJECTED`, 0 SSH sessions; 0 internal identifiers in a public CI log | Sender binding, strict schema, masking |
| QAS-5 | Ordering | Late older build, re-run of an older run, replayed message | 0 regressions over the injection suite (AC17) | Bound source, in-source order, fenced `lastDeployed` |
| QAS-6 | Modifiability | New P1 deployment | 0 Executor code lines; configuration only (image rebuild per DD-19) | Flat definitions, `DefinitionSource` |
| QAS-7 | Cost | PoC run | 0 new permanent compute; CI on standard hosted runners | Existing host, GitHub Actions |
| QAS-8 | Scalability | — | Not significant: bounded concurrency (NFR-04) | — |

**Tier:** LITE. Step Functions reconsideration signals: proposal §11.

### 10.2 Decisions kept (re-stated where Model B changes them)

| DD | Decision | Change in v4 |
|---|---|---|
| DD-01 | Hexagonal modular monolith, stateless worker | Fewer adapters (SSH, Slack, AWS state/queue/secrets) |
| DD-02 | One Standard queue + DLQ | "Normalization on receipt" removed; strict validation on receipt instead |
| DD-03 | DynamoDB single source of truth, optimistic concurrency | Unchanged |
| DD-04 | Intent-then-act with `dispatchToken` | SSH only; refined by DD-28 |
| DD-05 | Closed handler registry | **Reduced:** one `DeployTransport` port (SSH); no registry of step types |
| DD-09 | Lock with lease, fencing, bounded wait | Supersede moved to DD-27; lock unchanged |
| DD-10 | Script delivered via SFTP from the image | Unchanged |
| DD-11 | Generic script; migration before swap; backward-compatibility attestation | Images by digest (DD-26) |
| DD-12 | NotificationService with providers | Deploy lifecycle only |
| DD-13 | EventBridge **Scheduler** publishes `RECONCILE_TICK` every 5 min | Scope: deploy state and windows only (confirmed by the Leader). Minimal internal event without `eventId`; reconciliation is idempotent, so no event mark is needed (G-8, v4.7) |
| DD-14 | Visibility heartbeat | Only the deploy path is long |
| DD-15 | TypeScript, Node 22, no web framework | Unchanged |
| DD-16 | Executor AWS credentials via the SDK chain (OD-Q12 open) | Smaller permission set (§11.2) |
| DD-17 | Infrastructure as inventory until OD-Q7 | Inventory re-derived |
| DD-18 | Executor host parameterized (OD-Q11 open) | No `/work` volume |
| DD-19 | Definitions behind `DefinitionSource`, bundled in the image | Paths `deployment-definitions/`, `schemas/`, `deploy-scripts/`; an implementation never skips an invalid definition file or an unexpected entry silently (G-9, v4.7) |
| DD-20 | Dedupe with a leased claim | Key = `{deploymentId}#{requestId}` (deployment already bound by DD-25); `requestId` validated against `ci.runId-ci.runAttempt` (CC-2) |
| DD-21 | Per-target deploy windows | Fail-fast semantics kept (RL-1) |
| DD-22 | Target kernel mutex as second barrier | Unchanged; exit 50 → X14 |
| DD-23 | Real identifiers out of Git | Adds `allowedSenderRef`, `source.*Ref`, `imageRepositoryRef`; extends to CI logs (except the CI role ARN and account ID, owner-accepted, G-10 / DD-24 v4.7) |

### 10.3 Decisions removed by AC-01

| DD | Was | Reason |
|---|---|---|
| DD-06 | Planner as a pure function | No step graph |
| DD-07 | Async Lambda with a dedicated alias | No Lambda in the normal path |
| DD-08 | CodeBuild per app and environment | No CodeBuild in the normal path |

### DD-24 — OIDC trust model for CI
- **Problem:** CI in public repositories must get short-lived AWS rights without fork PRs, other branches, other repos, **other workflows or untrusted triggers** obtaining them (FR-25). The default environment `sub` does not carry the event: an environment job gets the environment form regardless of the trigger (P-A2). Deployment branch rules match `GITHUB_REF`, and `pull_request_target` and `workflow_run` run with `GITHUB_REF` = the default branch and with access to secrets (P-G2). The `sub` string format also changes for repositories created, renamed or transferred after 2026-07-15 (immutable format with owner and repository IDs, P-G10).
- **Decision (round 2, simplified):** bind the identity through the GitHub claims that IAM exposes **directly** as condition keys (P-G6), and keep the event control inside the pinned workflow.
  1. **Trust policy**, exact `StringEquals` on every key (never `StringLike`):

```text
Principal: Federated = <GITHUB_OIDC_PROVIDER>
Action:    sts:AssumeRoleWithWebIdentity
Condition: StringEquals <GITHUB_OIDC_ISSUER>:aud                 = <STS_AUDIENCE>
           StringEquals <GITHUB_OIDC_ISSUER>:repository_id       = <PRMS_REPORTING_REPO_ID>
           StringEquals <GITHUB_OIDC_ISSUER>:repository_owner_id = <GITHUB_ORG_ID>
           StringEquals <GITHUB_OIDC_ISSUER>:environment         = <GITHUB_ENVIRONMENT>
           StringEquals <GITHUB_OIDC_ISSUER>:job_workflow_ref    = <GITHUB_ORG>/<PLATFORM_REPO>/.github/workflows/deploy-request.reusable.yml@<PINNED_IMMUTABLE_REF>
           StringEquals <GITHUB_OIDC_ISSUER>:sub                 = <ENVIRONMENT_FORM_SUB>
MaxSessionDuration: 1 h
```

     - `repository_id` and `repository_owner_id` are immutable IDs: robust to rename and transfer (P-G10). They are logical placeholders here and resolved outside Git (DD-23).
     - `job_workflow_ref` admits only jobs **inside the platform reusable workflow at the pinned ref**; a job written directly in a caller, or the reusable workflow at another ref, does not match. The pin must be **immutable** (a commit SHA), so the trust cannot follow a moved tag or branch; the security binding therefore uses a commit SHA, never a tag or branch (Leader round-2 direction, confirmed by the owner on 2026-10-06; OD-A6 otherwise stays open). The exact claim value for a SHA-pinned call is P-G11 (`UNVERIFIED`, observed in N-24/N-32). Moving the pin requires changing the trust policy in the same change.
     - `sub` is kept as a redundant check with the **default** environment-form value. Which string format applies to the repository (previous or immutable, P-G10) is observed at N-24; the binding does not depend on it because the ID, environment and workflow keys already carry it.
     - **No custom subject template is needed** (the round-1 template is dropped): every claim we bind is a direct IAM key. `event_name` is **not** an IAM condition key (P-G6), so P-G4 is moot for IAM.
  2. **Event and branch allowlist inside the pinned reusable workflow:** a first `guard` job fails unless `github.event_name` ∈ {`push`, `workflow_dispatch`}; the Environment job `needs: guard`, and its **first step**, before any step that requests an OIDC token, fails unless `github.ref` equals the bound ref **for both events**. **Trusted source of the bound ref (E1):** the Environment-scoped configuration variable `CICD_BOUND_REF`, which only repository administrators can create or change (P-G13); it is visible only to the Environment-bound job, which is why the ref check runs there (P-G14). It is never a workflow input and never read from the request body, the caller's files or a repository-level variable (repository variables need only `write` access, P-G13). A missing or empty value fails the check (fail closed). No new trusted party is added: repository administrators are already inside the trust boundary (Residual below), and the Environment's deployment branch rules enforce the same branch where the plan supports them (P-G7). In a called workflow the `github` context is the caller's (P-G5); because `job_workflow_ref` pins the workflow, a caller cannot remove the check. This is the **only** event control.

  Permissions: `ecr:GetAuthorizationToken`; layer upload and `PutImage` on **its** `<ECR_REPOSITORY>` repositories only; `sqs:SendMessage` and `sqs:GetQueueUrl` on `cicd-events-dev` only (`GetQueueUrl` since v4.6: the queue URL is derived after OIDC). Nothing else.
- **GitHub side:** the Environment job declares `environment: <GITHUB_ENVIRONMENT>`; deployment branch rules = the bound branch; production environments (later waves) add required reviewers. **Value classification (owner direction, 2026-10-06, v4.6; replaces the v4.x rule that role ARN, registry and queue URL are all secrets):** **v4.7 (owner direction, 2026-10-06, B0 acceptance — G-10):** the GitHub configuration holds **no secret at all**. The role ARN is an Environment **variable** (`CICD_ROLE_ARN`): it is not a credential, and access is controlled by the OIDC trust conditions, not by hiding the ARN. Region, ECR repository name, queue name and the admin-only bound ref are Environment variables too. The registry host and the queue URL are **derived after OIDC** (registry-login output, `sqs get-queue-url`). The role ARN, and with it the AWS account ID, **can appear in public workflow logs** (accepted by the owner; neither is a credential); masking of derived values is log hygiene, not a confidentiality control. No static AWS access key exists anywhere: AWS authentication from GitHub is OIDC only. (v4.6 had kept the role ARN as the only secret.) Environment protection depends on the organization's plan (P-G7, OD-A9).
- **Rejected:** environment-only `sub` (admits `pull_request_target`/`workflow_run` on the default branch); custom subject template (unnecessary once the claims are direct keys); branch-based `sub`; `StringLike`/wildcards; static keys; relying on P-A3.
- **Residual:** repo admins can weaken branch/Environment rules (proposal §13.4); GitHub issuer compromise is bounded to ECR push + SQS send.

### DD-25 — Sender binding per message type (OD-A2: **APPROVED by the owner, 2026-10-06**)
- **Problem:** the queue accepts messages from several principals; a request for `deploymentId` Y must come only from Y's CI role (FR-21).
- **Decision:** the consumer requests the `SenderId` system attribute (P-A4: `ROLEID:session` for roles). The authorizer takes the role-ID prefix and maps it to a principal class using **resolved references**:
  - `allowedSenderRef` (per definition) and `executorPrincipalRef`, `schedulerPrincipalRef`, `operatorPrincipalRef` (platform config) resolve at startup, through `SecretProvider` as **non-sensitive identifier references** (DD-23), to role IDs. No role ID or ARN is committed.
  - Per-type rule: `DEPLOY_REQUESTED` ← the definition's `allowedSender` only; `LOCK_RETRY_REQUESTED` ← Executor; `RECONCILE_TICK` ← scheduler; `DEPLOY_WINDOW_*` ← operator.
  - Mismatch → X2 `REJECTED (UNAUTHORIZED_SENDER)`, metric + alarm, ack.
- **Defense in depth:** a queue policy allowing `SendMessage` only to those principals.
- **Fail-closed:** a recreated role gets a new role ID → requests are rejected and alarmed until the reference is updated.
- **Owner approval (2026-10-06), binding statements:**
  - Authorization uses the **AWS-provided sender identity** (the role ID in `SenderId`) and the **trusted `allowedSender` binding** resolved from configuration.
  - **Caller-controlled session names are never an authorization input**; the `SenderId` suffix is logged as untrusted audit data only.
  - A CI sender is authorized **only for the event types and the `deploymentId` values explicitly assigned to it**; anything else is `REJECTED (UNAUTHORIZED_SENDER)`.
- **Alternatives evaluated:** payload signature (needs a signing key in GitHub — a new secret in public repos); one queue per repository (more resources; still needs binding inside). Both rejected for the PoC.

### DD-26 — Immutable artifact identity
- **Decision:** the request carries digests only (`sha256:<64-hex>`); the Executor builds `<repository from imageRepositoryRef>@<digest>` and passes it as `--artifact`; the script rejects anything else (exit 2) and pulls by digest. Previous images are recorded by digest.
- **Consequence:** tags are irrelevant to deploys. Tag immutability on the shared repository stays OD-A7. CI must not push tags colliding with Jenkins's integer tags (FR-22; P-16).

### DD-27 — Supersede ordering (OD-A1: **APPROVED for the PoC by the owner, 2026-10-06, under the single-source invariant**)

**Safety goal (FR-23):** an older build that finishes or is re-run later never replaces a newer deployment of the same `lockKey`.

**Evaluation of the five candidates:**

| Criterion | (a) SHA + ancestry | (b) Run metadata (`run_number`) | (c) Executor sequence | (d) Commit timestamp | (e) Bound source |
|---|---|---|---|---|---|
| Late older build | Correct | Correct within one workflow | **Fails**: arrival order | Unreliable | Needs an in-source key |
| Re-run of an older run | Correct | Correct (P-A6 VERIFIED) | **Fails** | Same commit time → tie | Inherits the key |
| `workflow_dispatch` of an old commit | Correct (older in history) | Gets a new, higher number → **would deploy old code**. Mitigated if Environment branch rules allow only the protected branch, whose dispatch builds its head | Fails | Correct only if clocks honest | Inherits |
| Several repos/workflows per `lockKey` | Incomparable across repos | Not comparable across workflows | Arrival only | Client clocks | **Defines it: one source per `lockKey`** |
| No new Executor credential | **No**: GitHub API access returns (removed from egress) | Yes | Yes | Yes | Yes |
| Works with sender binding | Yes | Yes | Yes | Yes | **Strengthens it** (one role ↔ one source) |
| Testable locally | Needs a repo fixture | Yes | Yes | Yes | Yes |
| Simplicity | Low | High | High | High | High |
| Rests on | GitHub API availability | **P-A6 (VERIFIED at source; P-G12 rename reset UNVERIFIED)** | — | Client-set dates | Definition validation |

**Decision (owner approval 2026-10-06): (e) + (b) under the single-source invariant.**

| Invariant (owner) | Rule |
|---|---|
| One deployment per lock | Exactly one `deploymentId` per `lockKey` |
| One source per deployment | Exactly one trusted GitHub source per `deploymentId`; source identity = repository + workflow + environment + allowed sender |
| In-source order | `ci.runNumber` orders runs **inside that source only**; an equal `runNumber` is the same logical run or a re-run, not older |
| Acceptance | `highestAccepted` protects acceptance (S1) |
| Deployment | `highestDispatched` protects deployment once X9 is reached (S2) |
| Safety | An older run never deploys after a newer run reached the deployment intent boundary (X9) |
| Scope | **Multi-source ordering is out of the PoC.** If a future architecture lets several repositories or sources deploy one `lockKey`, DD-27 must be revisited, and `runNumber` values must **never** be compared across sources |
| Rename / reset | Accepted **fail-safe limitation**: if the trusted workflow is renamed or its counter resets, deploys stop (newer-looking-older runs are superseded) rather than risk an older deploy. Renaming or rebinding the trusted workflow requires the future audited OD-A8 procedure |

Implementation detail of the approved decision:
1. **Bound source:** each `lockKey` is served by exactly one `deploymentId`; each `deploymentId` is bound to one source (`repositoryRef`, `workflowRef`, `environmentRef`) and one `allowedSender`. Validated at startup (§6.3). The request's `ci.repository` and `ci.workflowRef` must match the resolved source (consistency check; authorization is DD-25).
2. **In-source order:** `ci.runNumber`. Newer ⇔ higher `runNumber`; equal (re-run of the same run) ⇒ not older: deploys and the script's idempotent path applies.
3. **Where:** `highestAccepted` (monotonic, raised by a separate update right after X1) feeds S1; S2 uses `max(lastDeployed, highestDispatched)`, where `highestDispatched` is written atomically with every X9 intent and is never fenced (CS-2). Outcome of the newer dispatch does not matter: once a newer value reached X9, no older one deploys.
4. **Guard rails:** Environment deployment branch rules = one protected branch, so runs of the source build that branch's head; an older version can be redeployed only through OD-A8.

**Residual risks:**

| Risk | Effect | Mitigation |
|---|---|---|
| Re-run behavior of `run_number` | A re-run of an older run must not look newer | P-A6 VERIFIED at source ("does not change if you re-run"); AC17 keeps a real re-run as E2E confirmation |
| `runNumber` is body-asserted | A compromised CI role could send a high number: regression of **its own** deployment, or blocking later runs | Bounded by DD-25 to one deployment; alarm on gaps > N; resetting `TARGET` order is an operator override that exists only if OD-A8 (open) defines it; not available in the PoC |
| Workflow renamed or recreated (counter may restart; UNVERIFIED) | New runs look older and are superseded: deploys stop | **Accepted fail-safe limitation (owner, 2026-10-06).** Renaming or rebinding the trusted workflow requires the future audited OD-A8 procedure (P-G12) |
| Several branches or sources deploying one unit (today's 8 Jenkins variants, C8) | Not expressible | **Out of the PoC (owner).** Only one source per `lockKey`; Jenkins variants stay disabled in windows. A multi-source architecture requires revisiting DD-27; `runNumber` is never compared across sources |
| A newer request that was accepted (S1) or dispatched (S2) later fails, or ends `UNKNOWN_TARGET_STATE` | Older requests stay superseded; nothing older deploys | Safe direction; the operator verifies (runbook §12.2) and re-runs the newest workflow |

### DD-28 — Two-phase intent before the remote exec
- **Problem:** after a crash, the Executor must know whether the script may have started (FR-07, FR-16).
- **Decision:** phase 1 (X9) records `dispatchToken`; phase 2 writes `execStartedAt` (conditional on the token) **immediately before** exec. Recovery: `execStartedAt` absent ⇒ script provably not started ⇒ X11 `DISPATCH_INTERRUPTED`; present ⇒ X16 `UNKNOWN_TARGET_STATE`. Never re-run automatically.

### DD-29 — Reusable workflow owned by the platform repo
- **Decision:** `.github/workflows/deploy-request.reusable.yml` implements FR-22: inputs (`deploymentId`, build contexts per unit), a `guard` job enforcing the event allowlist and an Environment-job first step enforcing the bound ref from `CICD_BOUND_REF` for `push` and `workflow_dispatch` (DD-24 item 2, E1), Environment-bound job, OIDC, build + push, digest capture from the local image's `RepoDigests` (`docker inspect`), one `aws sqs send-message` of a schema-valid body with `requestId = ${run_id}-${run_attempt}`, no GitHub secret: the role ARN is an Environment variable, registry and queue URL are derived after OIDC (DD-24 v4.7). Callers call it at the immutable commit SHA that the trust policy's `job_workflow_ref` pins (DD-24); a tag or branch reference does not match the trust and is not used for this workflow (owner direction, 2026-10-06). OD-A6 keeps open the approval to add callers to application repositories (E5). Statically validated in Gate A; first real run in Gate C (N-32).
- **Action pinning (owner security rule, 2026-10-06):** every GitHub Action referenced inside the trusted reusable workflow — third-party **and** GitHub-owned, `uses: owner/repo[/path]@ref` — is pinned by an **immutable full 40-hex commit SHA**, with the human-readable version as a trailing comment **where useful** (owner wording; the comment is informative and not enforced by guard 7) (e.g. `uses: <owner>/<action>@<40-hex-sha> # v4.1.0`). Mutable refs (`@main`, `@master`, branches, tags including `@v4`) are **prohibited**. `docker://` references must be pinned by image digest (`@sha256:<64-hex>`). Local `./` references are the only exemption. This matters most for the steps that obtain AWS credentials via OIDC, log in to and publish to ECR, handle artifacts that influence the request, and build or send `DEPLOY_REQUESTED`: a moved tag there would change trusted code without changing `job_workflow_ref`. Enforced by the static **guard 7 "action-pinning"** (N-19), which scans `.github/workflows/*.reusable.yml` (and `*.reusable.yaml`) and fails on any non-compliant `uses:`.
- **Rejected:** per-repo copies (drift); deploy logic in the workflow (option C, proposal §11); tag-pinned actions (mutable).

### 10.4 Reversal challenge

| Delivered behavior reverted | What breaks | Answer |
|---|---|---|
| Jenkins builds on its host | Nothing in the PoC; CI moves to GitHub | DD-29 |
| `docker rmi N-1` on the target | Disk growth | Pruning keeps current + previous (DD-11) |
| `aws configure set` on the target | Jobs relying on leftover keys | Keys not deleted (NFR-10); script avoids them (OD-Q5) |
| Writes to `<JENKINS_EXECUTIONS_TABLE>` | Unknown consumers | OD-Q14; accepted for the PoC |
| Kill → migrate → run | Nothing; availability improves | DD-11 |
| Mutable tags drive deploys | Jenkins jobs keep using tags; the PoC ignores them | DD-26 |

---

## 11. Security Design

### 11.1 Trust boundary summary

| Control | Where | DD |
|---|---|---|
| Trust policy: exact `StringEquals` on `aud`, `repository_id`, `repository_owner_id`, `environment`, `job_workflow_ref` (pinned platform reusable workflow at an immutable SHA) and the default environment-form `sub`; no wildcard; no custom subject template | IAM trust policy | DD-24 |
| Event allowlist (`push` or `workflow_dispatch`, both only on the bound ref) in the pinned reusable workflow; `pull_request`, `pull_request_target`, `workflow_run` rejected | Reusable workflow | DD-24, DD-29 |
| CI role: ECR push to its repos + `SendMessage` | IAM | DD-24 |
| Queue policy: only CI roles, Executor, scheduler, operator principals | SQS | DD-25 |
| Sender binding per message type, fail-closed | Executor | DD-25 |
| Strict schema; digest only; repository from config | Executor + script | DD-26 |
| Every action in the trusted reusable workflow pinned by a full commit SHA (`docker://` by digest; `./` exempt); guard 7 | Reusable workflow + guards | DD-29 |
| Dedupe on `{deploymentId, requestId}` with `requestId` validated against `ci.*`; replay after dedupe TTL is still safe (same digests → idempotent; older `runNumber` → `SUPERSEDED`) | Executor | DD-20, DD-27 |
| Production approval: GitHub Environment required reviewers **before** the request exists; Executor deploy windows **after**. No approval engine in the Executor | GitHub / Executor | DD-21, DD-24 |
| Public CI logs: no credential and no GitHub secret; the role ARN (a variable) and the account ID may appear in logs (owner-accepted, DD-24 v4.7); registry and queue URL derived after OIDC; `publication-policy` guard also scans workflow files | GitHub / guards | DD-23 |

### 11.2 Executor permissions (DEV)

`sqs:ReceiveMessage/DeleteMessage/ChangeMessageVisibility/SendMessage` (own queue; `SendMessage` for lock retries); DynamoDB item operations + `Query` on GSI2 of its table; `secretsmanager:GetSecretValue` on the SSH credential, Slack token and identifier references; `DescribeSecret` for existence checks; CloudWatch logs/metrics. **No** S3, Lambda, CodeBuild, ECR, IAM, GitHub.

---

## 12. Risks, Observability, Rollback

| Topic | Design |
|---|---|
| Observability | Logs carry `executionId, requestId, deploymentId`. EMF namespace `CicdExecutor`; metric names **as implemented** (`executor/src/observability/metrics`): `ExecutionsStarted` (at acceptance, X1; named `ExecutionsAccepted` before v4.5), `ExecutionsSucceeded`, `ExecutionsFailed` (`FAILED` and `UNKNOWN_TARGET_STATE`), `RejectedRequests{reason}` (any X2 reason), `NotificationFailures{provider}` (FR-14: counted and logged, never state-changing), `ExecutorHeartbeat` (no dimensions, each minute), `ExecutionsPastDeadline` (FR-17; no dimensions; emitted by the reconciler on every tick, 0 included, counting overdue `EXECUTION` items of the GSI2 sweep; expired windows are closed, not counted). `LockWaitMs` and `DispatchLatencyMs` (NFR-05) exist as recorders but have no caller in Gate A. `ExecutionsSuperseded` and `DeployDurationMs` (listed up to v4.4) are not implemented (spec gap for the owner). Alarms: DLQ > 0, oldest message > 10 min, no `ExecutorHeartbeat` for 5 min, `RejectedRequests{reason=UNAUTHORIZED_SENDER}` > 0, `ExecutionsPastDeadline` > 0 (FR-17) |
| Liveness | Heartbeat metric each minute + healthcheck file; no exposed ports |
| Redaction | Tokens, `password`, `secret`, PEM keys, presigned URLs |
| Shared DEV DB (P-24) | Real deploys only in a DD-21 window; snapshot before the first test; migration state recorded before/after |
| Non-backward-compatible migrations (P-23) | No automatic migrations without the attestation (DD-11) |
| Lease lost during SSH | DD-22 mutex; `lockLostDuringRun`; fencing rejects the stale target write; notification |
| PoC rollback | Jenkins intact; jobs re-enabled; `cicd-poc` resources destroyed; automatic restore of the previous image only inside the script on start/health failure (FR-13, codes 30/40); an operator redeploy of an older digest is **OD-A8 (open), not available in the PoC**; otherwise redeploy via Jenkins during a window |

### 12.1 Runbook: possibly stuck target mutex (kept, R2-I4)

**Principle:** the mutex is the **kernel's lock**. If its holder died, the OS released it. **Never delete the lock file to "release" it.**

| Step | Evidence | Indicates |
|---|---|---|
| 1 | Repeated `TARGET_BUSY`, `LOCK_TIMEOUT` with `contentionCount > 0`, or `UNKNOWN_TARGET_STATE` | Look at the target |
| 2 | Lock file content: `executionId`, `fencingToken`, PID, start | Who claims it |
| 3 | Is the lock taken? (lock listing or non-blocking test attempt) | Not taken → residual file, harmless |
| 4 | PID alive and the deploy script (pull, migration container, `docker run`)? | Alive → active deploy |
| 5 | DynamoDB state (`DEPLOYING`, `execStartedAt`, `lockLostDuringRun`) and logs | Last contact; session cut? |
| 6 | Real progress vs `timeoutMinutes` | Advancing → wait; none for > 2× timeout → stuck |

| Case | Action |
|---|---|
| Active deploy | Do nothing; record in the coexistence log |
| Stuck, no migration in progress | Terminate the script orderly (TERM first); verify running images; restore previous with the script if needed |
| Stuck with a migration in progress | **Escalate** to the application team and DB owner before acting |
| After any intervention | Record who/when/evidence; trigger a **new** deploy (re-run or dispatch the workflow); never replay the old request by hand |

### 12.2 Runbook: resolve `UNKNOWN_TARGET_STATE` or a rejected target write (CS-2)

**Invariant while unresolved:** no older version deploys on the `lockKey` (`highestDispatched`, §7.3). Newer requests may proceed; the target mutex and the script's "restore from the running image" keep them safe.

| Step | Operator action | Evidence recorded |
|---|---|---|
| 1 | From the notification, read `executionId`, `lockKey`, `execStartedAt`, `lockLostDuringRun`, `targetWriteRejected` | DynamoDB execution item |
| 2 | Run §12.1 steps 2–4: is the script still running? If yes, wait for it to end | Process and lock evidence |
| 3 | On the target, list the digest each unit's container is running and compare with the execution's `artifacts` and the previous digests | Digests (logical names only in Git) |
| 4 | If a migration may have run, check migration state read-only (`migration:check:ci`) and escalate to the application team on any doubt | Migration state |
| 5 | Decide: target healthy on the new digests, healthy on the previous ones, or broken. If broken: re-run the **newest** workflow (a newer-or-equal deploy; the script restores automatically on start/health failure, FR-13) or escalate. Deploying an older digest on purpose is **OD-A8 (open)** and not available in the PoC | Decision and actor |
| 6 | Record the resolution with the operator CLI (`tools/resolve-target --lock-key <k> --execution-id <id> --observed <unit>=<digest>…`), which sends `TARGET_RESOLUTION_RECORDED`. **Who:** the operator principal only (DD-25 per-type binding; any other sender is `REJECTED`). **Preconditions** (checked by the Executor): the execution is `UNKNOWN_TARGET_STATE` and listed in `unresolved[]`; the `lockKey` has no live lock owner. **Effect:** removes that entry (conditional write) and writes an audit `LOG#RESOLUTION#{eventId}` item under `TARGET#{lockKey}` (§5.1; actor = `SenderId` role + `resolvedBy`, time, observed digests). It **never** edits `lastDeployed`, `highestDispatched`, `highestAccepted` or any terminal state; resetting order is OD-A8 | `LOG#` audit entry; coexistence log line |

---

## 13. Premise Ledger

**Count:** verified 15 (P-A1, P-A2 corrected, P-A4, P-A6, P-G2, P-G3, P-G5, P-G6 corrected, P-G8, P-G9, P-G10, P-G13, P-20h, P-25, P-26) · `UNVERIFIED` 25 (incl. P-G4 moot, P-G7 organization plan, P-G11, P-G12, P-G14). Rows P-G2…P-G9 added in the JD round-1 correction. Rows needed only by Lambda/CodeBuild/source (P-1, P-2, P-10, P-15, P-17, P-18) and P-21 (naming) are dropped. Blast-radius triggers: `shared-state` P-13, P-14, P-24; `consumer` P-16.

| # | Claim | Status | If false | Settled by |
|---|---|---|---|---|
| P-A1 | Standard hosted runners free on public repos | VERIFIED (AC-01 §3) | Cost only | — |
| P-A2 | **Corrected (JD round 1):** the default `sub` includes `pull_request` "only if the job doesn't reference an environment"; when a job references an environment, the environment form is used **regardless of the triggering event**. `id-token: write` is required | VERIFIED [GH-OIDC] (read 2026-10-06) | — (the corrected reading is what DD-24 now designs for) | — |
| P-A3 | Fork `pull_request` runs get no OIDC token or secrets | `UNVERIFIED — confirm at source before relying on it` | None: DD-24 does not rely on it | Design-time pin of the primary GitHub statement |
| P-A4 | SQS returns `SenderId` (`ROLEID:session`) for roles | VERIFIED (AC-01 §3) | DD-25 (approved) would need re-decision with the owner (High) | Real format check at Gate B |
| P-A5 | Repositories in scope are public | `UNVERIFIED — confirm at source before relying on it` | **High:** for a private repo, Environment protection depends on the plan (P-G7). On a plan without environments for private repos, DD-24 cannot be configured and must be redesigned; otherwise cost changes too | OD-A9, Gate B (N-29); re-checked at Gate C (N-32) |
| P-A6 | `run_number` increases per run and is unchanged on re-run: "A unique number for each run of a particular workflow in a repository. This number begins at 1 for the workflow's first run, and increments with each new run. This number does not change if you re-run the workflow run." | VERIFIED [GH-CTX] (read 2026-10-06). The AC17 real re-run stays as an E2E check | — | — |
| P-A7 | Public repo logs and workflow files are readable by anyone | `UNVERIFIED — confirm at source before relying on it` (treated as true) | Over-masking only (Low) | — |
| P-G2 | Deployment branch rules are matched against the run's `GITHUB_REF`; `pull_request_target` and `workflow_run` run with `GITHUB_REF` = the default branch and can access secrets and write tokens | VERIFIED [GH-ENV], [GH-EVT] (read 2026-10-06) | — | — |
| P-G3 | The OIDC subject can be customized per organization or repository through the REST API; documented `include_claim_keys`: `repo`, `context`, `job_workflow_ref`, `repository_owner`, `repository_visibility`, `repository_id`, `repository_owner_id`, `environment`, `repo_property_*`; `job_workflow_ref` is the ref path of the reusable workflow; example `repo:…:environment:…:job_workflow_ref:<owner>/<repo>/.github/workflows/<file>@<ref>`; repositories can opt out (`use_default`) | VERIFIED [GH-OIDC] (read 2026-10-06) | — | **Not used** after round 2: DD-24 binds direct IAM keys, no custom template |
| P-G4 | The triggering event (`event_name`) can be included in a custom subject template | `UNVERIFIED — confirm at source before relying on it` | **Moot for IAM:** `event_name` is not an IAM condition key (P-G6) and DD-24 uses no custom template; the event control is the guard job | — |
| P-G5 | In a called (reusable) workflow, the `github` context is the caller's; reusable workflows can be referenced by SHA, tag or branch | VERIFIED [GH-REUSE] (read 2026-10-06) | — | — |
| P-G6 | **Corrected (round 2):** for the GitHub provider, IAM exposes these trust-policy condition keys: Default tab `aud`, `sub`, `amr` (also `email`, `oaud`); **GitHub tab** `actor`, `actor_id`, `job_workflow_ref`, `repository`, `repository_id`, `repository_owner_id`, `workflow`, `ref`, `environment`, `enterprise_id`, all with string operators and not available in session. `event_name` is **not** a key | VERIFIED [AWS-IAM-CK], section "Available keys for AWS OIDC federation", Default and GitHub tabs (read 2026-10-06) | DD-24 binding redesign (High) | — |
| P-G7 | The organization's GitHub plan supports Environment protection for every in-scope repository: deployment branch rules and environment secrets (all public repos; private only on Pro/Team/Enterprise), required reviewers (public on all plans; private only on Enterprise); on Free, environments exist only for public repos, and converting a repo to private makes protection rules and environment secrets be ignored | Plan facts VERIFIED [GH-ENV], [GH-ENV-HOWTO]; **the organization's actual plan and repo visibility: `UNVERIFIED — confirm at source before relying on it`** | **Medium:** the IAM binding (IDs, `job_workflow_ref`) and the guard's bound-ref check still hold. Lost: GitHub-side deployment branch gating and environment-scoped secrets (secrets move to repository scope); required reviewers for private repos only on Enterprise. Whether the `environment` claim is still issued when environments cannot be configured is `UNVERIFIED`. Owner decides at OD-A9 before Gate C | OD-A9, Gate B (N-29); re-checked after any visibility change and at Gate C (N-32) |
| P-G8 | GitHub configuration variables render unmasked in build outputs; secrets are the masked mechanism | VERIFIED [GH-VARS] (read 2026-10-06) | — | Since DD-24 v4.7 the role ARN is deliberately a variable (owner-accepted visibility); the contract test enforces that no secret and no credential exist |
| P-G9 | `run_id` is unique per workflow run **within a repository** and does not change on re-run; `run_attempt` starts at 1 and increments per re-run | VERIFIED [GH-CTX] (read 2026-10-06) | — | Basis of the CC-2 dedupe scope |
| P-G10 | Repositories created after July 15, 2026 use an immutable default subject format with owner and repository IDs (`repo:<owner>@<owner_id>/<repo>@<repo_id>:…`); renames and transfers after that date also move to it; older repositories keep the previous format unless opted in | VERIFIED [GH-OIDC] (read 2026-10-06). Which format `<PRMS_REPORTING_REPO>` uses: `UNVERIFIED — confirm at source before relying on it` | Only the redundant `sub` value changes; the binding rests on ID keys (Low) | N-24 records the observed format |
| P-G11 | The `job_workflow_ref` value of a job in a reusable workflow called by commit SHA is `<owner>/<repo>/.github/workflows/<file>@<sha>` | `UNVERIFIED — confirm at source before relying on it` (the documented example shows `@refs/heads/main`) | Trust value adjusted to the observed form (Low) | N-24 (pin), N-32 (observed in a real token) |
| P-G12 | `run_number` restarts when the bound workflow file is renamed or recreated | `UNVERIFIED — confirm at source before relying on it` (not addressed in [GH-CTX]) | Ordering of a renamed source (DD-27 residual; out of the PoC) | N-29 |
| P-G13 | In an organization repository, creating or changing repository variables requires `write` access, while Environment variables require `admin` access | VERIFIED [GH-VARS-HOWTO] (read 2026-10-06): "you must have `write` access" (repository); "you must have `admin` access" (environment, organization repository) | Trusted source of the bound ref (DD-24 item 2, E1) | — |
| P-G14 | Environment-scoped variables of the caller's Environment are available to the Environment-bound job of a called reusable workflow | `UNVERIFIED — confirm at source before relying on it` | If false, the bound-ref check fails closed (no deploy, never an unsafe one) | N-24, N-32 |
| P-3 | Container names and port mappings on the target | `UNVERIFIED — confirm at source before relying on it` (trail FA) | Registry values (Low) | Registry task |
| P-4 | Server exposes `migration:check:ci` and `migration:run` | `UNVERIFIED — confirm at source before relying on it` | Definition arguments (Low) | Definition task |
| P-5 | Server image can migrate as an ephemeral container | `UNVERIFIED — confirm at source before relying on it` | `--migration-mode temp-container` (High) | Script adaptation / Gate C |
| P-6 | Target has a network path to the DEV DB | `UNVERIFIED — confirm at source before relying on it` | Target-migrates model fails (High) | First windowed run |
| P-7 | One AWS account for all environments | `UNVERIFIED — confirm at source before relying on it` | Policies change (Low) | Gate B |
| P-8 / P-8b | ECR repos exist; accept the CI's non-numeric tags | `UNVERIFIED — confirm at source before relying on it` | New repos / tag format (Low) | Gate B |
| P-9 | Frontend build needs secret `environment*.ts` values | `UNVERIFIED — confirm at source before relying on it` | Environment secrets unnecessary (Low) | Workflow task |
| P-11 | Executor host reaches the target on 22 and AWS + Slack on 443 (GitHub no longer needed) | `UNVERIFIED — confirm at source before relying on it` (OD-Q11) | Another host or B' (High) | Network spike |
| P-12 | Jenkins jobs use no lock the Executor could share | `UNVERIFIED — confirm at source before relying on it` | Shared lock instead of windows (Low) | Inventory |
| P-13 | **shared-state:** seven `<JENKINS_JOB_ID>` also deploy the unit | `UNVERIFIED — confirm at source before relying on it` | Incomplete window list (High) | `externalDeployers`; Jenkins admin, Gate C |
| P-14 | **shared-state:** other jobs depend on leftover keys on the target | `UNVERIFIED — confirm at source before relying on it` | Breaking them (High) | OD-Q5 |
| P-16 | **consumer:** Jenkins reads/cleans `<ECR_REPOSITORY>` with integer tags | `UNVERIFIED — confirm at source before relying on it` | Tag collisions or lifecycle deleting PoC images (Low) | Review ECR lifecycle, Gate B |
| P-19 | Microservices server is not the PROD Swarm host | `UNVERIFIED — confirm at source before relying on it` (OD-Q11) | Escalation (High) | OD-Q11 |
| P-22 | SQS per-message delay ≤ 900 s | `UNVERIFIED — confirm at source before relying on it` | Fewer requeues only (Low) | Lock-retry integration test |
| P-23 | PRMS migrations are backward compatible | `UNVERIFIED — confirm at source before relying on it` | No automatic migration (High) | Attestation, Gate C |
| P-24 | **shared-state:** DEV DB shared by other branch variants | `UNVERIFIED — confirm at source before relying on it` | E2E validity (High) | Window + snapshot, Gate C |
| P-20h | Workspace history: code now exists (P-20 superseded) | VERIFIED (§15 listing, 2026-10-06) | — | — |
| P-25 / P-26 | Canonical repo exists; initial content compatible | VERIFIED (T-00) | — | — |

Sources read for the rows above: [GH-OIDC] docs.github.com `/en/actions/reference/security/oidc`; [GH-ENV] `/en/actions/reference/workflows-and-actions/deployments-and-environments`; [GH-ENV-HOWTO] `/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments`; [GH-EVT] `/en/actions/reference/workflows-and-actions/events-that-trigger-workflows`; [GH-REUSE] `/en/actions/reference/workflows-and-actions/reusing-workflow-configurations`; [GH-VARS] `/en/actions/concepts/workflows-and-actions/variables`; [GH-VARS-HOWTO] `/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables`; [GH-CTX] `/en/actions/reference/workflows-and-actions/contexts`; [AWS-IAM-CK] AWS IAM User Guide, "IAM and AWS STS condition context keys", section "Available keys for AWS OIDC federation".

---

## 14. Budget and Gates

### 14.1 Budget (recomputed)

| Metric | v3.2 | v4 estimate |
|---|---|---|
| Tasks | 37 (23 A / 9 B / 5 C) | **35 new** (22 A / 7 B / 6 C) + 3 v2 tasks kept as done (`tasks.md` v4; T-06 is now reworked, CW-4) |
| LOC | ~8,700 | **~5,580** = Executor production ~3,000 + tests ~1,600 (net new/reworked) + schemas and definitions ~350 + script delta ~80 + workflows ~150 + operator CLI ~150 + infra inventory ~250 (CW-6: total equals the sum) |
| Review rounds | ~50 | **~40** |

Tripwire: `/akili-execute` stops and escalates if these are exceeded. Several PRs recommended.

### 14.2 Gates and blockers

| Gate | Meaning | Blocked by |
|---|---|---|
| **A** | Core implementation (domain, schemas, validation, store with DynamoDB Local, coordinator with a fake transport, workflow static validation) | Scoped Judgment Day `APPROVED`; owner approved the plan and **approved DD-25 (OD-A2) and DD-27 (OD-A1)** on 2026-10-06. No OD blocks Gate A |
| **B** | DEV infra and Executor deployed (infra only; no real CI run) | OD-Q11 (P-19), OD-Q12, OD-Q7, OD-N1 (platform CI task), P-11, P-7, **OD-A9 incl. the organization plan (P-A5, P-G7)**, P-A4 real format, P-A3 pinned, P-8/P-16 |
| **C** | First real CI run of the caller (held by a closed window), then E2E deploy on `<PRMS_REPORTING_DEV_TARGET>` | OD-A6 (caller) + repo-admin Environment setup and trust-policy IDs and SHA pin observed (P-G10, P-G11), P-G7 re-checked, OD-Q5 (P-14), P-13, P-23, P-24, P-6, P-5, AC17 real re-run as E2E confirmation of P-A6 |
| **D** | Retire Jenkins | OD-A3, OD-A4, OD-N1, OD-Q14, inventory, H1–H3, Jira, every wave validated |

---

## 15. Implementation Impact (obsolescence list)

Verdicts: **KEEP** (as is or trivial rename), **REWORK** (same purpose, changed contract), **DELETE** (purpose removed by AC-01). Nothing is deleted before the revised plan's first task (AC-01 §17).

### 15.1 Executor source

| Path (LOC) | Verdict | Reason |
|---|---|---|
| `domain/state-machine` (590) | REWORK (rewrite) | X1–X16 replace T1–T13 |
| `domain/events` (391) | REWORK → `request-contract` + internal events | No CI events, no normalization |
| `domain/planner` (268) | DELETE | No step graph (DD-06 removed) |
| `domain/lock-policy` (186) | REWORK (N-07) | Lease, fencing, schedule unchanged; **`evaluateSupersede` (ordering by Executor sequence, candidate (c) rejected by DD-27) and its tests are deleted** (CW-4) |
| `domain/errors` (76) | REWORK | Drop `SOURCE_*`, `QUALITY`, `BUILD`, `INFRA`; add `REJECTED` reasons and `DISPATCH_INTERRUPTED` |
| `domain/supersede-policy`, `domain/window-policy` | NEW | DD-27; §7.7 |
| `application/definition-service/index` (233) | REWORK | Deployment schema |
| `…/reference-resolution` (235) | KEEP (+ refs) | Adds `allowedSenderRef`, `source.*Ref`, principal refs |
| `…/registry-rules` (256) | KEEP (+ one rule) | One `deploymentId` per `lockKey` |
| `…/schema-validation` (32) | KEEP | — |
| `…/semantic-rules` (138) | REWORK | Drop cycles, `needs`, reserved types, interpolation |
| `application/event-router` (299 + 70) | REWORK → `message-router` | Drop normalizers and orphans; add type routing; keep schema validation |
| `application/step-dispatcher` (stub) | DELETE | Replaced by `deploy-coordinator` (NEW) |
| `application/execution-service` (stub) | REWORK | No commit resolution / GitClient |
| `application/{deploy-window-service, reconciler, notification-service}` (stubs) | KEEP | Scope reduced |
| `application/sender-authorizer` | NEW | DD-25 |
| `ports/{artifact-store, git-client, step-handler}` | DELETE | No S3, git, step handlers |
| `ports/deploy-transport` | NEW | SSH exec + SFTP |
| `ports/{state-store, index}` | REWORK | Execution-level operations |
| `ports/{clock, definition-source, notification-provider, queue-publisher, secret-provider}` | KEEP | — |
| `adapters/{git-cli-client, s3-artifact-store, zip-packager, handlers/lambda, handlers/codebuild, handlers/notify}` | DELETE | Purpose removed |
| `adapters/handlers/ssh` | REWORK → `adapters/ssh-deployer` | Implements `DeployTransport` |
| `adapters/{sqs-publisher, secrets-manager-provider, notify/slack-provider, bundled-definition-source}` | KEEP | Path rename only for the definition source |
| `inbound/sqs-consumer`, `main` (stubs) | KEEP / REWORK | `main`: no instance lease, no `/work` |
| `observability/*` (681) | KEEP | — |

### 15.2 Uncommitted T-08 DynamoDB store (per file)

| File | Verdict | Reason |
|---|---|---|
| `client.ts`, `condition-error.ts` | KEEP | Generic |
| `dedupe-repository.ts` | KEEP | DD-20 unchanged |
| `deploy-window-repository.ts` | KEEP | §7.7 unchanged |
| `event-mark-repository.ts` | KEEP | Notification dedupe |
| `lock-repository.ts` | KEEP | DD-09 unchanged |
| `sequence-repository.ts` | KEEP (rename key to `DEPLOYMENT#`) | — |
| `execution-repository.ts` | REWORK | Execution-level fields, `dispatchToken`, `execStartedAt`, GSI2 attribute removal on terminal |
| `target-state-repository.ts` | REWORK | `lastDeployed` (fenced), `highestDispatched` (monotonic max `stored <= new`, in the X9 intent transaction), `highestAccepted` (monotonic max `stored <= new`, separate conditional update after X1, E2), `unresolved[]`; replaces `lastDeployedSequence` |
| `keys.ts`, `types.ts`, `index.ts`, `state-store.ts` | REWORK | Drop step/instance keys; dedupe key `{deploymentId}#{requestId}` (CC-2); add rejection key |
| `table-schema.ts` | REWORK | Drop GSI1 |
| `step-repository.ts`, `step-attempt-lookup.ts` | DELETE | No steps |
| `instance-lease-repository.ts` | DELETE | No `/work` |
| Integration tests: `dedupe`, `lock`, `sparse-index-removal`, `setup`, `run-integration-tests`, `test/support/*` | KEEP | — |
| Integration tests: `gsi2-query`, `remaining-repositories`, `target-state-repository` | REWORK | New partitions/fields |
| Integration test: `step-repository.transition` | DELETE → replaced by an execution-transition test | — |

### 15.3 Everything else

| Path | Verdict | Reason |
|---|---|---|
| `ingress/github-webhook/**` (incl. tests, package files) | DELETE | FR-20 removed |
| `schemas/pipeline.schema.json` | DELETE | Replaced by `deployment.schema.json` (NEW) |
| `schemas/event.schema.json` | REWORK | Internal events only (§6.4) |
| `schemas/deploy-request.schema.json` | NEW | §6.1 |
| `schemas/targets.schema.json` | KEEP (+ one rule) | §6.3 |
| `pipeline-definitions/prms/reporting-dev.yaml` | REWORK → `deployment-definitions/` | Flat definition |
| `pipeline-definitions/targets/dev.yaml` | KEEP (moved) | — |
| `deploy-scripts/deploy-container.sh` | REWORK | `--artifact` by digest, tag rejection (exit 2), idempotent "already running" |
| `deploy-scripts/test/**` | KEEP (+ cases: tag rejected, digest pull) | — |
| `deploy-scripts/README.md` | REWORK | CLI change |
| `executor/scripts/guards/pipeline-schema-expressions` | REWORK | Retarget to `deployment.schema.json` |
| `…/guards/extensibility-fixture` | REWORK | Mock deployment definition |
| `…/guards/dockerfile-boundary` | REWORK | Also forbid `git` |
| `…/guards/{project-identifiers, local-analysis-files, run-all, lib/*}` | KEEP | — |
| `…/guards/publication-policy` | KEEP (+ scan `.github/workflows/`) | DD-23 extension |
| `executor/scripts/inspect-image.mjs` | REWORK | Assert no `git` binary |
| `executor/Dockerfile` | REWORK | Remove `git` install; copy `deployment-definitions/` |
| Unit tests: `planner`, `event-normalizers`, `definition-service.substitution` | DELETE | Purpose removed |
| Unit tests: `state-machine`, `event-router`, `definition-service.pipeline`, `boundary-guards`, `dockerfile-boundary*`, `inspect-image` | REWORK | New contracts |
| Unit tests: `definition-service.{registry,startup}`, `observability-*`, `bundled-definition-source` | KEEP | — |
| Unit test: `lock-policy` | REWORK (N-07) | Drop the `evaluateSupersede` cases |
| Contract test: `test/contract/pipeline-schema.contract.test.ts` | DELETE (N-03) | Pipeline schema removed (CW-5) |
| Contract test: `test/contract/event-schema.contract.test.ts` | REWORK (N-05) | Internal events only (CW-5) |
| Contract test: `test/contract/targets-schema.contract.test.ts` | KEEP | — |
| Fixtures: `test/fixtures/aws/{codebuild-*,lambda-destinations-*}.json` | DELETE (N-05) | Normalizers removed (CW-5) |
| Fixture: `test/fixtures/nfr08-second-definition/pipeline.yaml` | REWORK (N-19) | Becomes a deployment definition (CW-5) |
| `infra/RESOURCES.md` | REWORK | Add OIDC provider, CI role, queue policy; remove S3, CodeBuild, Destinations, EventBridge rule, ingress |
| `docs/runbook.md`, `docs/resources.md` | REWORK | Model B operations |
| `docs/jenkins-coexistence-log.md` | KEEP | — |
| `.github/workflows/deploy-request.reusable.yml`, `docs/examples/caller-workflow.yml`, `tools/` | NEW | DD-29, OD-A6, DD-21 |

**Counts (table rows; a row may group several paths):** KEEP 23 · REWORK 30 · DELETE 12 · NEW 5 (after the JD round-1 correction).

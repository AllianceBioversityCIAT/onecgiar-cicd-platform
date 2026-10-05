# Design — CI/CD Executor PoC (PRMS Reporting DEV)

> **In one line:** a single TypeScript service with hexagonal architecture. A pure domain core (state machine + planner) decides; interchangeable adapters act (SQS, DynamoDB, S3, Lambda, CodeBuild, SSH, Slack). Correctness rests **only** on DynamoDB's conditional writes, not on queue order or on having a single instance. Tier **LITE**.

---

## 1. Document Control

| Field | Value |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Phase | Phase 2: Design |
| Depth | Full (re-checked in §13) |
| Requirements | `requirements.md` (**approved** 2026-10-05) |
| Intent | `proposal.md` v2 (approved) |
| Evidence | FA = `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md`; ctx = `JENKINS_REPLACEMENT_AKILI_CONTEXT.md` (file renamed on 2026-10-05 at the owner's request to use the Akili name) |
| Review | **v3.2** (2026-10-05, owner-approved execute-time amendments: §7.7 `none` ⇔ `not-required`; DD-23 and §7 credential refs existence-only with a separate `credentialRef`; English translation). **v3.1** (after APPROVED, authorized by the owner): editorial adjustments R3-1 through R3-4 and sanitization of internal identifiers for publishing to Git. **v3**: Judgment Day's final fix round (R2-1, R2-W1 through R2-W4, R2-I1 through R2-I4) and the canonical repository. v2: round 1 (C-1, C-2, S-1 through S-4, D-1, W-1 through W-6, I-1 through I-4). Detail in `judgment.md` |
| Repository | `https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform.git` (§4.1) |
| Skills applied | `software-architect` (Decision Spine). No UI: UX skills do not apply |
| Templates | `general-setup` does not exist. The command's minimal structure is used |
| Open decisions | OD-Q5, OD-Q7, OD-Q11–OD-Q15 **remain open**. The design isolates them behind ports or resources so as not to have to assume their answer (§10, DD-16 through DD-18) |
| Date | 2026-10-05 |

---

## 2. Executive Summary

| Decision | Choice | Requirements |
|---|---|---|
| Style | Hexagonal modular monolith, one deployable, stateless worker | NFR-01, NFR-08 |
| Consistency | Conditional writes in DynamoDB with optimistic versioning: single source of truth | FR-05, FR-07, NFR-03 |
| Dispatch | *Intent-then-act* with a `dispatchToken` per attempt | FR-07 |
| Extension | One handler per step type, in a closed registry (Strategy) | FR-01, NFR-08 |
| Planning | Pure function: state → actions | FR-06 |
| Waits | Everything event-driven except the deploy's SSH session | FR-09, FR-10, NFR-04 |
| Definitions | Behind the `DefinitionSource` port. In the PoC, packaged into the image (PoC simplification); the version is the platform repo's commit | FR-01, NFR-08 |
| Locks | Two barriers: distributed lock in DynamoDB (lease + owner + fencing + supersede) **and** a local mutex on the target that protects the physical operation | FR-11, FR-13 |
| Deploy windows | Generic per-target gate, with **mandatory** `deployWindowPolicy` and `externalDeployers`. Revalidated at V1–V4, and expired windows are closed via an indexed query. Transient, to coexist with Jenkins | FR-18 |
| States | Closed list of transitions. The only backward transition is T9 (code 50) | FR-05 |
| Deploy | Generic versioned script, delivered via SFTP on each execution | FR-12, FR-13 |
| Open | AWS credentials (Q12), host (Q11), IaC (Q7), and target (Q5) behind ports or the resource inventory | §10 |

---

## 3. Architecture Overview

### 3.1 C4 — Context

```text
 [DevOps Operator] --PIPELINE_REQUESTED message--> (SQS cicd-events-dev)
 [GitHub] --webhook (SHOULD)--> [Ingress Lambda] --> (SQS)
                                   |
                           [[CI/CD Executor]]
     +-------------+---------------+---------------+---------------+-------------+
     v             v               v               v               v             v
 (DynamoDB)      (S3)      [<QUALITY_WORKER_FUNCTION>] [CodeBuild        [<PRMS_REPORTING_DEV_TARGET>] [Slack]
 state+locks   artifacts       Lambda        prms-reporting-dev]  via SSH/SFTP
                                   |               |                       |
                                   +--Destinations-+--EventBridge--> SQS   +--> DEV DB (from the target)

Legend: [ ] system or person · [[ ]] system under design · ( ) storage or managed queue · --> data or command flow
```

### 3.2 C4 — Executor containers

```text
+------------------------------- cicd-executor (1 container) --------------------------------+
|  Inbound adapters        |  Application              |  Domain (pure)     |  Outbound ports   |
|  SqsConsumer ------------>  EventRouter ------------->  StateMachine      |  StateStore       |
|   (long-poll, heartbeat) |  ExecutionService          |  Planner          |  ArtifactStore    |
|                          |  StepDispatcher ---------->  IdempotencyRules  |  QueuePublisher   |
|                          |  Reconciler                |  LockPolicy        |  SecretProvider   |
|                          |  NotificationService       |  DefinitionModel   |  GitClient        |
|                          |                            |                    |  Step handlers:   |
|                          |                            |                    |   Lambda/CodeBuild|
|                          |                            |                    |   /Ssh/Notify     |
+--------------------------------------------------------------------------------------------+
Legend: arrows = call dependency. The domain does not depend on AWS or SSH; adapters implement the ports.
```

### 3.3 Main flow (PRMS Reporting DEV)

| # | Trigger | Executor action | Resulting state |
|---|---|---|---|
| 1 | `PIPELINE_REQUESTED` | Dedupe → sequence → creates the execution with the definition's version → resolves the commit | Execution `QUEUED` → `RUNNING` |
| 2 | (internal) | Implicit `source` step: fetch, ZIP ×2, upload | `source` `SUCCEEDED` |
| 3 | Planner | Dispatches `server-quality` ∥ `client-quality` (async Lambda) | Both `RUNNING` |
| 4 | `QUALITY_COMPLETED` ×2 | Dispatches each one's `*-image` (StartBuild) | Builds `RUNNING` |
| 5 | `BUILD_COMPLETED` ×2 | Conditional fan-in: a single winner dispatches `deploy` | `deploy` `WAITING_LOCK` → `DISPATCHING` |
| 6 | Window open + lock acquired | Window check (if the target requires it) → supersede → SFTP of the script → exec → heartbeat. The script takes the local mutex | `deploy` `RUNNING` |
| 7 | Script finishes | Maps the exit code → updates the target's state → releases the lock | `deploy` terminal |
| 8 | Planner | `finally` (notify) → the execution moves to terminal | Execution terminal |

---

## 4. Extended Directory Structure

The workspace has no code. Checked with `find . -type f` on 2026-10-05: only the two source documents and `docs/specs/`.

### 4.1 Canonical repository and version control

| Aspect | Decision |
|---|---|
| Canonical repository | `https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform.git` (`onecgiar-cicd-platform`), indicated by the owner on 2026-10-05. Replaces the provisional `cicd-platform/` directory from the proposal §14.4: **the repo root is the root of the structure below** |
| Versioned content | Executor code, ingress, and operator CLI; Pipeline Definitions, Target Registry, and schemas; tests; infrastructure; deploy scripts; buildspecs; runbooks; Akili specs (`docs/specs/…`, including `proposal`, `requirements`, `design`, `judgment`, and `tasks`) |
| **Excluded (never versioned)** | `JENKINS_REPLACEMENT_AKILI_CONTEXT.md` and `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md`. They remain local. Added to `.gitignore` **before the first commit** (must be the first file created when linking the workspace to the repo) |
| Verification before every commit touching root files | `git status`, and `git ls-files` for both names → 0 results. If either is already tracked: stop and remove it from the index **without deleting the local file** before continuing |
| Publication policy (decided by the owner on 2026-10-05) | Versioned specs and documentation **do not** publish internal identifiers: account ID, hosts, IPs, Jenkins or SSH credential IDs, revealing secret names, DB details, Jenkins job names, or sensitive values. Logical references are used (`<AWS_ACCOUNT_ID>`, `<PRMS_REPORTING_DEV_TARGET>`, `<SSH_CREDENTIAL_REF>`, `<AWS_CREDENTIAL_REF>`, `<JENKINS_JOB_ID>`, `<ECR_REPOSITORY>`, `<SERVER_CONTAINER>`, `<CLIENT_CONTAINER>`, `<QUALITY_WORKER_FUNCTION>`…) and semantic identifiers (`prms-reporting-dev`). Real values are resolved outside Git (DD-23): Secrets Manager, IAM, and deployment configuration. Citations to the local analysis (FA §x/Lnn) are kept as a trail; their content is not copied |
| Sanitization applied | `proposal.md`, `requirements.md`, `design.md`, and `judgment.md` sanitized on 2026-10-05, with no change to the architecture's meaning. A prior local copy is kept in the session's scratchpad (outside Git) |
| Remote status | `git ls-remote` → `41f4c3e…  refs/heads/main` (P-25). It already has an initial commit with uninspected content (P-26): the first execution task links the workspace to the remote and integrates that content before adding anything |
| Commits and push | Only during Akili's execution phases. Nothing is committed or pushed during the specification phase |

### 4.2 Structure (root of the `onecgiar-cicd-platform` repo)

```text
onecgiar-cicd-platform/
  .gitignore                       # first: excludes the two local analysis files
  executor/
    src/
      main                         # bootstrap, port wiring, instance lease, /work/{instanceId} cleanup, ordered shutdown
      inbound/sqs-consumer         # long-poll, visibility heartbeat, ack/no-ack
      application/
        event-router               # eventType → use case
        execution-service          # create, advance, and close executions
        step-dispatcher            # intent-then-act, invokes the type's handler
        reconciler                 # RECONCILE_TICK
        notification-service       # fan-out to providers
        definition-service         # validates definitions and the registry; obtains them via the DefinitionSource port
        deploy-window-service      # opens, closes, and queries per-target deploy windows (FR-18, transient)
      domain/
        state-machine              # valid transitions (FR-05 table)
        planner                    # DAG, fan-in, cascading skip, finally
        events                     # envelope and normalization (types)
        lock-policy                # lease, supersede, fencing
        errors                     # codes (SOURCE_CLONE, MIGRATION, …)
      ports/                       # interfaces: StateStore, ArtifactStore, QueuePublisher, DefinitionSource,
                                   #   SecretProvider, GitClient, StepHandler, NotificationProvider, Clock
      adapters/
        dynamodb-state-store  s3-artifact-store  sqs-publisher  secrets-manager-provider
        git-cli-client  zip-packager  bundled-definition-source (PoC)
        handlers/{lambda,codebuild,ssh,notify}
        notify/slack-provider
      observability/{logger,metrics}
    test/{unit,integration,contract,e2e-fixtures}
    Dockerfile
    deploy/                        # artifacts for running the container on the host (per OD-Q11)
  ingress/github-webhook/          # FR-20 (SHOULD); contract in §6.6
  tools/                           # operator CLI: manual trigger, open and close deploy windows
  buildspecs/prms-reporting-dev.yml
  pipeline-definitions/prms/reporting-dev.yaml
  pipeline-definitions/targets/dev.yaml
  schemas/{pipeline,targets,event}.schema.json
  deploy-scripts/deploy-container.sh
  infra/                           # tool per OD-Q7; until decided: infra/RESOURCES.md (inventory)
  docs/{runbook,resources,jenkins-coexistence-log}.md
  docs/specs/changes/cicd-executor-poc/   # this spec
```

---

## 5. Data Model

### 5.1 `cicd-executions-dev` table (DynamoDB on-demand, TTL `expiresAt`)

| Item | PK | SK | Attributes | Write |
|---|---|---|---|---|
| Execution | `EXEC#{executionId}` | `META` | `pipelineId, definitionRef, project, environment, repository, branch, commit, sequence, trigger, triggeredBy, requestId, status, version, targets[], lockIds[], artifacts[], slackThreadTs, deadlineAt, startedAt, finishedAt, error{code,message,stepId}, activeStatus = EXECUTION (only while not terminal), expiresAt (180 d)` | Conditional on `version` |
| Step | `EXEC#{executionId}` | `STEP#{stepId}` | `type, status, attempt, dispatchToken, externalRef, logUrl, outputs{}, migrationsApplied, deadlineAt, activeStatus = STEP (only while not terminal), lockWaitStartedAt, lockWaitAttempts, lockLostDuringRun, windowClosedDuringRun, contentionCount, reconcileRedispatchCount, startedAt, finishedAt, error, version` | Conditional on `status` and `version` (§7.3) |
| Dedupe | `DEDUPE#{requestId}` | `DEDUPE` | `state (CLAIMED/BOUND), claimToken, claimLeaseExpiresAt, sequence, executionId, expiresAt (7 d)` | See DD-20 |
| Deploy window | `WINDOW#{lockKey}` | `WINDOW` | `state (OPEN/CLOSED), openedBy, openedAt, closesAt (max 8 h), externalJobsDisabled[], note, closedBy, closedReason (MANUAL/EXPIRED), closedAt, version`; while `OPEN`: `activeStatus = WINDOW` and `deadlineAt = closesAt` (enters GSI2). History is kept in `WINDOW#{lockKey}` / `LOG#{openedAt}` items | Conditional on `state` and `version` |
| Executor instance | `INSTANCE#{instanceId}` | `LEASE` | `startedAt, leaseExpiresAt, hostname` (renewed every 60 s) | `attribute_not_exists OR leaseExpiresAt < now` (§7.4) |
| Sequence | `PIPELINE#{pipelineId}` | `SEQ` | `value` | Atomic `ADD` |
| Target | `TARGET#{lockKey}` | `STATE` | `currentImages{}, previousImages{}, lastDeployedSequence, lastExecutionId, updatedAt` | Conditional on the lock's owner and the `fencingToken` |
| Lock | `LOCK#{lockKey}` | `LOCK` | `owner, fencingToken, leaseExpiresAt, acquiredAt, expiresAt` | See DD-09 |
| Event mark | `EXEC#{executionId}` | `EVT#{eventKey}` | Only for events with no natural transition (e.g. notifications sent). `expiresAt` 7 d | `attribute_not_exists` |

| Index | Key | Use |
|---|---|---|
| GSI1 | `pipelineId` + `startedAt` | Per-pipeline history (FR-17) |
| GSI2 (sparse) | `activeStatus` (`EXECUTION`, `STEP`, or `WINDOW`) + `deadlineAt` | Reconciler, **no scans**: one `Query` per partition with `deadlineAt < now`. Contains only live items: the attribute is removed upon reaching a terminal state or closing the window (FR-15, FR-18) |

### 5.2 S3 `cicd-artifacts-dev`

| Prefix | Content | Lifecycle |
|---|---|---|
| `executions/{id}/source/{package}.zip` | Source with no secrets | Explicit deletion when finished + 7-day expiration |
| `executions/{id}/quality/` | Logs and reports (if the worker writes here) | 30 d |
| (bucket) | Incomplete multipart | 1 d |

### 5.3 State on the target

| Element | Location |
|---|---|
| Delivered script | `/tmp/cicd-{executionId}/deploy-container.sh` (deleted at the end) |
| Runtime configuration | `/tmp/cicd-{executionId}/runtime.env`, permissions 0600 (deleted at the end). Change from the proposal (`/tmp/deploy-{executionId}.env`): a single directory per execution allows deleting everything at once. Still satisfies FR-13 |
| Local mutex | Lock file per deploy unit in a directory owned by the deploy user (e.g. `/var/lock/cicd/{lockKey}.lock`), taken with a non-blocking **kernel** file lock, which the operating system releases when the process dies. **The lock is the kernel's lock, not the file's existence.** The file contains `executionId`, `fencingToken`, PID, and start time (diagnostics; runbook §12.1). The script's critical section ignores the session hangup signal (HUP): an SSH cut does not interrupt a migration or a swap in progress |
| Images | The current and previous ones are kept; older ones are pruned |

---

## 6. API Design (contracts)

There is no orchestration REST API. The contracts are messages and CLIs.

### 6.1 Event envelope (`schemas/event.schema.json`)

| Field | Mandatory | Notes |
|---|---|---|
| `specVersion` | yes | `1` |
| `eventId` | yes | UUID |
| `eventType` | yes | `PIPELINE_REQUESTED, QUALITY_COMPLETED, QUALITY_FAILED, QUALITY_TIMED_OUT, BUILD_COMPLETED, BUILD_FAILED, BUILD_TIMED_OUT, DEPLOYMENT_COMPLETED, DEPLOYMENT_FAILED, PIPELINE_COMPLETED, PIPELINE_FAILED, STEP_RETRY_REQUESTED, LOCK_RETRY_REQUESTED, RECONCILE_TICK, DEPLOY_WINDOW_OPEN_REQUESTED, DEPLOY_WINDOW_CLOSE_REQUESTED` |
| `executionId` | yes (except `PIPELINE_REQUESTED`, `RECONCILE_TICK`, and `DEPLOY_WINDOW_*`) | |
| `pipelineId`, `environment` | yes (except `RECONCILE_TICK` and `DEPLOY_WINDOW_*`, which carry `lockKey`) | |
| `stepId`, `status`, `attempt` | on step results | |
| `timestamp`, `source` | yes | `source ∈ executor, lambda, codebuild, ingress, scheduler, operator` |
| `payload` | no | References and identifiers only; maximum message size 64 KB by design |
| `requestId` | on `PIPELINE_REQUESTED` | Dedupe key |

**Normalization on receipt:**

| Origin | Recognized by | Correlation |
|---|---|---|
| Lambda Destinations | Shape of the destination record (`requestContext`, `requestPayload`, `responsePayload`) | `requestPayload.executionId` + `stepId` + `dispatchToken` |
| EventBridge CodeBuild | `detail-type = CodeBuild Build State Change` | `buildId` == the step's `externalRef` |

**Orphan events (FR-04):** if the `executionId` does not exist, the `stepId` does not exist in that execution, or the external identifier does not match the `externalRef` of the current attempt (e.g. the result of a previous, already-replaced attempt), `event-router` logs `ORPHAN_EVENT` (log with all identifiers received + `OrphanEvents` metric) and acknowledges the message **with no effects**. An event from a previous attempt never modifies the current attempt.

### 6.2 Lambda contract (`<QUALITY_WORKER_FUNCTION>`)

| Direction | Content |
|---|---|
| Input (Executor → worker) | `executionId, stepId, dispatchToken, task, sourceRef (S3 URI)` + the fields the worker requires (P-2) |
| Output (worker → Destinations) | `status, failedCommand, exitCode, error, logS3Uri, logUrl` (P-1) |
| Configuration | `Event` invocation on a **dedicated alias** `cicd` with its own async configuration (`MaximumRetryAttempts=0`, `onSuccess`/`onFailure` → SQS). The unqualified function is not touched (DD-07) |

### 6.3 CodeBuild contract

| Element | Value |
|---|---|
| Project | The one declared in the step (`prms-reporting-dev`) |
| Overrides | S3 source = the execution's ZIP; env `EXECUTION_ID, STEP_ID, IMAGE_TAG, COMPONENT`; `idempotencyToken = dispatchToken` |
| Buildspec | Versioned in `buildspecs/`; associated with the project in infrastructure (does not travel in the ZIP) |
| Build secrets | Secrets-Manager-type variables declared on the project, read-only and DEV only |
| Outputs | `imageUri`, `digest` as exported build variables, read from the event or, if the event doesn't carry them, from `BatchGetBuilds` in the handler |
| Completion | EventBridge rule filtered by the platform's projects → SQS |

### 6.4 Deploy script CLI (`deploy-container.sh`)

| Argument | Meaning |
|---|---|
| `--execution-id` | For temporary paths and logs |
| `--unit` | Deploy unit name (informational) |
| `--image <container>=<imageUri>` (repeatable) | New image per container |
| `--previous <container>=<imageUri>` (repeatable, hint) | Previous image per the target's state in DynamoDB. **The authoritative source for restoring is the image the container is actually running on the host when the script starts**; the hint is used only if the container doesn't exist. This way the rollback is correct even if a previous execution deployed without being able to update DynamoDB (S-2) |
| `--lock-key`, `--fencing-token` | Identify the local mutex and who holds it |
| `--port <container>=<host:container>` (repeatable) | From the Target Registry |
| `--runtime-secret <container>=<secretRef>` (optional) | Reference; the target resolves it with its own permissions (OD-Q5) |
| `--migrate <container>` + `--migration-check <cmd>` + `--migration-run <cmd>` (optional) | From the Target Registry |
| `--health <container>=<url or cmd>` (optional) | Health check |

First step of the script, before any effect: take the local mutex (non-blocking). If it's taken, it exits with **50 (`TARGET_BUSY`) having done nothing**.

Exit: codes 0/10/20/30/40/50 (FR-13) and, as the last stdout line, `CICD_RESULT` followed by a JSON with `status, deployedImages, previousImages, migrations (APPLIED|NONE|FAILED), healthy, mutexHolder` (the latter only with 50).

### 6.6 GitHub webhook contract (FR-20, SHOULD; Inc 8)

| Aspect | Contract |
|---|---|
| Endpoint | Lambda `cicd-github-ingress-dev` behind a Function URL. It is the only exposed component; the Executor exposes no ports |
| Authentication | `X-Hub-Signature-256` signature (HMAC-SHA256 of the raw body, constant-time comparison) with the `<WEBHOOK_SECRET_REF>` secret. Missing or invalid signature → **401**, nothing is queued |
| Accepted events | `push`; `ping` → 200 with no effect; anything else → 202 ignored and logged |
| Mapping | Repository + `ref` (`refs/heads/<branch>`) → definitions with the `github-push` trigger whose `repository.url` and `branch` match. Obtained from the same bundled `DefinitionSource` (DD-19) |
| Unconfigured branch or no match | 202, `WEBHOOK_UNMATCHED` log, nothing is queued |
| Pushes that delete the branch (`deleted: true`) | 202 ignored |
| Queueing | One `PIPELINE_REQUESTED` per matching definition, with `requestId = X-GitHub-Delivery + ":" + pipelineId`, the `after` commit, and `triggeredBy` = the push's user |
| Response | 202 after queueing. GitHub retries if it does not get a 2xx; dedupe (DD-20) absorbs the retries |

### 6.5 Notification (Slack)

Root message on start: pipeline, `executionId`, commit, branch, and a link to logs. Thread replies for each failure or timeout. The root message is updated with the final result and duration. No secrets.

---

## 7. Backend Module Design

| Module | Responsibility | Requirements | Forbidden |
|---|---|---|---|
| `sqs-consumer` | 20 s long-poll. Bounded handler concurrency. Visibility heartbeat every 60 s while the handler is alive. Ack only if the handler finished or the event is a recognized no-op | FR-04, NFR-04 | Business logic |
| `main` (bootstrap) | Before consuming: (1) acquires the `INSTANCE#{instanceId}` instance lease; (2) cleans **only** `/work/{instanceId}/`. Full model in §7.4 | FR-08 | Touching another `instanceId`'s directories |
| `event-router` | Validates the envelope, normalizes AWS origins, detects **orphan events** (§6.1), and routes | FR-04 | — |
| `deploy-window-service` | Handles `DEPLOY_WINDOW_OPEN_REQUESTED/CLOSE_REQUESTED` (operator CLI in `tools/`). Opens the window only if the request carries `openedBy` and a non-empty `externalJobsDisabled[]` that **covers** the `externalDeployers` declared for that target in the registry (§7.7). Closes it on request or when `closesAt` expires. Answers `isDeployAllowed(lockKey, needUntil)`: there's an `OPEN` window with `closesAt ≥ needUntil` | FR-18 | Knowing about Jenkins: the job list is opaque data that gets compared and logged |
| `execution-service` | Dedupe → sequence → creation with `definitionRef`. Commit resolution via `GitClient`. Advancement and closing | FR-03, FR-05 | — |
| `definition-service` | Obtains definitions and the registry **only** through `DefinitionSource` (in the PoC, `bundled-definition-source`). Validates the schema and semantic rules: cycles, nonexistent `needs`, reserved types, interpolation outside the allowlist, environment ≠ dev, duplicate ports or names per host, missing host key, migrations enabled without `migrationCompatibility: backward-compatible` declared on the target (DD-11), and the **mandatory, coherent window policy** from §7.7. An invalid registry prevents the Executor from starting; the same validation runs in CI before building the image | FR-01, FR-02 | Reading secret values: credential references (SSH `credentialRef`, repository `credentialRef`, Slack `tokenRef`) are only **existence-checked** at startup (`SecretProvider.exists`, never the value); `getSecret` is used only for non-sensitive identifier references; application secrets (`envSecretRef`) are never resolved (owner ruling 2026-10-05, DD-23) |
| `planner` (domain) | Receives the steps with their states and returns the actions (dispatch X, skip Y, run finally, close the execution) | FR-06 | I/O |
| `state-machine` (domain) | Closed list of transitions with guards (§7.3). Any transition absent from the list, including any other backward transition, is rejected | FR-05 | I/O |
| `step-dispatcher` | For each dispatch action: conditional transition (T1/T3 from §7.3) with a new `dispatchToken` → calls the handler → stores `externalRef` → `RUNNING`. If the transition fails, no-op | FR-07 | Retrying effects without going through the state |
| `handlers/source` | Fetch of the exact commit, streaming ZIP with mandatory exclusions, multipart upload, cleanup in finally. Concurrency semaphore | FR-08 | Installing dependencies or running repo scripts |
| `handlers/lambda` | Invokes the alias in Event mode | FR-09 | Synchronous invocation |
| `handlers/codebuild` | `StartBuild` with overrides and `idempotencyToken` | FR-10 | Polling on the normal path |
| `handlers/ssh` | Sequence and resources in §7.5: window (point V1/V2) → distributed lock (DD-09) → supersede → **global SSH session semaphore** (default 4, configurable; NFR-04) → SFTP of the script → window (point V4) → `RUNNING` → exec with escaped args → capture → code mapping (50 → T9 from §7.3) → target state (with fencing) → release per the §7.5 table. While waiting for the semaphore, the message keeps its heartbeat (DD-14) | FR-11, FR-12, FR-18 | Building commands by concatenating text; aborting a script in progress |
| `notification-service` | Selects providers per definition. Best-effort. Marks `EVT#` to avoid duplicates | FR-14 | Changing the execution's state |
| `reconciler` | Three `Query`s to GSI2, never scans: `activeStatus = STEP` and `= EXECUTION` with `deadlineAt < now` (result recovery per the §7.3 table: T8, T13, or T12; expired `WAITING_LOCK`: `LOCK_TIMEOUT` via T5, §7.3's canonical rule; then the planner) and `activeStatus = WINDOW` with `deadlineAt < now` (closing expired windows, §7.7) | FR-15, FR-11, FR-18 | Re-running a deploy; aborting one in progress |
| `observability` | JSON logger with context (`executionId`, `stepId`, `eventType`, `attempt`) and redaction of secret patterns. EMF metrics | FR-17 | — |

### 7.1 Deadlines (`deadlineAt`)

| Step | Default deadline |
|---|---|
| `source` | 15 min |
| `lambda` | 17 min (15 from Lambda + margin) |
| `codebuild` | Project timeout + 5 min |
| `ssh` | Step's `timeoutMinutes` (20 in the PoC) + 5 min |
| Execution | 120 min |
| Lock wait | 30 accumulated minutes (FR-11). While it lasts, the step's `deadlineAt` = `lockWaitStartedAt` + 30 min + 5 min (reconciler safety net) |

### 7.2 Failure mapping (implements FR-16)

| Origin | Classification | Retry | Who retries |
|---|---|---|---|
| Clone | `SOURCE_CLONE` | 2, with backoff, inside the handler | Handler |
| ZIP | `SOURCE_PREP` | 0 | — |
| Upload | `ARTIFACT_UPLOAD` | SDK + 1 step retry | `STEP_RETRY_REQUESTED` |
| Lambda: function error | `INFRA` | 1 | `STEP_RETRY_REQUESTED` (new `attempt` and `dispatchToken`) |
| Lambda: failure `status` | `QUALITY` | 0 | — |
| Lambda: timeout | `TIMED_OUT` | 0 | — |
| `StartBuild` rejected (API) | `INFRA` | 1 | `STEP_RETRY_REQUESTED` |
| Build `FAILED/STOPPED` | `BUILD` | 0 | — |
| Build `TIMED_OUT` | `TIMED_OUT` | 0 | — |
| SSH connection or host key | `SSH_CONNECT` / `HOST_KEY_MISMATCH` | 2 / 0, before executing | Handler |
| Exit 10/20/30/40/other | `PULL` / `MIGRATION` / `START` / `HEALTH` / `UNKNOWN_TARGET_STATE` | 0 | — |
| Exit 50 (`TARGET_BUSY`) | Contention: the script did nothing | Returns to `WAITING_LOCK` (T9) and draws from the same 30-minute budget | `LOCK_RETRY_REQUESTED` |
| Lock busy for more than 30 accumulated minutes | `LOCK_TIMEOUT` | 0 | — |
| Target requires a window and none is valid for the needed duration | `DEPLOY_WINDOW_CLOSED` (SSH is not opened, or the script is not executed) | 0 | — |

### 7.3 Step state machine: closed list (fixes R2-1)

General rule: **only** the transitions in this table are valid. Each one is applied with a conditional write on the current source state, `attempt`, and `version`. Terminal states (`SUCCEEDED, FAILED, TIMED_OUT, SKIPPED`) are immutable. A requested transition not listed here is rejected and logged (`INVALID_TRANSITION`), with no effects.

| # | From | To | Step types | Trigger and guard |
|---|---|---|---|---|
| T1 | `PENDING` | `DISPATCHING` | `source`, `lambda`, `codebuild`, `notify` | Planner: dependencies in `SUCCEEDED`. New `dispatchToken` |
| T2 | `PENDING` | `WAITING_LOCK` | `ssh` | Planner: dependencies in `SUCCEEDED`. Stores `lockWaitStartedAt = now` |
| T3 | `WAITING_LOCK` | `DISPATCHING` | `ssh` | Valid window (V1/V2) + lock acquired + not superseded. New `dispatchToken` |
| T4 | `WAITING_LOCK` | `SKIPPED` | `ssh` | Supersede (`lastDeployedSequence > sequence`) |
| T5 | `WAITING_LOCK` | `FAILED` | `ssh` | `LOCK_TIMEOUT` or `DEPLOY_WINDOW_CLOSED` |
| T6 | `DISPATCHING` | `RUNNING` | all | `externalRef` registered (`ssh`: right before exec, after V4) |
| T7 | `DISPATCHING` | `FAILED` | all | Non-retryable dispatch error, or retries exhausted, or `DEPLOY_WINDOW_CLOSED` at V4 (`ssh`) |
| T8 | `RUNNING` | `SUCCEEDED` / `FAILED` / `TIMED_OUT` | all | Result of the current attempt (`externalRef` matches) |
| **T9** | **`RUNNING`** | **`WAITING_LOCK`** | **`ssh` only** | **The only backward transition, for contention.** Guard: the current attempt's result is **code 50** (`TARGET_BUSY`) from the deploy script. There is no other valid cause |
| T10 | `RUNNING` or `DISPATCHING` | `DISPATCHING` (same step, `attempt + 1`) | `source`, `lambda`, `codebuild` | `STEP_RETRY_REQUESTED`: error classified as retryable in §7.2 and `attempt` < maximum. New `dispatchToken`; the previous attempt's result becomes an orphan (§6.1). **Never** applies to `ssh` |
| T11 | `PENDING` | `SKIPPED` | all | Dependency `FAILED`/`TIMED_OUT`/`SKIPPED`, or `when` false |
| T12 | `DISPATCHING` / `RUNNING` | `TIMED_OUT` | all | Reconciler: `deadlineAt < now` and neither T13 nor adoption of the real result applies (`reconciler` row of §7). **Does not** apply to `WAITING_LOCK`: see the canonical rule below |
| T13 | `DISPATCHING` (no `externalRef`) | `DISPATCHING` (**same** `attempt`, **same** `dispatchToken`) | `codebuild`, `lambda` | Reconciler: `deadlineAt < now`, the step never registered an `externalRef` (the Executor crashed between the intent and the registration, DD-04), and `reconcileRedispatchCount = 0`. Calls again with the same token: CodeBuild uses it as `idempotencyToken` (does not create a second build if the first one existed, P-18); quality in Lambda is read-only (repeating it is harmless). Increments `reconcileRedispatchCount` and sets a new `deadlineAt`. If it expires again → T12. **Never** applies to `ssh` (an `ssh` step in `DISPATCHING` never executed the script, because exec happens after T6; it expires via T12) nor to `source` (it is re-dispatched via T10 with a new `attempt`) |

**Recovery of results lost by the reconciler (R3-2):**

| Situation of the expired step | Reconciler action | Transition |
|---|---|---|
| `RUNNING` `codebuild` with `externalRef` | `BatchGetBuilds`. If it finished, adopts the real result | T8 |
| `RUNNING` `codebuild` with `externalRef`, the build is still running | Extends `deadlineAt` up to the project's timeout + 5 min (once) | No transition |
| `DISPATCHING` `codebuild`/`lambda` with no `externalRef`, first expiration | Idempotent re-dispatch with the same token | T13 |
| `DISPATCHING` with no `externalRef` after T13, or another type | Closure | T12 (`TIMED_OUT`) |
| `RUNNING` `lambda` with no result | Closure (the Destinations never arrived) | T12 (`TIMED_OUT`) |
| `RUNNING` `ssh` with an expired lease | Closure with `UNKNOWN_TARGET_STATE` (runbook §12.1) | T8 (`FAILED`) |

**Canonical rule at the 30-minute lock-wait limit (R3-4):** the outcome of exhausting the lock wait is **always `FAILED` with code `LOCK_TIMEOUT` (T5)**, never `TIMED_OUT`.
- Applied by the handler when processing a `LOCK_RETRY_REQUESTED` with a wait ≥ 1,800 s.
- Also applied by the reconciler upon finding a `WAITING_LOCK` with `deadlineAt < now`, for example because the retry message was lost.
- If both compete, the conditional write lets only one through, and both write exactly the same result. This makes the outcome deterministic for the implementation and for the tests.

**T9 detail (code 50):**

| Aspect | Behavior |
|---|---|
| States that can receive the 50 | Only `RUNNING`: the code exists only after starting the exec, and the step is marked `RUNNING` before the exec (T6). In `DISPATCHING` no exit code exists, so `DISPATCHING → WAITING_LOCK` is **not** valid |
| Resources released | SSH session closed; SSH semaphore slot; distributed lock (release conditional on the owner). The script has nothing left to clean up: it exits with 50 before any effect and deletes its `/tmp/cicd-{executionId}/` |
| Identity preserved | The same `executionId`, `stepId`, `lockWaitStartedAt`, and accumulated budget. `attempt` and `contentionCount` are incremented; the attempt's `dispatchToken` is closed |
| Retry | A `LOCK_RETRY_REQUESTED` is published with the delay from §7.6's schedule, capped to the remaining budget. If no budget remains: T5 (`LOCK_TIMEOUT`) in the same processing pass |
| Revalidation | Before publishing the retry, the window is checked (V3). If it's no longer valid: T5 with `DEPLOY_WINDOW_CLOSED` instead of requeuing |
| Idempotency | The 50 result is processed in the same handler that opened the session. A redelivery of the original message finds the step in `WAITING_LOCK` with a different `attempt` and does nothing |

### 7.4 `/work` workspace: ownership and cleanup (fixes R2-W4)

| Aspect | Design |
|---|---|
| Instance identity | Each Executor container has a **stable and unique** `instanceId`, configured at deployment time (not random, so that a restart of the same instance recognizes its own orphan work) |
| Guaranteed exclusivity | On startup, `main` acquires `INSTANCE#{instanceId}` with a conditional write (`attribute_not_exists OR leaseExpiresAt < now`) and renews it every 60 s. If another live container has the same `instanceId`, **startup is aborted**. A misconfiguration cannot result in two processes over the same subtree |
| Names | `/work/{instanceId}/{executionId}/{stepId}-{attempt}/` |
| Ownership | An instance only creates, reads, and deletes under `/work/{instanceId}/`. It never touches other subtrees, even if the volume is shared |
| Per-execution cleanup | The `source` handler deletes its directory in `finally` (success or failure) |
| Cleanup on startup | After acquiring the lease, all of `/work/{instanceId}/*` is deleted: with the lease in hand, no other process can have live work there, and this instance's previous process has already died |
| Cleanup of stragglers | Every 10 min, the instance deletes directories under its subtree that are **not** in its in-memory set of active jobs and are older than 30 min (longer than `source`'s deadline) |
| Multiple instances in the future | Safe by construction: disjoint subtrees per `instanceId` and a lease that prevents duplicates. The volume can be local to each container (recommended) or shared, without depending on that difference |

### 7.5 SSH handler resources: acquisition and release (fixes R2-I2)

Acquisition order: **window (check) → distributed lock → SSH semaphore → SSH session → local mutex (taken by the script on the target)**. Released in reverse order, on **every** handler exit.

| Exit | Local mutex (target) | SSH session | SSH semaphore | Distributed lock | Step state |
|---|---|---|---|---|---|
| Success (code 0) | Released by the script when it finishes | Closed | Released | Released (conditional on the owner) | `SUCCEEDED` |
| Script failure (10/20/30/40/other) | Released by the script or the OS when it finishes | Closed | Released | Released | `FAILED` (or `UNKNOWN_TARGET_STATE`) |
| SSH connection failure (before exec) | Never taken | n/a | Released | Released | `FAILED (SSH_CONNECT)` after the retries |
| Code 50 | Never taken (another process holds it) | Closed | **Released** | **Released** | T9 → `WAITING_LOCK` (the waiting step **occupies no** semaphore slot) |
| Step timeout with the script running | Still held by the script, which keeps running: ignores HUP | Closed | Released | **Not released**: renewal stops and the lease expires | `UNKNOWN_TARGET_STATE` (runbook §12.1) |
| `DEPLOY_WINDOW_CLOSED` at V4 | Never taken | Closed | Released | Released | `FAILED` |
| Executor interruption (crash or restart) | Still held while the script is alive; the OS releases it when it finishes | Cut | Disappears with the process (it's in memory) | Lease expires (no renewal) | The reconciler resolves it as `UNKNOWN_TARGET_STATE` |

### 7.6 Lock wait: exact schedule (fixes R2-I1; implements C-1)

Parameters: budget **1,800 s** (30 min); maximum delay per SQS message **900 s** (P-22); base schedule 30, 60, 120, 240, 480, 900 s. Rule: `delay = min(next in the schedule, budget − accumulated wait)`. The **accumulated wait** is always measured as `now − lockWaitStartedAt`, taken from the persisted state, not as a sum of delays.

| Acquisition attempt | Delay published after failing | Accumulated wait planned at the next attempt |
|---|---|---|
| 1 (T2, immediate) | 30 s | 30 s |
| 2 | 60 s | 90 s |
| 3 | 120 s | 210 s |
| 4 | 240 s | 450 s |
| 5 | 480 s | 930 s |
| 6 | 870 s (capped: 870 remain) | 1,800 s |
| 7 | — | If it fails: wait ≥ 1,800 s → `LOCK_TIMEOUT` (T5) |

- **With no contention:** 7 acquisition attempts and 6 requeues at most. No message carries more than 900 s of delay.
- **Real values:** processing time and queue latency make the real wait a bit longer than planned; the decision always uses the real wait.
- **With code 50:** each pass through T9 draws from the same budget and resumes the schedule at the next value.
- **Safety cap:** 10 attempts in total. Reached only if the 50s repeat and produce many short re-entries; reaching it produces `LOCK_TIMEOUT`.

### 7.7 Deploy windows: safe configuration and revalidation (fixes R2-W1, R2-W2, R2-W3)

**Configuration safe by construction (R2-W2).** In the Target Registry, two attributes are **mandatory** on every entry, with no default value:

| Attribute | Values | Validation rule |
|---|---|---|
| `externalDeployers` | List (can be empty `[]`, but must be declared) of opaque identifiers of external systems that also deploy that unit (e.g. job names) | Omitting it = invalid registry |
| `deployWindowPolicy` | `required` \| `not-required` | Omitting it = invalid registry. If `externalDeployers` is not empty, **only** `required` is accepted. `not-required` additionally requires `externalDeployers: []`, and **an empty list requires `not-required`**: the combination `required` + empty list is invalid, because a window must cover a non-empty list of deployers and that target could never deploy *(amendment approved by the owner on 2026-10-05, T-02)* |

- **Versioned form (DD-23):** in Git, `externalDeployers` is declared as `externalDeployersRef` (a reference to the real list, which is not published) or as an explicit `none`. CI validates the form: with a reference ⇒ `required` only; `none` ⇔ `not-required` (2026-10-05 amendment). On startup, the reference is resolved and the list is validated as non-empty.
- **Detection:** validation runs in CI before building the image and again when the Executor starts, which does not start with an invalid registry. A configuration error is detected **before** any deploy.
- **Boundary:** the core does not know what Jenkins is; it only compares opaque lists. For `<PRMS_REPORTING_DEV_TARGET>`, `externalDeployers` lists the jobs from P-13. When Jenkins is retired from that target, the list is emptied and it switches to `not-required`: it is a data change, not a code change.
- **Coverage when opening a window:** `externalJobsDisabled[]` must contain **all** of the target's `externalDeployers`. If any is missing, the opening is rejected.

**Revalidation (R2-W1).** A window valid when the execution started does **not** authorize the deploy indefinitely. `isDeployAllowed(lockKey, needUntil)` is checked with `needUntil = now + the ssh step's timeoutMinutes` (the window must cover the deploy's possible duration) at these points:

| Point | Moment | If not valid |
|---|---|---|
| V1 | Before the first attempt (entering T2 and before T3) | T5: `FAILED (DEPLOY_WINDOW_CLOSED)`, no lock or SSH |
| V2 | On every `LOCK_RETRY_REQUESTED`, before attempting the lock | T5, with no requeue |
| V3 | After receiving code 50, before publishing the retry | T5 instead of requeuing |
| V4 | Right before the SSH exec, with the lock, semaphore, and session already taken | T7: the session is closed without executing the script, and all resources are released |

Operational behavior of T5 and T7 for the window: dependents move to `SKIPPED`, `finally` runs, `DEPLOY_WINDOW_CLOSED` is notified with the target and the reason (`NO_WINDOW`, `EXPIRED`, or `INSUFFICIENT_REMAINING`), and the operator can reopen the window and trigger again. If the window expires **while** the script is running, it is not aborted (interrupting a migration is worse): `windowClosedDuringRun` is marked and a notification is sent.

**Indexed window reconciliation (R2-W3).**

| Aspect | Design |
|---|---|
| Access pattern | "Expired open windows": `Query` on GSI2 with `activeStatus = WINDOW` and `deadlineAt < now`. No scans |
| Indexing | On opening, the `WINDOW#{lockKey}` item receives `activeStatus = WINDOW` and `deadlineAt = closesAt`. On closing (manual or by expiration), both attributes are **removed**, so the item leaves the sparse index |
| Closure | Conditional write (`state = OPEN` and `version`) → `CLOSED`, `closedReason = EXPIRED`, `LOG#` entry, notification. If another process already closed it, no-op |
| Interaction with executions | No direct action on steps. Steps in `WAITING_LOCK` fail at their next revalidation (V2/V3); those in `RUNNING` are not aborted and are left with `windowClosedDuringRun` if their `needUntil` exceeded the closure |
| Volume | At most one open window per target: the `WINDOW` partition is minimal in the PoC |

---

## 8. Frontend / UX Component Architecture

Not applicable: there is no UI. The operator's "interface" is Slack, CloudWatch Logs Insights (saved query "execution timeline"), and reading state in DynamoDB (documented in the runbook).

---

## 9. Shared Contracts / Package Extensions

| Contract | File | Consumers |
|---|---|---|
| Definition schema | `schemas/pipeline.schema.json` | `definition-service`, pipeline authors, validation CI |
| Target Registry schema | `schemas/targets.schema.json` | `definition-service`, SSH handler |
| Event schema | `schemas/event.schema.json` | Executor, ingress, the manual trigger script |
| Deploy script CLI | `deploy-scripts/deploy-container.sh` + `docs/runbook.md` | SSH handler; future P1 waves (~57 pipelines) |
| Worker contract | §6.2 | `<QUALITY_WORKER_FUNCTION>` (`cicd` alias) |

---

## 10. Design Decisions

### Quality-attribute scenarios (Decision Spine, step 1)

| ID | Attribute | Stimulus | Measurable response | Tactics |
|---|---|---|---|---|
| QAS-1 | Reliability | A completion event arrives 2+ times or out of order | 0 duplicate dispatches; 0 invalid transitions over 100 injections | Conditional writes, intent-then-act, idempotency token |
| QAS-2 | Availability | The container dies at any point | Every affected execution ends in a terminal state ≤ deadline + 10 min; lock free ≤ lease | Stateless worker, reconciler, lease |
| QAS-3 | Performance | A completion event enters the queue | Next step dispatched ≤ 60 s p95 (NFR-05) | Long-poll, non-blocking handlers |
| QAS-4 | Security | Normal execution | 0 detectable secrets in ZIPs, objects, image, and logs | The Executor does not read application secrets, redaction, least privilege |
| QAS-5 | Modifiability | A new P1 pipeline | 0 lines of Executor code changed. In the PoC it does require **rebuilding and redeploying the image**, due to DD-19's simplification | Declarative definitions, handler registry, `DefinitionSource` port |
| QAS-6 | Cost | PoC execution | CodeBuild only on image steps; 0 new permanent compute | Lambda/CodeBuild policy, existing host |
| QAS-7 | Scalability | — | **Not architecturally significant** at this volume: deliberately bounded concurrency (NFR-04) | — |

**Tier:** LITE. No scenario requires a different broker, sagas, or managed orchestration. The signals for reconsidering Step Functions are in the proposal §11.

### DD-01 — Hexagonal modular monolith, stateless worker
- **Problem:** separate decisions (domain) from effects (AWS, SSH) to test correctness with no infrastructure and maintain the NFR-01 boundary.
- **Decision:** pure domain (state machine, planner, lock policy) with ports; adapters for AWS, SSH, and Slack. A single deployable.
- **Rejected:** per-capability microservices (no evidence, QAS-7); NestJS (adds a DI container and an HTTP framework that aren't used).
- **Implication:** satisfies QAS-1, QAS-2, and QAS-5. See DD-15 on the framework choice.

### DD-02 — One Standard queue and normalization on receipt
- **Decision:** one queue + a DLQ. Native AWS results are translated into the envelope in `event-router`.
- **Rejected:** one queue per event type (more resources with no benefit); FIFO (adds no correctness; proposal §10.3).
- **Implication:** order does not matter; conditional transitions guarantee correctness.

### DD-03 — DynamoDB as the single source of truth (optimistic concurrency)
- **Decision:** every mutation is conditional on `status` and `version`. Condition failure = "already processed" = no-op with ack.
- **Rejected:** in-memory locks or a mandatory single instance (fragile under restarts); FIFO to serialize per execution.
- **Implication:** allows 2 instances with no changes. Integration tests use DynamoDB Local.

### DD-04 — Intent-then-act with `dispatchToken`
- **Problem:** a crash between the external effect and the record.
- **Decision:** record `DISPATCHING + dispatchToken` before calling AWS. CodeBuild uses that token as `idempotencyToken`. Lambda quality is repeatable. SSH is protected by lock + state.
- **Implication:** a `DISPATCHING` with no `externalRef` past its deadline is resolved by the reconciler: a single re-dispatch with the same token (T13) for `codebuild` and `lambda`; `TIMED_OUT` (T12) for `ssh` and on a second expiration. Detail in §7.3.

### DD-05 — Closed handler registry (Strategy pattern)
- **Problem:** add capabilities with no per-project logic.
- **Decision:** a `StepHandler` interface per type; a fixed registry at startup. An unregistered type is a validation error. Reserved types are in the schema but have no handler.
- **Rejected:** dynamic plugins or embedded scripts (a path toward "another Jenkins").

### DD-06 — Planner as a pure function
- **Decision:** the planner receives a snapshot of the steps' states and the definition, and returns actions. The dispatcher applies each action with a conditional transition.
- **Implication:** the "exactly once" fan-in is guaranteed by the condition, not by the planner. It is testable with no I/O.

### DD-07 — Async Lambda with a dedicated alias
- **Decision:** invoke `<QUALITY_WORKER_FUNCTION>`'s `cicd` alias in Event mode with its own async configuration and Destinations → SQS. **Do not touch the unqualified function**, which Jenkins's PoC pipelines use (P-15).
- **Plan B** (if P-2 or P-18 turn out false): a thin Lambda wrapper that invokes the worker synchronously and publishes the normalized result to SQS.

### DD-08 — CodeBuild per app and environment; one project for server and client
- **Decision:** `prms-reporting-dev` builds both components with `COMPONENT` as an override, in two parallel builds. Additional projects only if the build environment changes (ARM, VPC). Build secrets are declared on the project (DEV only). Completion via EventBridge.
- **Rejected:** a generic shared project (breaks per-environment isolation); reusing `<LEGACY_CODEBUILD_PROJECT>` (fixed key, frontend only; FA §23).

### DD-09 — Distributed lock with lease, fencing, supersede, and bounded wait
- **Decision (lock):**
  - Acquire if the lock does not exist, if `leaseExpiresAt < now`, or if `owner` is already this execution (re-entrant, so a duplicate message does not fail); `fencingToken` +1 only when the owner changes.
  - Renew every 60 s while the SSH lasts.
  - Release conditionally on the owner.
  - Write the target's state conditioned on `fencingToken`.
  - Supersede: with the lock taken, if `lastDeployedSequence > sequence` → `SKIPPED (SUPERSEDED)` and release.
  - After acquiring, the `WAITING_LOCK → DISPATCHING` transition is conditional. If it loses (duplicate message), the handler does **not** release the lock held by the winning attempt.
- **Decision (wait, fixes C-1):** SQS limits the per-message delay to 900 s (P-22), so the 30-minute wait is a **bounded chain of requeues**:
  - The first time the lock is busy, `lockWaitStartedAt` is stored on the step.
  - Each retry publishes `LOCK_RETRY_REQUESTED` per §7.6's exact schedule (**never more than 900 s per message**) and increments `lockWaitAttempts`.
  - On every attempt: `wait = now − lockWaitStartedAt`, measured on the persisted state. If it's ≥ 1,800 s → `LOCK_TIMEOUT` (T5) and notification.
  - With no contention from code 50: at most 7 acquisition attempts and 6 requeues. Safety cap: 10 attempts in total (§7.6).
  - If the retry message is lost, the reconciler closes the step with `LOCK_TIMEOUT` when `deadlineAt` expires (§7.1).
  - A code 50 from the script (DD-22) returns to this same wait via T9 with the budget already consumed.
  - On every attempt, the target's window is revalidated (V2, §7.7).
- **Implication:** DynamoDB's TTL is cleanup only. The distributed lock remains **the** exclusion between Executor executions; DD-22's mutex is a second barrier, not a replacement.

### DD-10 — Script delivered via SFTP from the Executor's image
- **Decision:** the script travels inside the Executor's image (same version as the definitions, DD-19). It is uploaded to `/tmp/cicd-{id}/`, its checksum is recorded, it is executed, and it is deleted.
- **Rejected:** preinstalling at `/opt/deploy` (can drift from Git; requires preparing every host).

### DD-11 — Generic deploy script with migration before the swap
- **Decision:** order is local mutex (DD-22) → pull → temporary configuration → migration with an ephemeral container from the new image → swap → health → pruning (keeping the previous one). The image to restore is the one the container is running when the script starts (§6.4); the target's state in DynamoDB is only a hint.
- **Explicit precondition (fixes S-3): backward-compatible migrations.** The design **does not guarantee** this property for any application; it requires it as a precondition declared by the owning team:
  - Up to the swap, the previous version runs on the new schema.
  - After a rollback from a failed health check (code 40), the previous version runs again on the migrated schema.
  - Both cases are safe only if migrations are backward compatible.
  - The Target Registry requires `migrationCompatibility: backward-compatible` (with `attestedBy`) on every unit with migrations enabled. Without that attribute, a definition that requests migrating is **invalid** and does not run.
  - The attestation belongs to the application team. The platform does not verify it (P-23). **Validating it is a Gate C condition**: no E2E test with migrations runs without it.
  - It is not asserted that PRMS's migrations already satisfy it. **If they are not backward compatible, the automatic rollback (code 40) cannot be assumed safe.** In that case the target does not enable automatic migrations, and the E2E flow with migration stays blocked until another strategy is agreed with the owner.
  - A destructive schema change cannot use this automatic flow; it is out of scope for the PoC.
- **Dependencies:** P-5 (that the image can migrate in ephemeral mode), P-23, and OD-Q5 (how the target obtains its AWS permissions). If P-5 is false, the migration instead runs in the new container started **with a temporary name**, before stopping the old one. The "migrate before stopping" order is preserved.

### DD-12 — NotificationService with providers
- **Decision:** `NotificationProvider` interface; Slack in the PoC (Web API, threads). `EVT#` marks avoid duplicating notifications on redelivery. Best-effort.

### DD-13 — Reconciliation via the same queue
- **Decision:** EventBridge Scheduler publishes `RECONCILE_TICK` every 5 min to the queue; any instance handles it.
- **Rejected:** an internal cron (would duplicate with 2 instances and depends on the process being alive).

### DD-14 — Visibility heartbeat for long handlers
- **Decision:** base visibility of 120 s; while a handler is alive (clone, SSH), it is extended every 60 s. If the process dies, the message reappears and the state decides (no-op or reconciliation).

### DD-15 — TypeScript over Node.js LTS, no web framework
- **Decision:** strict TypeScript and Node.js LTS. Manual dependency composition in `main`. Ajv for schemas, AWS SDK v3, `ssh2`, a JSON logger, and `vitest`.
- **Status:** the proposal's Q8 was left *partially resolved* with this recommendation. **The owner can change it in this revision** (standalone NestJS is the acceptable alternative).

### DD-16 — Executor's AWS credentials behind the SDK's standard chain (OD-Q12 open)
- **Decision:** the Executor implements no mechanism of its own: it uses the SDK's default credential chain. This way, whatever answer OD-Q12 gets (host role, credentials delivered only to the container, Roles Anywhere, `credential_process`) is resolved at **deployment time**, not in the code.
- **What is not decided:** which of those mechanisms. It blocks deployment in DEV (Gate B), not the code.
- **Constraint that does apply (NFR-02):** the chosen mechanism must not expose the credentials to other containers on the host, nor be a long-lived static key without explicit justification.

### DD-17 — Infrastructure as an inventory until OD-Q7
- **Decision:** resources are specified in `infra/RESOURCES.md` (name, type, configuration, permissions) as a contract. Translating it to CDK or Terraform is a task blocked by OD-Q7.
- **What is not decided:** the tool.

### DD-18 — Executor host parameterized (OD-Q11 open)
- **Decision:** the runtime remains **a small Docker container on the existing microservices server** (not Fargate). The image is host-agnostic. `executor/deploy/` describes what the host must provide: Docker, egress 443 and 22, a `/work` volume (preferably local to the container; §7.4 makes it safe even if shared), a unique and stable `instanceId` per container, CPU and memory limits, credentials via DD-16, and no Swarm.
- **What is not decided:** the specific host, nor whether a PROD host is acceptable (proposal risk R2; escalated to the owner at Gate B).

### DD-19 — Definitions behind `DefinitionSource`; bundled into the image as a PoC simplification
- **Decision:** the core (`definition-service`, planner, handlers) obtains definitions, the registry, and the script **only** through the `DefinitionSource` port. It returns the content and its `definitionRef`, and nothing in the core knows where they come from. In the PoC, the `bundled-definition-source` implementation reads `pipeline-definitions/`, `schemas/`, and `deploy-scripts/` copied into the image at build time. `definitionRef` = the platform repo's commit, injected at build time.
- **This is a PoC simplification, not the target architecture.** Changing a definition requires rebuilding and redeploying the image. That satisfies the letter of NFR-08 (no code changes to the Executor), but it is not an operational "just YAML".
- **Future migration (without touching the core):** a `versioned-external-definition-source` implementation (a Git repo pinned by commit, or a versioned bucket) replaces the adapter in `main`'s wiring. The port's contract already includes `definitionRef`, which FR-01 requires recording per execution.
- **Rejected for the PoC:** cloning the definitions on every execution (another network and credential dependency); syncing to S3 (another moving piece).

### DD-20 — Identity and dedupe with a leased claim (fixes S-1)
- **Decision:** dedupe is protected with the same lease pattern as the deploy lock.
  1. **Claim:** `DEDUPE#{requestId}` is created with `attribute_not_exists`, state `CLAIMED`, its own random `claimToken`, and `claimLeaseExpiresAt = now + 2 min`.
  2. **Sequence:** the counter is incremented and the obtained number is stored in the dedupe with a conditional write (`claimToken` = its own and `sequence` unassigned). If the write fails, another process already took the claim: it is abandoned with nothing created (the number is left as a gap).
  3. **Execution:** the `executionId` is derived from the **stored** `sequence` and the execution is created with `attribute_not_exists`. Repeating this step is idempotent: same id, same conditional creation.
  4. **Binding:** the dedupe moves to `BOUND` with the `executionId`, conditioned on the `claimToken`.
- **Redelivery of the same `requestId`:**

| Dedupe state on arrival | Action |
|---|---|
| Does not exist | Step 1 |
| `BOUND` | No-op, ack |
| `CLAIMED`, valid lease, different `claimToken` | Do not process; **do not** ack (the message returns after visibility) |
| `CLAIMED`, valid lease, **same** `claimToken` | Only happens within the same processing pass (the handler retries its own writes after a transient DynamoDB error; the `claimToken` is random per processing pass, so an SQS redelivery always brings a different one). Resumes from the first incomplete step: no `sequence` → step 2; with `sequence` → step 3 (idempotent); execution already created → step 4 |
| `CLAIMED`, expired lease | Take the claim with a conditional write on the previous `claimToken` (new token and lease). If a `sequence` is already stored, it **is reused** and resumes at step 3 (if the execution already exists, the conditional creation is a no-op and it moves to 4); otherwise, step 2 |
| `CLAIMED` and the conditional take fails | Another process took it first: do not process, do not ack |

- **Guarantee:** two concurrent processes never create two executions. Only the current owner of the claim writes the `sequence`, and the execution is created conditionally from the stored sequence (FR-03, FR-07). The other guarantees do not change: duplicate events for an already-created execution produce no double deploys or migrations (DD-03, DD-04, DD-09, DD-22, and §7.3), and transitions remain deterministic because each one is conditional on state, `attempt`, and `version`.
- **Accepted risk:** a crash between the increment and its record leaves a gap in the sequence (FR-03 requires monotonicity, not contiguity).

### DD-21 — Per-target deploy windows (transient; fixes S-4)
- **Problem:** FR-18 requires that there be no real deploys onto a target shared with Jenkins without a confirmed window. A lock does not cover this (Jenkins does not participate), and a human-only procedure has no technical backing.
- **Decision:** a **generic** "deploy window" capability, governed by each target's **mandatory** `deployWindowPolicy` and `externalDeployers` attributes (configuration safe by construction, §7.7).
  - If the policy is `required`, the SSH handler revalidates the window at V1–V4 (§7.7). If there is no `OPEN` window covering the deploy's duration → `DEPLOY_WINDOW_CLOSED`, without executing the script, with a notification.
  - Windows are opened and closed by the operator with the `tools/` CLI, via `DEPLOY_WINDOW_*` events.
  - Opening requires `openedBy` and an `externalJobsDisabled[]` that covers **all** of the target's `externalDeployers`. That is FR-18's "confirmed list".
  - Maximum duration 8 h, with automatic closure by the reconciler via an indexed query (§7.7).
  - History stays in DynamoDB and is summarized in `docs/jenkins-coexistence-log.md` (format: target, opened, closed, close reason, disabled jobs, executions within the window, incidents).
- **Boundary:** the core contains no Jenkins logic. "Jenkins" appears only as **data** (opaque identifiers in `externalDeployers` and in the window) and in the runbook. It is transient: when Jenkins is retired from the target, `externalDeployers` is emptied and it switches to `not-required`, with no code change. The capability continues to serve as a generic maintenance window.
- **Rejected:** a global "Jenkins active" flag in the Executor (Jenkins logic in the core); integration with Jenkins's API to disable jobs (coupling and new credentials).

### DD-22 — Local mutex on the target as a second barrier (fixes S-2)
- **Problem:** if the Executor loses connectivity with DynamoDB (or its lease expires) while its SSH session is still alive, another execution can acquire the distributed lock and launch a second, physically concurrent deploy or migration. The `fencingToken` protects only the write to DynamoDB.
- **Decision (two layers, neither replaces the other):**
  1. **Layer 1, distributed lock in DynamoDB (DD-09):** remains the exclusion between Executor executions, the one that orders the work, applies supersede, and provides traceability.
  2. **Layer 2, local mutex on the target:** before any effect, the script takes a non-blocking file lock by `lockKey` (§5.3). The operating system releases it when the process dies. If it is taken, it exits with **50 (`TARGET_BUSY`) having done nothing** and reports who holds it. This way, even if the distributed lock has expired, the physical operation (migration and swap) **never** runs twice at once on the host.
- **Flow:**

```text
Executor ─► DynamoDB distributed lock (layer 1: Executor vs Executor)
         ─► SSH ─► target: local kernel mutex (layer 2: protects the physical operation)
                          ─► pull ─► migration ─► swap ─► health
```

- **Executor behavior:**
  - Code 50 → T9 transition (§7.3): closes the session, releases the SSH semaphore and the distributed lock, revalidates the window (V3), and returns to `WAITING_LOCK` with the accumulated wait budget (DD-09, §7.6).
  - If a lease renewal fails, the Executor **does not abort** the remote script: interrupting a migration is worse. It marks `lockLostDuringRun` on the step and, when it finishes, records the script's real result. Resource release on every exit: §7.5.
  - If the target's state write is rejected due to fencing, it notifies the discrepancy. The next deploy restores from the image that is actually running (§6.4), not from DynamoDB.
- **Known limit:** layer 2 protects only deploys that go through this script. Jenkins's jobs do not use it; DD-21 acts against those.

### DD-23 — Real identifiers kept out of Git (publication policy)
- **Problem:** the Target Registry and the definitions are versioned, but the host, user, host key, real container and ECR repo names, and external job IDs must not be published.
- **Decision:**
  - Versioned registry entries contain only **semantic identifiers and references**: `targetId` (e.g. `prms-reporting-dev`), `connectionRef`, `credentialRef` and `hostKeyRef` (Secrets Manager references), a logical `lockKey`, `deployWindowPolicy`, `externalDeployersRef`, `migrationCompatibility`, logical container names, `portRef` and `imageRepositoryRef`.
  - **Amendment (owner ruling, 2026-10-05; least privilege):** `connectionRef` resolves to the **non-sensitive** connection identity only (JSON `{host, port?, user?}`); a resolved identity carrying any credential-looking field aborts startup. The SSH key or password lives behind the separate, required `credentialRef`, read only by the SSH handler at the point of use and kept in memory. At startup, credential references (`credentialRef`, the repository `credentialRef`, the Slack `tokenRef`) are **existence-checked only** through `SecretProvider.exists` (AWS: `DescribeSecret`), never read; `getSecret` is used at startup only for non-sensitive identifier references. Error and log text never contains a resolved value, only reference names or target IDs.
  - Concrete values (host, port, user, credential, host key, real container and port names, ECR repos, job IDs) live in Secrets Manager entries or deployment configuration, and `SecretProvider` resolves them at the point of use.
  - `definition-service` validates the **structure** in CI and the **resolution** at startup: the Executor does not start if a reference does not resolve (identifier references) or does not exist (credential references). This keeps it safe by construction (§7.7).
  - `externalDeployers` is validated against `externalDeployersRef`'s resolved list.
- **Does not change the architecture:** the core still works with opaque references; only **where** the values live changes.
- **Rejected:** an unversioned YAML overlay on the host (another unaudited piece of configuration) and publishing the values in the repo (contradicts the owner's policy).

### Reversal challenge (Step 2.3)

Review done inline, with no subagent. Question: "what breaks if this is removed?"

| Delivered behavior being reverted | What breaks | Answer in the design |
|---|---|---|
| Secrets inside the quality ZIPs (today) | Tests that read `.env` or compile with `environment.ts` could fail | OD-Q13 open. The handler never includes them in any case. If confirmed, the worker reads them by reference (requires its own DEV read-only permission). The worker's task verifies this first |
| `docker rmi N-1` on the target | Disk growth on `<PRMS_REPORTING_DEV_TARGET>` | The script prunes images older than the previous one (DD-11) |
| `aws configure set` on the target | Jobs that depend on leftover keys | Existing keys **are not deleted** (NFR-10). The script just stops depending on them (FR-13, OD-Q5) |
| Recording in `<JENKINS_EXECUTIONS_TABLE>` | Unknown consumers would stop seeing the PoC's executions | OD-Q14 open. Accepted risk for the PoC: Jenkins's executions keep writing |
| Synchronous invocation of the worker | None of the Jenkins pipelines (a dedicated alias is used) | DD-07 |
| Kill → migrate → run | Nothing depends on the cut; availability improves | DD-11 |

---

## 11. Premise Ledger

**Count:** 4 verified (P-20, P-21, P-25, P-26 — the latter in T-00) · 23 `UNVERIFIED` (High: 10 — P-2, P-5, P-6, P-10 (conditional), P-11, P-13, P-14, P-19, P-23, P-24 · Low: 13 — P-1, P-3, P-4, P-7, P-8, P-8b, P-9, P-12, P-15, P-16, P-17, P-18, P-22)
**`T-nn` task IDs:** aligned with `tasks.md` (Phase 3).
**Blast-radius triggers:** `shared-state` triggers: the deploy unit (P-13), the target's credentials (P-14), and the DEV DB (P-24) are shared with Jenkins jobs. `consumer` triggers (the worker's async configuration and shared ECR repos). `live-path` does not apply: the design does not change existing code; all the code is new, and there is no user action on previous code whose path needs testing.

**Citation note:** the workspace is not a git repository, so *Verified at* cannot carry a SHA. The FA is a document: per rule (d) it is a **secondary** source. Rows that rely on it remain `UNVERIFIED` and mention it as a trail for whoever verifies them.

| # | Claim | Class | Citation (as run) | Verified at | If false | Settled by |
|---|---|---|---|---|---|---|
| P-1 | `<QUALITY_WORKER_FUNCTION>` returns `status, failedCommand, exitCode, error, logS3Uri, logUrl` | data-env | `UNVERIFIED — confirm at source before relying on it` (trail: FA L1023) | — | Changes the §6.2 mapping (Low) | Lambda handler task, first step: read the worker's code or configuration. Owner: T-27 |
| P-2 | The worker accepts the input fields the Executor will send (`sourceRef`, `task`…) and requires no secrets in the ZIP | data-env | `UNVERIFIED — confirm at source before relying on it` | — | DD-07's Plan B (wrapper) or OD-Q13 (High) | T-27 |
| P-3 | Containers `<SERVER_CONTAINER>` <SERVER_PORT_MAPPING> and `<CLIENT_CONTAINER>` <CLIENT_PORT_MAPPING> on `<PRMS_REPORTING_DEV_TARGET>` | data-env | `UNVERIFIED — confirm at source before relying on it` (trail: FA L1107, L595) | — | Changes the registry values (Low) | Reading the reference Jenkinsfile, in the registry task. Owner: T-32 |
| P-4 | The PRMS Reporting server exposes `migration:check:ci` and `migration:run` | data-env | `UNVERIFIED — confirm at source before relying on it` (trail: FA L1106) | — | Changes the registry arguments (Low) | T-32 |
| P-5 | The server image can run the migration as an ephemeral container (includes the CLI and migration files) | existence | `UNVERIFIED — confirm at source before relying on it` | — | DD-11 uses the "container with a temporary name" variant (High) | Inspection of `<PRMS_REPORTING_REPO>`'s Dockerfile, in the script task. Owner: T-33 |
| P-6 | `<PRMS_REPORTING_DEV_TARGET>` has a network path to the DEV DB (migrations currently run from the target) | data-env | `UNVERIFIED — confirm at source before relying on it` (trail: FA L1106) | — | The "target migrates" model does not apply: a VPC Lambda would be needed (High) | First run of the script in a window with `--migration-check`. Owner: T-33 |
| P-7 | A single AWS account `<AWS_ACCOUNT_ID>` for all environments | data-env | `UNVERIFIED — confirm at source before relying on it` (trail: FA L82) | — | Isolation could be done by account; policies change (Low) | Owner (CI/CD Platform Team) at Gate B |
| P-8 | The ECR repos `<ECR_REPOSITORY>` (server and client) exist | existence | `UNVERIFIED — confirm at source before relying on it` (trail: FA L595) | — | Create new repos and adjust the inventory (Low) | T-28 |
| P-8b | Those repos accept non-numeric tags (no immutability or rules preventing it) | data-env | `UNVERIFIED — confirm at source before relying on it` (no trail in the FA) | — | Changes the image tag format (FR-10) (Low) | T-28 |
| P-9 | The frontend build needs `environment*.ts` with secret values at build time | data-env | `UNVERIFIED — confirm at source before relying on it` (trail: FA §7.1) | — | CodeBuild needs no secrets; the project is simplified (Low) | T-28 |
| P-10 | `<PRMS_REPORTING_REPO>` requires a credential for the clone and its size fits in `/work` with N=2 | data-env | `UNVERIFIED — confirm at source before relying on it` (OD-Q15) | — | Changes the credential type and the sizing. **Conditional High**: only if the clone doesn't fit with N=2; if it fits, Low | OD-Q15. Owner: CI/CD Platform Team; measured in T-29 |
| P-11 | The Executor's host reaches `<PRMS_REPORTING_DEV_TARGET>:22` and AWS, GitHub, and Slack over 443 | data-env | `UNVERIFIED — confirm at source before relying on it` (OD-Q11) | — | DD-18: another host or alternative A' (High) | Network spike. Owner: T-23 |
| P-12 | Jenkins's jobs do not participate in any lock mechanism the Executor could use | other | `UNVERIFIED — confirm at source before relying on it` (trail: FA §13: `lock()` = 0) | — | A shared lock could be integrated instead of windows (Low) | Configuration inventory (jenkins-config-inventory). Owner: CI/CD Platform Team |
| P-13 | **shared-state:** the `<SERVER_CONTAINER>` and `<CLIENT_CONTAINER>` unit is also deployed by: seven `<JENKINS_JOB_ID>` (identifiers in the local job inventory) (each one's mechanism: `docker kill/rm/run` of the same name via SSH) | shared-state | `UNVERIFIED — confirm at source before relying on it` (trail: FA L595 lists 7 files and "up to 8") | — | The list of jobs to disable in FR-18 is incomplete: collision risk (High) | Job names via the inventory (Q1), loaded into the target's `externalDeployers` (§7.7), which opening a window requires to be fully covered. Owner: Jenkins admin at Gate C |
| P-14 | **shared-state:** other jobs that deploy on `<PRMS_REPORTING_DEV_TARGET>` depend on the leftover AWS keys on the host (e.g. `<JENKINS_JOB_ID>`, `<JENKINS_JOB_ID>`) | shared-state | `UNVERIFIED — confirm at source before relying on it` (trail: FA §9.3.5, which names the jobs; L1123 only gives the recommendation) | — | If the script or a profile change invalidated them, those jobs would break; DD-11 and NFR-10 already avoid touching them (High) | OD-Q5. Owner: infra |
| P-15 | **consumer:** the function `<QUALITY_WORKER_FUNCTION>` is invoked by Jenkins pipelines (five `<JENKINS_JOB_ID>`, identifiers in the local inventory) **unqualified, not via the `cicd` alias**. The invocation mode (synchronous or asynchronous) **is not established**: the FA only names `aws lambda invoke`, with no `--invocation-type` indicated | consumer | `UNVERIFIED — confirm at source before relying on it` (trail: FA L259 "PoC: 6"; L201, L204, L224–226 name the pipelines, not the mode) | — | DD-07 configures async behavior only on the `cicd` alias, so it does not affect unqualified invocations in any mode. There would only be a collision if some pipeline invoked the `cicd` alias, which does not yet exist (Low) | T-27 |
| P-16 | **consumer:** the ECR repos `<ECR_REPOSITORY>` are read and cleaned up by Jenkins jobs with integer tags (`rmi N-1` on the target) | consumer | `UNVERIFIED — confirm at source before relying on it` (trail: FA L595, §9.1) | — | The `prms-reporting-dev-N` tags do not match `N-1`; if there were broad-pattern cleanup on the repo (ECR lifecycle), it could delete the PoC's previous images (Low) | T-28: review the ECR repo's lifecycle policy |
| P-17 | Lambda Destinations supports a Standard SQS queue as the destination for an alias's async invocation | other | `UNVERIFIED — confirm at source before relying on it` | — | DD-07's Plan B (Low) | T-27 |
| P-18 | `StartBuild` supports `idempotencyToken` and an S3 source override; the status event includes `build-id` | other | `UNVERIFIED — confirm at source before relying on it` | — | DD-04 would use its own dedupe by `dispatchToken` before calling (Low) | T-28 |
| P-19 | The owner's microservices server is not the PROD host where `docker swarm leave --force` runs | other | `UNVERIFIED — confirm at source before relying on it` (OD-Q11; trail: FA L633, L599) | — | Proposal risk R2: escalated to the owner before Gate B (High) | OD-Q11. Owner: CI/CD Platform Team |
| P-20 | The workspace contains no code, `general-setup` templates, or baseline | existence | `find . -type f` → 2 root `.md` files + `docs/specs/changes/cicd-executor-poc/{proposal,requirements}.md` (when writing v1; afterward only `design.md` and `judgment.md` were added to that folder); `ls -R docs` → only `specs/changes/cicd-executor-poc` | n/a (no git; 2026-10-05) | Existing code would need to be extended (High) | — |
| P-21 | Outside this spec's folder, no reference to the method's previous name remains. Inside it, it appears only as a record of the renaming: this row and `judgment.md` | other | `grep -rnil "akilia" .` → 2 files: `docs/specs/changes/cicd-executor-poc/design.md` and `…/judgment.md`. `grep -rnil "akilia" . \| grep -v "^./docs/specs/changes/cicd-executor-poc/"` → 0 lines (exit 1). Run after the v2 review | n/a (no git; 2026-10-05, v2 review) | Naming inconsistency in source documents (Low) | — |
| P-22 | SQS limits the per-message delay (`DelaySeconds`) to 900 s | other | `UNVERIFIED — confirm at source before relying on it` (documented SQS limit; not run against AWS) | — | If the limit were higher, DD-09 remains correct: it could just make fewer requeues (Low) | T-26 (lock-retry integration test) |
| P-23 | PRMS Reporting's migrations are backward compatible: the previous version works on the migrated schema | data-env | `UNVERIFIED — confirm at source before relying on it` (the design does **not** guarantee it: it requires it as an attested precondition, DD-11) | — | The health-check rollback (code 40) and the window between migrating and doing the swap leave a broken version on the new schema. The target cannot enable automatic migrations (High) | `migrationCompatibility` attestation from the PRMS Reporting team in the registry. Owner: PRMS team (Gate C) |
| P-24 | **shared-state:** PRMS Reporting's DEV DB is shared by Jenkins variants from other branches (`dev`, `performance-refactor`, `dev-migration-review`) that deploy the same unit (P-13). Each one runs its own conditional migrations against that DB, via the same SSH-to-target mechanism | shared-state | `UNVERIFIED — confirm at source before relying on it` (trail: FA L595 names the different branches; that the DB is the same is an inference from the proposal's R9) | — | Migrations from other branches can leave the schema ahead of or diverging from the code the PoC deploys. Affects P-23, the validity of the E2E tests, and the rollback (High) | Mitigations: DD-21 window (no active jobs during the test), DEV DB snapshot, and recording migration state before and after (Gate C). Confirmation of the shared DB: PRMS team |

| P-25 | The canonical repository `onecgiar-cicd-platform` exists, is readable, and has a `main` branch | existence | `git ls-remote https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform.git` → `41f4c3ee0437a9c10beb699d6dbb07c11c1935f8 HEAD` and `… refs/heads/main` (exit 0) | `41f4c3e` (remote; 2026-10-05) | The repo would need to be created, or access requested, before the first task (High) | — |
| P-26 | The remote's initial commit has no content that clashes with §4.2's structure | data-env | `git ls-tree -r --name-only origin/main` → `LICENSE` (only file; no remote `.gitignore`). Verified in T-00 | `41f4c3e` (2026-10-05) | The first task adjusts the structure or integrates the existing content (Low) | First execution task (linking the workspace to the remote). Owner: T-00 |

**Handoff to `tasks.md`:** the `consumer` rows P-15 and P-16 go into the `Consumers` field of T-27 and T-28. Every `UNVERIFIED` row with a task owner is resolved as that task's **first step**. Those that depend on an OD (P-10, P-11, P-14, P-19) remain open until the owner answers. P-23 and P-24 are Gate C conditions, owned by the PRMS team.

---

## 12. Risks, observability, and rollback (Full depth)

| Topic | Design |
|---|---|
| Observability | JSON logger; EMF metrics `ExecutionsStarted/Succeeded/Failed`, `StepDurationMs` per type, `LockWaitMs`, `DispatchLatencyMs` (NFR-05); alarms DLQ > 0, `ApproximateAgeOfOldestMessage` > 10 min, no `ExecutorHeartbeat` within 5 min |
| Liveness | The Executor emits a heartbeat metric every minute and writes a file for the container's healthcheck. It exposes no ports |
| Security | The logger's redaction covers tokens, `password`, `secret`, PEM keys, and presigned URLs. The image runs as non-root, with no Docker socket |
| Shared DEV DB (P-24, proposal's R9) | Neither the lock nor the mutex cover it. Mitigation: real deploys only within a DD-21 window with the other variants' jobs disabled; DEV DB snapshot before the first test; migration-state recording (`migration:check:ci`) before and after each test in the coexistence log |
| Migrations not backward compatible (P-23) | Automatic migrations are not enabled without the attestation in the registry (DD-11) |
| Lease lost during the SSH | DD-22's second barrier (local mutex); `lockLostDuringRun` and discrepancy notification |
| PoC rollback | Jenkins intact. Jobs are re-enabled. `cicd-poc` resources are destroyed (inventory). On the target, the previous image is restored with the same script (`--image` = previous) or redeployed with Jenkins |
| Execution rollback | Failed health → automatic restoration (code 40), **safe only if P-23 holds**. Failed migration → the previous version was never stopped |

### 12.1 Runbook: possibly stuck local mutex (R2-I4)

**Principle:** the mutex is the **kernel's lock** on the file, not the file's existence. If the process that held it died, the operating system has already released it. A "stuck" mutex can only be a **live** process holding it. **Never delete the lock file to "release" it**: that releases nothing if the holder is alive, and if it isn't, there is no need.

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

---

## 13. Budget (Step 2.4)

| Metric | Estimate |
|---|---|
| Expected tasks | **37** (re-estimated in Phase 3: decomposing into separately reviewable tasks and splitting by gates gives 23 for Gate A, 9 for Gate B, and 5 for Gate C; T-00 through T-36. Previously: 25. The Gate C ones are mostly operational and validation work, with little code). Gate D is recorded, but is out of scope for the PoC |
| Expected LOC | **~8,700** (Executor ~3,900 including the instance lease and the explicit state machine, tests ~3,500, schemas and definitions ~450, script ~400, operator CLI ~150, infrastructure ~600 per OD-Q7). Includes ingress |
| Expected review rounds | **~50** (re-estimated: 1.5 per code task and 1 per operational or documentation task) |

Matches the **Full** depth. Lowering the depth is not recommended. **Implementing across several PRs** is recommended, with the strategy defined in `tasks.md`. This is a tripwire: if `/akili-execute` exceeds these figures, it stops and escalates.

---

## 14. Gates and blockers

| Gate | Meaning | Open decisions and premises that block it |
|---|---|---|
| **A** | Design ready for `tasks.md` and implementing the core (domain, schemas, validation, adapters with DynamoDB Local, and tests) | **No OD.** No `UNVERIFIED` premise blocks it: each one has an owning task or a later gate |
| **B** | Executor infrastructure and deployment in DEV | OD-Q11 (host; P-19), OD-Q12 (Executor's credentials), OD-Q7 (IaC), P-11 (network spike), P-7. For specific increments: OD-Q15/P-10 (source), OD-Q13/P-2 (Lambda) |
| **C** | End-to-end deploy on `<PRMS_REPORTING_DEV_TARGET>` | OD-Q5 (target's credentials; P-14), P-13 (jobs in `externalDeployers` and an approved window), P-23 (migration attestation), P-24 (shared DB: snapshot and recording), P-6 (target → DB network), P-5 (ephemeral migration) |
| **D** | Retire Jenkins (any job) | `jenkins-config-inventory` complete, B1 tested, H1, H2, H3, SDK steps, Jira Builds API, OD-Q14 (consumers of `<JENKINS_EXECUTIONS_TABLE>`), and every wave validated |

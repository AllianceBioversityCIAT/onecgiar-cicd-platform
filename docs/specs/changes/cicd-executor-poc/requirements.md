# Requirements — CI/CD Executor PoC (PRMS Reporting DEV)

> **In one line:** a lightweight Executor must run PRMS Reporting DEV end to end without Jenkins: coordinating Lambda, CodeBuild and SSH from declarative definitions, with idempotency under at-least-once delivery, per-target locks and persistent state. **It cannot compile, connect to databases, read application secrets, or contain per-project logic.**

---

## 1. Document Control

| Field | Value |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Phase | Phase 1: Requirements |
| Depth | **Full** (new infrastructure, concurrency, security, deployment and migrations) |
| Type | Change |
| Approval Mode | `gated` (inherited from the proposal) |
| Source of intent | `proposal.md` v2, **approved** by the owner on 2026-10-05 |
| Evidence | **FA** = `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md`; **ctx** = `JENKINS_REPLACEMENT_AKILI_CONTEXT.md` |
| Templates | `docs/specs/general-setup/` does not exist, nor does a baseline (`CLAUDE.md`, PRD or TRD). Checked with `ls -R docs` on 2026-10-05: only `docs/specs/changes/cicd-executor-poc/proposal.md`. The minimal structure of the `/akili-specify` command is used |
| ID pattern | There is no previous one. `FR-nn` (functional), `NFR-nn` (non-functional) and `OD-xx` (open decision) are adopted |
| Date | 2026-10-05 |
| Owner | CI/CD Platform Team |
| Review | **Full** Judgment Day (3 rounds; **APPROVED** result; `judgment.md`). Adjustments approved by the owner. **Round 1:** code 50 and migration precondition (FR-13), technical backing of FR-18, F18–F19 (FR-16), scope of FR-02, clarification of NFR-08. **Round 2:** single allowed backward transition (FR-05), mandatory window policy (FR-02), window revalidation (FR-18). **After:** canonical `LOCK_TIMEOUT` outcome when the lock wait is exhausted (FR-11) and sanitization of internal identifiers for publishing to Git |

**Rule for this specification:** Q5, Q7 and Q11–Q15 are **open decisions**. They are identified as `OD-Qn` (§9). No requirement assumes their answer. Where one of them conditions a requirement, the dependency is declared and the requirement is written without depending on that choice.

---

## 2. Executive Summary

| Question | Answer |
|---|---|
| What is being built? | A containerized Executor that consumes SQS events and advances pipeline executions from versioned YAML definitions. It dispatches work to Lambda (quality), CodeBuild (images) and SSH (deploy on the target) |
| What for? | To demonstrate that the responsibilities of a pipeline representative of Jenkins can be replaced **without another CI server and without another Jenkins** |
| With which pipeline? | PRMS Reporting DEV (pattern P1, shared by ~57 pipelines; FA §4, §23) |
| What makes it correct? | Idempotency under at-least-once delivery, per-deploy-unit locks, persistent state, migration before stopping the old version, and retention of the previous image |
| What makes it "not Jenkins"? | A closed vocabulary of steps, with no expressions or project logic, no toolchains, no access to DBs or application secrets (NFR-01) |
| What is out of scope? | Non-Docker builds (B1), SDK-based deploys (S3, CloudFront, Lambda, CloudFormation), Jira, the retirement of Jenkins, and remediation of historical security debt |

---

## 3. Glossary

| Term | Definition |
|---|---|
| Executor | Coordinating service. Receives, resolves the definition, coordinates, dispatches, logs and notifies |
| Pipeline Definition | Versioned YAML document that describes a pipeline's repository, steps, dependencies and notifications |
| Target Registry | Versioned document that describes deploy destinations: host, user, credential and host key references, containers, ports and lock key |
| Execution | A run of a pipeline, identified by `executionId` |
| `executionId` | `<pipelineId>-<sequence>`, with a monotonic sequence per pipeline (e.g. `prms-reporting-dev-184`) |
| Step | Declared unit of work of a type from the vocabulary (`lambda`, `codebuild`, `ssh`, `notify`). `source` is implicit |
| Capability | Generic implementation of a step type in the Executor |
| Deploy unit | Set of containers on a host that are deployed together and share a lock |
| Lock | Mutual exclusion with a lease over a deploy unit |
| Supersede | Rule by which a deploy of an older sequence is skipped if the target already has a newer one |
| Event | Message in SQS with the defined envelope (FR-04) |
| Reconciler | Periodic process that closes stuck executions and recovers lost events |
| Test window | Period during which the Jenkins jobs that touch the PoC's target are disabled |
| Deploy script | Versioned script that the target executes: pull, migration, swap, health check and cleanup |
| OD | Open Decision, inherited from the proposal's questions |

---

## 4. System Context & Scope

### 4.1 Current context (cited)

| Statement | Evidence |
|---|---|
| PRMS V2 Reporting DEV clones `<PRMS_REPORTING_REPO>`, writes secrets into the tree, creates ZIPs for quality in Lambda (`<QUALITY_WORKER_FUNCTION>`, ×2 in parallel), builds with Docker and deploys via SSH with a password on `<PRMS_REPORTING_DEV_TARGET>`, with conditional migrations | FA §23 (reference `<JENKINS_JOB_ID>`). The Jenkinsfile is not in this workspace: `UNVERIFIED — confirm at source before relying on it` for details not cited by line |
| Containers `<SERVER_CONTAINER>` (<SERVER_PORT_MAPPING>) and `<CLIENT_CONTAINER>` (<CLIENT_PORT_MAPPING>). Up to 8 jobs deploy onto them from different branches | FA §10.3, §23 |
| The quality ZIPs include secrets. The CodeBuild's S3 key is fixed (`codebuild/frontend.zip`) | FA §1.5, §23 (points 1 and 2) |
| If a migration fails, the old container has already been removed. `rmi N-1` removes the previous image. There is no rollback | FA §11.4, §16 |
| The target receives AWS keys via `aws configure set` and other jobs depend on them | FA §9.3.5, §12.2.1, §23 (point 4) |
| There is a single AWS account (`<AWS_ACCOUNT_ID>`, `<AWS_REGION>`) | FA §2 |
| Worker output contract: `status, failedCommand, exitCode, error, logS3Uri, logUrl` | FA §21.7. The input format is `UNVERIFIED — confirm at source before relying on it` |
| Jenkins triggers, job names and concurrency are not in the repo | FA §19 B2 |

### 4.2 Scope

| In | Out |
|---|---|
| Definitions and Target Registry with validation | Non-Docker builds (B1). Steps `lambda-deploy`, `s3-sync`, `cloudfront-invalidate`, `cloudformation`, `http-check` (reserved in the schema only) |
| Manual trigger and, as a SHOULD, GitHub webhook | `schedule` trigger, typed parameters, re-run, `when` (reserved) |
| `source`, `lambda`, `codebuild`, `ssh`, `notify` capabilities (Slack) | Jira Builds API, Teams, email |
| State, idempotency, locks, supersede, reconciler | Retirement of Jenkins jobs; changes to Jenkinsfiles |
| Deploy script contract on the target, including migration | SSH → SSM migration |
| Coexistence procedure with Jenkins | Remediation of historical security debt (parallel track) |
| PoC's DEV AWS resources | STAGING or PROD resources |

### 4.3 Context diagram

```text
Operator / GitHub ──> SQS ──> Executor ──> Lambda (quality) ──┐
                       ▲         │  ├────> CodeBuild (image) ─┤ completion events
                       └─────────┼──┴──────────────────────────┘
                                 ├──> SSH ──> target ──> deploy script ──> (migration → DEV DB)
                                 ├──> DynamoDB (state, locks)   S3 (artifacts)
                                 └──> Slack · CloudWatch · Secrets Manager
```

---

## 5. Stakeholders / Personas

| Persona | Needs | Key requirements |
|---|---|---|
| Platform operator (DevOps) | Trigger, observe and diagnose executions without Jenkins | FR-03, FR-15, FR-17, NFR-06 |
| Pipeline author | Describe a pipeline using only YAML | FR-01, FR-02, NFR-08 |
| PRMS Reporting team | DEV deployed correctly and informed of failures | FR-12, FR-13, FR-14 |
| Jenkins administrator | Pause and resume, in a controlled way, the jobs that touch the target | FR-18 |
| Security owner | No secrets in artifacts nor long-lived keys; environment separation | NFR-02, NFR-09 |
| Architecture | The Executor must not drift into a workflow engine | NFR-01, NFR-08 |

---

## 6. Functional Requirements

### FR-01 — Declarative Pipeline Definitions

The system SHALL determine each pipeline's behavior exclusively from a versioned Pipeline Definition validated against a schema. The vocabulary of step types is closed: PoC `lambda`, `codebuild`, `ssh`, `notify`; reserved and rejected at runtime in the PoC: `lambda-deploy`, `s3-sync`, `cloudfront-invalidate`, `cloudformation`, `http-check`.

#### Scenario: valid definition
- GIVEN a definition that satisfies the schema
- WHEN an execution of that pipeline is created
- THEN the execution records the version identifier of the definition used
- AND every step in the execution comes from that version, even if the definition changes during the execution

#### Scenario: invalid definition
- GIVEN a definition with an unknown step type, a nonexistent dependency, a cycle in `needs`, or an interpolation outside the allowlist
- WHEN it is validated
- THEN it is rejected with an error that names the field and the violated rule
- BUT it must NOT create the execution or dispatch any step
- AND IT MUST reject any expression construct, loop, or embedded script

#### Scenario: CodeBuild project per environment
- GIVEN a `codebuild` step
- WHEN the definition is validated
- THEN the CodeBuild project is explicitly declared on that step
- BUT there must NOT be an implicit project or one shared by default across environments

#### Scenario: reserved type
- GIVEN a definition with an `s3-sync` step
- WHEN it is validated in the PoC
- THEN it is rejected as "reserved type, not enabled"

#### Scenario: environment out of scope
- GIVEN a definition with `environment` other than `dev`
- WHEN the DEV Executor loads it
- THEN it rejects it

### FR-02 — Target Registry

The system SHALL resolve every deploy destination through a versioned Target Registry that declares host, user, credential reference, host key reference, containers, ports and lock key. When applicable, it also declares whether the target requires a deploy window (FR-18) and the migration-compatibility attestation (FR-13).

#### Scenario: port or name conflict
- GIVEN two registry entries on the same host that publish the same port or the same container name
- WHEN the registry is validated
- THEN it is rejected, naming both entries

#### Scenario: missing host key
- GIVEN an entry without a host key reference
- WHEN it is validated
- THEN it is rejected
- AND IT MUST be considered invalid even if the credential exists

#### Scenario: mandatory window policy (added after Judgment Day round 2, R2-W2)
- GIVEN a registry entry that omits the declaration of external deployers or the window policy, or that declares external deployers with a policy that does not require a window
- WHEN it is validated (in CI or when the Executor starts)
- THEN it is rejected before any deploy
- BUT there must NOT be a default value that leaves a shared target unprotected

#### Scenario: secrets in the registry
- GIVEN the registry
- THEN it contains only **references** to secrets
- BUT it must NOT contain credential values

### FR-03 — Execution request and identity

The system SHALL create one execution per valid request, assigning it an `executionId` `<pipelineId>-<sequence>` with a monotonic sequence per pipeline, and SHALL deduplicate repeated requests.

#### Scenario: manual trigger
- GIVEN an operator with permission to send messages to the queue
- WHEN they send `PIPELINE_REQUESTED` with `pipelineId`, `requestId` and, optionally, a commit
- THEN an execution is created with a new `executionId`, in `QUEUED` state
- AND the exact commit to be used is resolved and recorded

#### Scenario: duplicate request
- GIVEN a request with the same `requestId` (or the same webhook delivery id) already processed
- WHEN it arrives again
- THEN no other execution is created
- AND IT MUST NOT consume a new sequence number

#### Scenario: unknown pipeline
- GIVEN a `pipelineId` with no definition
- WHEN the request arrives
- THEN the rejection is logged and the message is acknowledged
- BUT it must NOT create the execution

### FR-04 — Event reception

The system SHALL consume work and results from a Standard SQS queue with a DLQ, assuming **at-least-once** delivery with no guaranteed order. Messages carry identifiers and references, never artifacts or logs.

#### Scenario: valid envelope
- GIVEN a message with `specVersion, eventId, eventType, executionId, pipelineId, environment, timestamp, source` and, when applicable, `stepId, status, attempt, payload`
- WHEN the Executor receives it
- THEN it processes it according to its `eventType`

#### Scenario: native AWS results
- GIVEN a Lambda Destinations record or a CodeBuild status event via EventBridge
- WHEN it arrives at the queue
- THEN the Executor normalizes it to the envelope before processing it
- AND IT MUST correlate it with an existing step by its external identifier (`requestId` or `buildId`)

#### Scenario: poison message
- GIVEN a malformed message, or one whose processing fails persistently
- WHEN it has been received 5 times
- THEN it ends up in the DLQ and an alarm fires
- BUT it must NOT block processing of the other messages

#### Scenario: orphan event
- GIVEN a completion event with no correlatable execution or step
- WHEN it arrives
- THEN it is logged as an orphan and acknowledged, with no effects

### FR-05 — Persistent execution state

The system SHALL persist the state of each execution and each step outside the Executor's process, with explicit valid transitions and immutable terminal states.

| Entity | States | Terminal |
|---|---|---|
| Execution | `QUEUED, RUNNING, SUCCEEDED, FAILED, TIMED_OUT, CANCELLED` | `SUCCEEDED, FAILED, TIMED_OUT, CANCELLED` |
| Step | `PENDING, WAITING_LOCK, DISPATCHING, RUNNING, SUCCEEDED, FAILED, TIMED_OUT, SKIPPED` | `SUCCEEDED, FAILED, TIMED_OUT, SKIPPED` |

#### Scenario: valid transition
- GIVEN a step in `RUNNING`
- WHEN its successful completion arrives
- THEN it moves to `SUCCEEDED` with an end time, outputs and an external reference

#### Scenario: invalid transition
- GIVEN a step in a terminal state
- WHEN any event arrives attempting to change it
- THEN the state does not change and the event is logged as a no-op

#### Scenario: single allowed backward transition (added after Judgment Day round 2, R2-1)
- GIVEN a running deploy step whose script reports that the target is busy with another deploy operation (code 50)
- WHEN that result is processed
- THEN the step goes back to waiting for the lock, with the same `executionId` and the same step identity, releasing the attempt's resources
- BUT there must NOT be any other backward transition: any other one is rejected

#### Scenario: parallel steps
- GIVEN two steps in progress at the same time
- THEN each one has its own state record
- BUT there must NOT be a single "current step" on which correctness depends

#### Scenario: Executor restart
- GIVEN an Executor restart
- WHEN it resumes processing
- THEN it continues from the persisted state
- AND IT MUST NOT depend on memory from the previous process

### FR-06 — Step scheduling

The system SHALL dispatch each step when its dependencies (`needs`) are in `SUCCEEDED`, running independent steps in parallel, and SHALL execute `finally` steps on any outcome.

#### Scenario: parallelism
- GIVEN `server-quality` and `client-quality` with no dependencies
- WHEN the source is prepared
- THEN both are dispatched without waiting for each other

#### Scenario: fan-in exactly once
- GIVEN `deploy` depends on `server-image` and `client-image`
- WHEN both finish (in any order, even with duplicate or simultaneous events)
- THEN `deploy` is dispatched exactly once

#### Scenario: dependency failure
- GIVEN a step in `FAILED` or `TIMED_OUT`
- WHEN it is rescheduled
- THEN all of its direct and transitive dependents move to `SKIPPED`
- AND the execution ends in `FAILED` (or `TIMED_OUT`) after completing the steps already in progress and the `finally` steps

#### Scenario: finally
- GIVEN any terminal outcome
- THEN the `finally` steps run once
- BUT the failure of a `finally` step must NOT change the execution's already-determined terminal state

### FR-07 — Idempotent processing

The system SHALL guarantee that receiving the same event more than once produces no additional effects: no two dispatches of the same step attempt, no two deploys, no two migrations, and no invalid transitions.

#### Scenario: duplicate BUILD_COMPLETED
- GIVEN `server-image` already in `SUCCEEDED` and `deploy` already dispatched
- WHEN that build's `BUILD_COMPLETED` arrives again
- THEN no state changes
- BUT it must NOT dispatch `deploy` again, open another SSH session, or run another migration

#### Scenario: concurrency between instances
- GIVEN two Executor processes receive copies of the same event at the same time
- WHEN both attempt the same transition
- THEN only one applies it and the other treats it as already processed

#### Scenario: failure between recording and dispatching
- GIVEN the Executor recorded the dispatch intent and failed before acknowledging the message
- WHEN the message is redelivered
- THEN the CodeBuild dispatch does not create a second build for the same attempt
- AND IT MUST use an idempotency token for the attempt

### FR-08 — Source preparation

The system SHALL fetch the execution's exact commit, package the declared packages and upload them to execution-scoped paths, without installing dependencies or compiling.

#### Scenario: successful preparation
- GIVEN an execution with a resolved commit
- WHEN source preparation runs
- THEN each package ends up at `executions/{executionId}/source/{package}.zip`
- AND the local workspace `/work/{executionId}` is removed when it finishes

#### Scenario: mandatory exclusions
- GIVEN the repository tree
- WHEN it is packaged
- THEN `.git`, `node_modules` and secret files (`.env*` and unversioned environment configuration files) are excluded
- BUT it must NOT have secret values in any ZIP

#### Scenario: fixed keys
- GIVEN two concurrent executions of the same pipeline
- THEN their S3 objects and their workspaces are disjoint
- AND IT MUST NOT use any fixed key (e.g. `codebuild/frontend.zip`)

#### Scenario: failure and orphans
- GIVEN a failure in clone, packaging, or upload
- THEN the step fails with a code that distinguishes `SOURCE_CLONE`, `SOURCE_PREP` and `ARTIFACT_UPLOAD`
- AND the workspace is removed regardless
- AND on startup, the Executor removes orphan workspaces

#### Scenario: bounded concurrency
- GIVEN more preparations requested than the configured limit
- THEN the excess ones wait
- BUT it must NOT exceed the limit

### FR-09 — Quality in Lambda

The system SHALL dispatch quality tasks to Lambda asynchronously and SHALL receive its result as an event, classifying it.

| Result | Classification |
|---|---|
| The worker returns a success `status` | `QUALITY_COMPLETED` |
| The worker returns a failure `status` (lint or a red test) | `QUALITY_FAILED` (business-level, no retry) |
| Function error | `QUALITY_FAILED` with class `INFRA` (1 re-dispatch) |
| Function timeout | `QUALITY_TIMED_OUT` (distinct from FAILED) |

#### Scenario: no blocking
- GIVEN two quality tasks dispatched
- WHEN they are in progress
- THEN the Executor keeps processing other events
- BUT it must NOT keep an open synchronous invocation waiting for the result

#### Scenario: link to logs
- GIVEN a result with `logUrl` or `logS3Uri`
- THEN it is saved on the step and appears in the failure notification

### FR-10 — Build in CodeBuild per environment

The system SHALL start builds in the CodeBuild project declared for the pipeline's environment, with the execution's source and a unique image tag, and SHALL receive the completion as an event.

#### Scenario: unique tag
- GIVEN a build of the execution `prms-reporting-dev-184`
- THEN the image is tagged `prms-reporting-dev-184`, with the commit and the `executionId` as metadata
- AND IT MUST NOT reuse `latest` or integer tags that Jenkins might produce

#### Scenario: completion by event
- GIVEN a build in progress
- WHEN it finishes with `SUCCEEDED`, `FAILED`, `STOPPED` or `TIMED_OUT`
- THEN the step is updated by the corresponding event
- BUT the Executor must NOT poll the build on the normal path (only the reconciler may query it)

#### Scenario: execution's source
- GIVEN a build
- THEN its source is that execution's ZIP
- BUT it must NOT clone the repository inside CodeBuild

#### Scenario: outputs
- GIVEN a successful build
- THEN the step exposes `imageUri` and `digest` as outputs usable by later steps

### FR-11 — Deploy lock and supersede

The system SHALL prevent two Executor executions from deploying at the same time onto the same deploy unit, by means of a lock with an owner and a lease, and SHALL skip deploys of sequences older than the one already deployed.

#### Scenario: acquisition
- GIVEN a deploy unit with no lock or with an expired lease
- WHEN an `ssh` step requests it
- THEN it obtains the lock with owner = its `executionId` and an expiration

#### Scenario: busy
- GIVEN a valid lock held by another execution
- WHEN it is requested
- THEN the step stays in `WAITING_LOCK` and retries with backoff
- AND after 30 minutes of waiting it fails with `LOCK_TIMEOUT` and a notification is sent
- AND `LOCK_TIMEOUT` MUST be the only outcome of exhausting the wait, whoever detects it (the retry itself or the reconciliation)

#### Scenario: ownership
- GIVEN a lock held by execution A
- WHEN execution B attempts to renew or release it
- THEN the operation has no effect

#### Scenario: renewal and release
- GIVEN a deploy in progress
- THEN the lease is renewed periodically while it lasts
- AND when it finishes (success, failure, or finally) the lock is released

#### Scenario: orphan lock
- GIVEN an owner that stopped renewing
- WHEN the lease expires
- THEN another execution can acquire it
- AND IT MUST be decided by the lease's expiration, not by automatic deletion of the record

#### Scenario: supersede
- GIVEN the target already has sequence 186 deployed
- WHEN execution 184 obtains the lock
- THEN its deploy moves to `SKIPPED` with reason `SUPERSEDED`, without opening SSH
- AND the lock is released

### FR-12 — Deploy via SSH

The system SHALL deploy via SSH by executing, on the target resolved by the registry, a pinned and versioned version of the deploy script with declared arguments, and SHALL capture its result.

#### Scenario: host key
- GIVEN a target
- WHEN the presented host key does not match the registered one
- THEN the connection is aborted and the step fails with `HOST_KEY_MISMATCH`
- BUT it must NOT accept any unregistered host key

#### Scenario: credentials
- GIVEN the SSH credential
- THEN it is fetched at the point of use from the secrets manager and kept in memory only
- BUT it must NOT be written to disk, image, or logs
- AND IT MUST support a private key and, only if the entry marks it as temporary, a password

#### Scenario: script version
- GIVEN a deploy
- THEN the script executed is the one from that execution's definition version, and its checksum is recorded
- AND the remote temporary files carry the `executionId` in their path and are removed at the end

#### Scenario: arguments
- GIVEN the step's arguments
- THEN they are passed escaped, with no additional shell interpretation
- BUT it must NOT build commands by concatenating text from the definition

#### Scenario: result
- GIVEN the script finishes
- THEN the exit code, the tail of the output, and the final structured line are recorded
- AND the code is mapped per FR-13

#### Scenario: connection retries
- GIVEN a failed connection
- THEN it is retried up to 2 times **before** starting the script
- BUT it must NOT automatically retry a script that has already started

### FR-13 — Deploy script contract (target side)

The deploy script SHALL perform, in this order: authentication to the image registry and pull of the new ones; temporary materialization of the runtime configuration; migration (when requested) with the new image **while the previous version remains in service**; container replacement; health check; cleanup. It SHALL also retain the previous image.

| Code | Meaning | Previous version |
|---|---|---|
| 0 | Success | Replaced |
| 10 | Login or pull failed | Intact |
| 20 | Migration failed | Intact (not stopped) |
| 30 | Startup failed; the previous one was restored | Restored |
| 40 | Health check failed; the previous one was restored | Restored |
| 50 | Target busy: another deploy operation holds the local mutex; **nothing was done** | Intact |
| other / lost session | Unknown | `UNKNOWN_TARGET_STATE` |

*(Revised after Judgment Day round 1, S-2, approved by the owner: code 50 is added.)*

#### Scenario: second barrier on the target
- GIVEN a deploy operation in progress on the unit (even if the distributed lock has expired)
- WHEN another deploy is started on the same unit
- THEN the second one exits with 50, with no pull, migration, or swap
- BUT it must NOT replace the distributed lock from FR-11: both coexist

#### Scenario: migration-compatibility precondition
- GIVEN a target with migrations enabled
- THEN its registry entry declares that migrations are backward compatible, along with who attests it
- AND a definition that requests migrating onto a target without that declaration MUST be considered invalid
- BUT the platform must NOT present that property as guaranteed: it is the application team's responsibility

#### Scenario: failed migration
- GIVEN version N in service and the migration of N+1 fails
- WHEN the script runs
- THEN it exits with 20 and N keeps serving
- BUT it must NOT stop or remove N's containers

#### Scenario: failed health check
- GIVEN N+1 started but does not pass the health check
- THEN the script restores N and exits with 40

#### Scenario: previous image
- GIVEN any outcome
- THEN N's image remains available on the host
- BUT it must NOT run cleanup of the previous image

#### Scenario: temporary configuration
- GIVEN the runtime configuration materialized in a temporary file
- THEN its name contains the `executionId`, only the deploy user reads it, and it is removed **on the target** on any outcome

#### Scenario: target's AWS credentials
- GIVEN the target
- THEN the script obtains its AWS permissions without depending on static credentials left by previous executions
- AND IT MUST NOT write AWS credentials on the host (dependency: OD-Q5)

#### Scenario: script idempotency
- GIVEN the script run twice with the same images
- THEN the second result is equivalent to the first and there is no second migration with effects

### FR-14 — Notifications

The system SHALL notify, from the Executor, through a notification service with interchangeable providers (Slack in the PoC), the following events: start, quality failure, build failure, deploy failure (including `UNKNOWN_TARGET_STATE`), lock timeout, execution timeout, and success.

#### Scenario: content
- GIVEN a notification
- THEN it includes `executionId`, pipeline, commit, affected step (if applicable), and a link to logs
- BUT it must NOT include secret values

#### Scenario: provider failure
- GIVEN Slack unavailable
- WHEN notification is attempted
- THEN the error is logged and the pipeline continues
- AND IT MUST NOT change the execution's state because of a notification failure

#### Scenario: separation
- GIVEN Lambda and CodeBuild
- THEN neither sends notifications directly

### FR-15 — Reconciliation

The system SHALL periodically run (every 5 minutes or less) a reconciliation that detects executions and steps alive past their deadline, recovers lost CodeBuild completions, and closes orphan locks.

#### Scenario: lost CodeBuild event
- GIVEN an expired `codebuild` step whose build has already finished
- WHEN the reconciliation runs
- THEN the step adopts the build's actual result

#### Scenario: stuck step
- GIVEN a step with no result past its deadline
- THEN it moves to `TIMED_OUT`, the `finally` steps run, and a notification is sent

#### Scenario: interrupted SSH session
- GIVEN a deploy whose owner stopped renewing the lock
- THEN the execution ends with `UNKNOWN_TARGET_STATE` and a notification is sent for manual verification
- BUT it must NOT automatically re-run the deploy

### FR-16 — Failure behavior

The system SHALL behave as this table indicates. Each row is independently verifiable.

| # | Failure | Mandatory behavior |
|---|---|---|
| F1 | git clone fails | 2 retries with backoff, then `FAILED (SOURCE_CLONE)`; cleanup; notification |
| F2 | Source preparation fails | `FAILED (SOURCE_PREP)`; cleanup |
| F3 | S3 upload fails | 1 step retry, then `FAILED (ARTIFACT_UPLOAD)` |
| F4 | Lambda function error | `INFRA`; 1 re-dispatch; then `FAILED` |
| F5 | Red quality | `FAILED`, no retry; dependents in `SKIPPED` |
| F6 | Lambda timeout | `TIMED_OUT`, no retry |
| F7 | Failed build | `FAILED` with a link to the log; no retry |
| F8 | Image push fails | `FAILED` (occurs inside the build) |
| F9 | SQS redelivery | No-op (FR-07) |
| F10 | SSH connection fails | 2 retries before the script; then `FAILED`; the lock is released |
| F11 | Migration fails | Code 20 → `FAILED (MIGRATION)`; previous version serving; no retry |
| F12 | Deploy script fails | Code ≠ 0 → `FAILED` with code and output tail; no retry |
| F13 | Health check fails | Code 40 → `FAILED (HEALTH)`; previous version restored |
| F14 | Slack fails | It is logged and processing continues |
| F15 | Executor restart | Resumes from the persisted state; workspace sweep |
| F16 | Stuck execution | Reconciliation → `TIMED_OUT` |
| F17 | Orphan lock | The lease expires; reconciliation; `UNKNOWN_TARGET_STATE` if there was a deploy in progress |
| F18 | Target busy (code 50) | Returns to the lock wait within the same 30-minute budget; when exhausted, `LOCK_TIMEOUT` |
| F19 | The target requires a deploy window and none is open | `FAILED (DEPLOY_WINDOW_CLOSED)` without opening SSH; notification |

### FR-17 — Observability

The system SHALL emit structured logs in which every entry related to an execution contains `executionId` (and `stepId` when applicable), and SHALL expose alarms for messages in the DLQ, executions alive past their deadline, and an inactive Executor.

#### Scenario: reconstruction
- GIVEN an `executionId`
- WHEN an operator queries the persisted state and the logs
- THEN they can determine which steps ran, with which external identifiers, how long they took, and why it failed, with no access to Jenkins

#### Scenario: redaction
- GIVEN any log
- THEN it contains no secrets, credentials, or tokens

### FR-18 — Coexistence with Jenkins

The system SHALL operate the PoC's real deploys only within test windows in which the Jenkins jobs that deploy onto the same deploy unit are disabled, and SHALL keep a record of each window.

#### Scenario: window
- GIVEN a deploy test on `<PRMS_REPORTING_DEV_TARGET>`
- THEN before starting, it is announced, it is verified that there are no Jenkins builds in progress for those jobs, and they are disabled
- AND when it finishes, they are re-enabled and the owner, schedule, and executions are recorded

#### Scenario: global Jenkins
- BUT it must NOT shut down Jenkins globally or modify Jenkinsfiles

#### Scenario: precondition
- GIVEN that the list of jobs is not confirmed (dependency on the configuration inventory)
- THEN no real deploys are run on that target

#### Scenario: technical backing (added after Judgment Day round 1, S-4)
- GIVEN a target marked in the registry as "requires deploy window"
- WHEN a deploy is attempted and there is no open and valid window (recorded with an owner and with a non-empty list of disabled external jobs)
- THEN the deploy fails without opening SSH and a notification is sent
- BUT the mechanism must NOT contain Jenkins-specific logic in the core: it is a generic, transient per-target capability that is retired by changing registry data

#### Scenario: window revalidation (added after Judgment Day round 2, R2-W1)
- GIVEN a window that was valid when the execution started
- WHEN the deploy waits for the lock, receives "target busy", or is about to execute the script
- THEN the window is checked again at each of those moments, and it must cover the deploy's possible duration
- AND IT MUST NOT execute the script if the window has expired: the step fails with no effects on the target and a notification is sent

### FR-19 — Artifact retention

The system SHALL delete each execution's source artifacts when it finishes, and the infrastructure SHALL automatically expire: source after 7 days, logs and reports after 30 days, incomplete multipart uploads after 1 day.

#### Scenario: abandoned execution
- GIVEN an execution that never finished
- THEN its artifacts disappear through expiration even if the explicit cleanup never ran

### FR-20 — GitHub webhook trigger (SHOULD)

The system SHOULD accept GitHub push webhooks for pipelines with the `github-push` trigger, verifying the signature and deduplicating by delivery id.

#### Scenario: invalid signature
- GIVEN a webhook without a valid signature
- THEN it is rejected and nothing is queued

#### Scenario: branch not configured
- GIVEN a push to an undeclared branch
- THEN no execution is created

---

## 7. Non-Functional Requirements

| ID | Requirement | Measure / verification |
|---|---|---|
| **NFR-01 Executor boundary** | The Executor MUST NOT: install dependencies or compile (npm/pnpm/maven/docker build); run scripts from application repositories; connect to application databases; read application secrets; contain per-project or per-application code branches; interpret expressions, loops, or embedded scripts in definitions; host the Docker daemon or socket | Image inspection (no toolchains or mounted socket); review of permissions and network; search for project identifiers in the Executor's code = 0; schema validation that rejects expressions |
| **NFR-02 Security** | No secrets in ZIPs, S3 objects, the image, definitions, the registry, or logs. Least privilege per component and environment. The Executor's AWS credentials are temporary or, if that is not possible, explicitly justified (dependency: OD-Q12). Pinned host key. SSH credential in memory only | Scanning of artifacts, image, and logs; IAM review |
| **NFR-03 Reliability** | Correctness under at-least-once delivery, out-of-order delivery, and restarts. No duplicate deploys. Locks recoverable without intervention | Duplicate, concurrency, and kill tests |
| **NFR-04 Resource footprint** | Container with CPU and memory limits. Concurrent source preparations and SSH sessions bounded and configurable. Working disk sized by measurement (dependency: OD-Q15) | Container configuration; measurement in the source increment |
| **NFR-05 Coordination latency** | From the moment a completion event is in the queue until the next step is dispatched: ≤ 60 s under normal conditions | E2E measurement (p95 over ≥ 10 executions) |
| **NFR-06 Operability** | An operator can reconstruct any execution using only persisted state, logs, and notifications | Runbook exercise |
| **NFR-07 Cost** | CodeBuild only for image builds; quality in Lambda; no new permanent compute for the Executor. Measured durations and resources are reported | Measurement report |
| **NFR-08 Extensibility without project code** | Adding a pipeline of the same pattern requires only a definition and a registry entry, **with no code changes** to the Executor. Adding a step type affects only its capability and the schema. *PoC simplification: since definitions are packaged into the image, publishing a new definition requires rebuilding and redeploying the image. The definition source must be abstracted so it can be externalized without changing the core* | Test: a second mock definition of the same pattern validated with no code changes |
| **NFR-09 Environment isolation** | All of the PoC's resources and permissions are DEV. No access to STAGING or PROD resources | IAM review (a single AWS account, FA §2) |
| **NFR-10 Non-interference** | The PoC does not modify Jenkinsfiles or application code, and does not remove existing credentials on hosts | Change review |

---

## 8. Defect classes and gates

| Defect class | Gate that detects it | No automatic gate → substitute |
|---|---|---|
| Invalid or racing state transition | Domain tests with a local database and simulated concurrency | — |
| Double dispatch, double deploy, or double migration | Idempotency tests + E2E with duplicate injection | — |
| Lock incorrectly acquired or released, or incorrect supersede | LockService tests with a local database (contention, expiration, foreign owner) | — |
| Invalid definition or registry accepted | Validation tests with negative cases | — |
| Type error in contracts | Type-check / project build | — |
| Secret leaked into ZIP, S3, image, or logs | Automated scan of test artifacts and image | Human review of the scan in the E2E HITL |
| The Executor includes toolchains or project logic (boundary) | Image inspection + search for project identifiers | Design review on every PR |
| Deploy script in the wrong order (migrates after stopping) | E2E test with a deliberately broken migration | Human verification of the service during the window |
| Ineffective rollback after a failed health check | E2E test with an image that fails to start | Human verification |
| Missing network connectivity | Network spike | — |
| Excessive IAM permission | **No complete automatic gate** | Human policy review in the infrastructure HITL; residual accepted risk |
| Interference with Jenkins | **No automatic gate** | Window checklist (FR-18) verified by the Jenkins admin |
| Latency (NFR-05) | Measurement over ≥ 10 executions; if the spread exceeds the threshold, the result is not evidence and the spread is reported | — |

---

## 9. Open decisions and dependencies

None of them is resolved in this phase.

| OD | Question (unanswered) | Dependent requirements | What remains undecided |
|---|---|---|---|
| OD-Q5 | Does `<PRMS_REPORTING_DEV_TARGET>` support an instance profile? A dedicated deploy user? Which jobs use its leftover keys? | FR-13 (target's AWS credentials), FR-18 | The exact mechanism by which the target obtains AWS permissions. FR-13 requires the outcome (no leftover static keys), not the mechanism |
| OD-Q7 | CDK or Terraform? | FR-19 (lifecycle), provisioning of all the infrastructure | The IaC tool. The requirements describe resources and behaviors, not the tool |
| OD-Q11 | What host exactly is the microservices server? PROD? Swarm? Proxy? | NFR-04, NFR-09, connectivity | The host. NFR-09 requires DEV isolation in permissions and resources; if the host is PROD, it is escalated to the owner |
| OD-Q12 | How does the Executor obtain AWS credentials without exposing them to other containers? | NFR-02 | The mechanism. NFR-02 requires least privilege and no exposure |
| OD-Q13 | Do the quality tests need configuration with secrets? | FR-08, FR-09 | Whether the worker needs to read secrets. FR-08 prohibits secrets in ZIPs in any case |
| OD-Q14 | Does anyone consume `<JENKINS_EXECUTIONS_TABLE>`? | None in the PoC | Future record compatibility |
| OD-Q15 | Size of `<PRMS_REPORTING_REPO>` and GitHub authentication | FR-08, NFR-04 | The disk size and the type of credential for reading the repo |

Evidence dependencies not yet available (from the proposal's Q1–Q3, partially resolved): Jenkins job names (FR-18), `<QUALITY_WORKER_FUNCTION>` input format (FR-09), current migration commands and order (FR-13), Dockerfiles and `.dockerignore` of `<PRMS_REPORTING_REPO>` (FR-10).

---

## 10. Requirement ID Index

| ID | Name | Strength | Proposal |
|---|---|---|---|
| FR-01 | Declarative Pipeline Definitions | SHALL | R-DEF, §10.4 |
| FR-02 | Target Registry | SHALL | §10.4 |
| FR-03 | Execution request and identity | SHALL | R-ID |
| FR-04 | Event reception | SHALL | R-QUEUE, §10.3 |
| FR-05 | Persistent state | SHALL | §10.12 |
| FR-06 | Step scheduling | SHALL | R-PAR |
| FR-07 | Idempotent processing | SHALL | R-IDEM, §10.13 |
| FR-08 | Source preparation | SHALL | R-NOSECRETS, §10.7 |
| FR-09 | Quality in Lambda | SHALL | §10.6 |
| FR-10 | Build in CodeBuild per environment | SHALL | §10.5 |
| FR-11 | Lock and supersede | SHALL | R-LOCK, §10.14 |
| FR-12 | Deploy via SSH | SHALL | §10.8 |
| FR-13 | Deploy script contract | SHALL | R-MIG, R-ROLLBACK-READY, §10.11 |
| FR-14 | Notifications | SHALL | §10.15 |
| FR-15 | Reconciliation | SHALL | R-RECON |
| FR-16 | Failure behavior | SHALL | §10.17 |
| FR-17 | Observability | SHALL | R-OBS, §10.16 |
| FR-18 | Coexistence with Jenkins | SHALL | §12 |
| FR-19 | Artifact retention | SHALL | §10.7 |
| FR-20 | GitHub webhook | SHOULD | Inc 8 |
| NFR-01…10 | Non-functional | MUST / SHALL | §6, §13, §14 |

**Delta from the proposal:** all ADDED items become FR. The MODIFIED items (deploy path, deploy order, target credentials) land in FR-12, FR-13 and FR-18. There are no REMOVED items.

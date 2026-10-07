# Requirements — CI/CD Executor PoC (PRMS Reporting DEV)

> **In one line:** GitHub Actions builds PRMS Reporting DEV and sends **one** deploy request through SQS. A lightweight Executor must then **authenticate, validate, deduplicate, order, lock and deploy it over SSH** through the target's deploy script, with persistent state and idempotency under at-least-once delivery. **The Executor cannot clone, build, test, orchestrate CI, connect to databases, read application secrets, or contain per-project logic.**

---

## 1. Document Control

| Field | Value |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Phase | Phase 1: Requirements |
| Version | **v4.0** (owner decisions 2026-10-07, AC-02 V1, `architecture-change-02.md`; supersedes the v3.8 draft of the same day): FR-01 deferred (no Deployment Definitions in V1); FR-02 runtime Target Registry with the minimal record; FR-03 request carries `targetId`, no `deploymentId`; FR-12/FR-13 the script lives on the target and the Executor runs it by path; FR-21 one shared CI role, no per-target sender authorization (accepted residual risk); FR-23/FR-24/FR-25 adjusted. §1.3 is normative). v3.7 (owner direction, B0 acceptance 2026-10-06: FR-22 "public-safe logs" and NFR-02 — no GitHub secret, role ARN and account ID owner-accepted in CI logs (G-10); RECONCILE_TICK minimal internal contract (G-8); fail-fast definition loading at startup (G-9)). v3.6 (owner direction, Gate B approval 2026-10-06: FR-22 "public-safe logs" follows the DD-24 v4.6 GitHub value classification). v3.5 (Gate A closure editorial sync, no new decision). v3.4 (owner approval 2026-10-06; aligned with `proposal.md` v3.4) |
| Depth | **Full** (new infrastructure, trust boundary, concurrency, deployment and migrations) |
| Type | Change |
| Approval Mode | `gated` (inherited from the proposal) |
| Source of intent | `proposal.md` v3 (accepted 2026-10-06) under `architecture-change-01.md` (**AC-01**, APPROVED 2026-10-06) |
| Evidence | **FA** and **ctx** = the local-only feasibility and context documents; cited by sanitized section reference only. **AC-01 §3** = external-platform premises P-A1–P-A7 |
| ID pattern | `FR-nn`, `NFR-nn`, `OD-xx`. **IDs are stable:** an unchanged meaning keeps its ID; removed IDs are never reused; new requirements take new numbers (FR-21+) |
| Date | 2026-10-06 |
| Owner | CI/CD Platform Team |
| Review | v2 passed a Full Judgment Day (3 rounds, APPROVED; `judgment.md`). v3 requires the **scoped Judgment Day** of AC-01 §16 before implementation resumes |

### 1.1 Change history

| Version | Change |
|---|---|
| v2 | Requirements for proposal v2: Executor coordinates Lambda (quality), CodeBuild (images) and SSH from step-graph definitions. Judgment Day APPROVED with round 1–2 adjustments (code 50, mandatory window policy, window revalidation, single backward transition, canonical `LOCK_TIMEOUT`, sanitization) |
| **v3** | **AC-01 / proposal v3 (Model B).** CI moves to GitHub Actions. Removed: FR-06, FR-08, FR-09, FR-10, FR-19, FR-20. Rewritten: FR-01, FR-03, FR-04, FR-05, FR-07, FR-11, FR-13–FR-18, NFR-01, NFR-02, NFR-04–NFR-08, NFR-10. New: FR-21 request authentication, FR-22 CI contract, FR-23 supersede ordering, FR-24 deploy windows (split from FR-18), FR-25 CI trust boundary. All Judgment Day round 1–2 adjustments are preserved (mapping in §10) |
| **v3.5** | Gate A closure editorial sync (no new decision): FR-01 states that the `lockKey` is reached through `targetRef` (the Target Registry holds it, design §6.2/§6.3); FR-15 replaces "orphan locks" with lease expiry, as already approved in FR-11 and design §7.5 |
| **v3.4** | **owner approval 2026-10-06:** OD-A2 resolved (FR-21 owner statements); OD-A1 resolved for the PoC under the single-source invariant (FR-23); new FR-22 scenario "actions pinned by commit SHA" with FR-25 cross-reference |
| **v3.3** | Editorial E1–E5 after JD APPROVED (2026-10-06): bound-ref source in FR-25, `TARGET_RESOLUTION_RECORDED` in FR-04, OD-A6 wording. No new decision |
| **v3.2** | **JD round-2 correction:** FR-25 trust bound to direct IAM keys (`job_workflow_ref` at an immutable SHA, repository and owner IDs, Environment) instead of a custom subject; guard checks the bound ref for both events; FR-23 equal-value scenario; FR-03 dedupe wording |
| **v3.1** | **JD round-1 correction:** FR-25 (custom OIDC subject with `job_workflow_ref`, event allowlist, negatives for `pull_request`, `pull_request_target`, `workflow_run`, organization plan) CS-1/CC-1; FR-23 (supersede against every dispatched value; unknown-state and lost-lease scenarios) CS-2; FR-07/FR-21/FR-22 (dedupe scoped to `deploymentId`, `requestId` validated) CC-2; FR-22 (secrets, not variables) SU-1; FR-05 (`RECEIVED` removed) and FR-15 (aligned with X11/X16, stalled re-drive) CW-2/CW-3; P-A2 corrected |

### 1.2 Leader rulings recorded (2026-10-06)

| # | Ruling |
|---|---|
| RL-1 | **Deploy windows keep the approved v2 semantics.** A closed window at the entry check fails fast with `FAILED (DEPLOY_WINDOW_CLOSED)` (no waiting); the window is revalidated on lock retries, after code 50 and immediately before the SSH call. `LOCK_TIMEOUT` is only for lock waits. AC-01 §4.4's "⇄ window closed" was a sketch, not a decision (FR-24, FR-16 F7/F7b) |
| RL-2 | Sender binding applies **per message type**: `DEPLOY_REQUESTED` only from bound CI roles (or an operator path if OD-A8 adds one); internal types only from the Executor or scheduler principals; deploy-window events only from the operator principal (FR-21, FR-25) |
| RL-3 | Unparseable messages go to the DLQ; parseable contract-invalid requests are `REJECTED` and acknowledged (FR-04) |
| RL-4 | Any exit code outside 0/10/20/30/40/50, or a lost session, is `UNKNOWN_TARGET_STATE` (FR-13, FR-16) |
| RL-5 | Exit 0 covers "already running these digests"; whether a rejected request with an unknown `deploymentId` gets a record or a sequence is a design choice |
| RL-7 | Exit 2 (script usage error) is **not** a distinct outcome: the Executor cannot distinguish it from bash's own exit 2 (builtin misuse, syntax) that could occur after effects, so it maps to `UNKNOWN_TARGET_STATE` (RL-4 stands). Usage errors are prevented upstream by definition validation and the script's own tests. *V1 (AC-02): by the caller configuration and the script's tests only; an unknown unit ends `UNKNOWN_TARGET_STATE`* |
| RL-6 | Required reviewers apply to production environments in later waves; the PoC is DEV |

### 1.3 V1 scope and identity mapping (AC-02 V1, owner decisions 2026-10-07; normative)

In V1 there are **no Deployment Definitions**. The request's `targetId` is the deploy identity **and** the lock key: wherever this document says `deploymentId` or `lockKey` (dedupe scope, sequence, `executionId` = `<targetId>-<sequence>`, lock, target mutex, supersede ordering, deploy windows, logs, notifications), read `targetId`. Wherever it says a value comes from "the definition", it comes from: the target record (deploy script path, window policy; FR-02), the platform configuration (the shared CI role, the notification channel, the deploy timeout of 20 minutes), or the target-side script's own configuration (image repositories, containers, ports, runtime configuration, migrations, health checks; FR-13). Design §1.2 holds the same mapping. This section takes precedence over older wording.

**Rule for this specification:** OD-Q5, OD-Q7, OD-Q11–OD-Q15, OD-N1 and OD-A3–OD-A9 are **open decisions** (§9); OD-A1 and OD-A2 were **resolved by the owner on 2026-10-06**. No requirement assumes their answer. Where one conditions a requirement, the dependency is declared and the requirement states the **behavior**, not the mechanism. Premises P-A3, P-A5 and P-A7 stay `UNVERIFIED` (P-A6 was verified at source in JD round 2) and no requirement relies on them alone.

---

## 2. Executive Summary

| Question | Answer |
|---|---|
| What is being built? | (1) A reusable GitHub Actions workflow that builds, pushes images **by digest** and sends one deploy request. (2) A containerized Executor that consumes those requests from SQS and coordinates **one** SSH deploy per request through the target's deploy script |
| What for? | To show that a representative Jenkins pipeline can be replaced **without another CI server and without another Jenkins** |
| With which pipeline? | PRMS Reporting DEV (pattern P1, ~57 pipelines; FA §4, §23) |
| What makes it correct? | Sender authorization, digest-only artifacts, idempotency under at-least-once delivery, supersede ordering, per-deploy-unit lock + target mutex, persistent state, migration before stopping the old version, previous image retained |
| What makes it "not Jenkins"? | No CI in the Executor, no per-application model (the target's script owns it), no expressions, no toolchains or git, no DB or application-secret access (NFR-01) |
| What is out of scope? | Non-SSH deploy types (**OD-A3**), non-Docker artifact store (**OD-A4**), operator rollback path (**OD-A8**, unless decided), Jira, retiring Jenkins, historical security debt |

---

## 3. Glossary

| Term | Definition |
|---|---|
| CI | Checkout, install, lint, test, build, image push. Owned by GitHub Actions |
| Reusable workflow | The GitHub Actions workflow in this platform repo that implements the CI contract (FR-22) |
| Caller workflow | The workflow file in an application repo that invokes the reusable workflow (OD-A6) |
| CI role | IAM role assumed by a workflow through OIDC. **V1: one role shared by the authorized repositories** (owner decision 2026-10-07; FR-25) |
| Deploy request | The `DEPLOY_REQUESTED` message (FR-03) |
| Sender | The AWS identity that put a message on the queue, as asserted by AWS, not by the message body |
| Executor | Deploy-coordination service: receive → validate → authenticate → resolve → coordinate → deploy → record → notify |
| Deployment Definition | Not part of V1 (FR-01, deferred) |
| Target Registry | Runtime table of deploy destinations (`cicd-registry-<stage>`), one record per `targetId`: where the server is, how to connect securely and which script to run (FR-02, AC-02) |
| Deploy script | Script installed on the target server at the record's `deployScript` path; owns the application-specific deploy logic (FR-13) |
| Execution | One processing of one deploy request, identified by `executionId` = `<targetId>-<sequence>` |
| Artifact identity | An image digest (`sha256:<64-hex>`). Never a tag |
| Deploy unit / `lockKey` | What one target's script deploys, under one lock. **V1: the lock key is the `targetId`** |
| Supersede | Rule by which an **older** request never replaces a **newer** deployment of the same `lockKey` (FR-23) |
| Deploy window | Per-target period in which deploys are allowed; required while external deployers (Jenkins) share the target (FR-24) |
| Target mutex | Kernel file lock taken by the script on the target; second barrier (FR-13) |
| Reconciler | Periodic process that closes stuck executions, expired lock waits and expired windows (FR-15); expired lock leases free themselves (FR-11) |
| OD | Open Decision |

---

## 4. System Context & Scope

### 4.1 Current context (cited)

| Statement | Evidence |
|---|---|
| PRMS V2 Reporting DEV clones `<PRMS_REPORTING_REPO>`, writes secrets into the tree, runs quality in Lambda, builds with Docker and deploys via SSH with a password on `<PRMS_REPORTING_DEV_TARGET>`, with conditional migrations | FA §23 (reference `<JENKINS_JOB_ID>`). Details not cited by line: `UNVERIFIED — confirm at source before relying on it` |
| Containers `<SERVER_CONTAINER>` (<SERVER_PORT_MAPPING>) and `<CLIENT_CONTAINER>` (<CLIENT_PORT_MAPPING>). Up to 8 jobs deploy onto them from different branches | FA §10.3, §23 |
| If a migration fails, the old container has already been removed. `rmi N-1` removes the previous image. There is no rollback | FA §11.4, §16 |
| The target receives AWS keys via `aws configure set` and other jobs depend on them | FA §9.3.5, §12.2.1, §23 |
| Single AWS account (`<AWS_ACCOUNT_ID>`, `<AWS_REGION>`); environment separation only by IAM/resource | FA §2 |
| `<ECR_REPOSITORY>` is shared by up to 8 Jenkins jobs, which push integer tags | FA §10.3; tag usage details `UNVERIFIED — confirm at source before relying on it` |
| Jenkins triggers, job names and concurrency are not in the repo | FA §19 B2 |

**External-platform premises (AC-01 §3):**

| ID | Premise | Status |
|---|---|---|
| P-A1 | GitHub Actions is free on public repos with standard hosted runners; larger runners are charged | VERIFIED |
| P-A2 | **Corrected (JD round 1):** the default `sub` includes `pull_request` only if the job does not reference an environment; an environment job gets the environment form regardless of the triggering event. Tokens require `id-token: write` | VERIFIED (design §13, [GH-OIDC]) |
| P-A3 | Fork `pull_request` runs receive no OIDC token or secrets | `UNVERIFIED — confirm at source before relying on it` |
| P-A4 | SQS can return `SenderId` (role ID + session) on receipt | VERIFIED |
| P-A5 | The repositories in scope are public | `UNVERIFIED — confirm at source before relying on it` (OD-A9). If false, Environment protection depends on the organization plan (P-G7): High |
| P-G2…P-G12 | Branch-rule matching and untrusted triggers, subject customization (unused), event in subject (moot), reusable-workflow context, IAM condition keys incl. the GitHub claims, organization plan, unmasked variables, `run_id` scope, immutable subject format, SHA-pinned `job_workflow_ref`, `run_number` reset on rename | See design §13 (P-G4, P-G7 organization plan, P-G11, P-G12 `UNVERIFIED`) |
| P-A6 | `run_number` increases per run and does not change on re-run | VERIFIED (design §13, [GH-CTX]: "This number does not change if you re-run the workflow run"); rename reset P-G12 `UNVERIFIED` |
| P-A7 | Logs and workflow files of public repos are publicly readable | `UNVERIFIED — confirm at source before relying on it`; treated as true (safe assumption) |

### 4.2 Scope

| In | Out |
|---|---|
| Reusable workflow + PRMS Reporting DEV caller (FR-22) | **Non-SSH deploy types** (S3/CloudFront, Lambda, SAM/CFN) — **OD-A3** |
| CI trust boundary: OIDC provider, CI role, queue policy, GitHub Environment (FR-25) | **Non-Docker artifact store** — **OD-A4** |
| Target Registry, request contract with validation (V1: no Deployment Definitions) | Operator deploy-only / rollback path — OD-A8 (designed only if decided) |
| Sender authorization, dedupe, state, supersede, lock, windows, SSH, reconciler | Lambda or CodeBuild in the normal path (exception mechanisms only, by spec change) |
| Deploy script interface on the target; the PRMS Reporting DEV script, including migration | Jira Builds API, Teams, email; SSH → SSM |
| Slack notifications for the deploy lifecycle | Retiring Jenkins jobs; changing Jenkinsfiles |
| Coexistence procedure with Jenkins | Historical security debt (parallel track); STAGING or PROD resources |

### 4.3 Context diagram

```text
<PRMS_REPORTING_REPO> caller ──uses──> reusable workflow (GitHub-hosted runners)
        build · test · push to <ECR_REPOSITORY> by digest
                     │ OIDC → CI role (repo + Environment)
                     v
        SQS (Standard) + DLQ ──> Executor ──> DynamoDB (state, dedupe, locks, windows)
                     ▲             │ ├──> Slack · CloudWatch · Secrets Manager
     Scheduler tick ─┘             │ └──> SSH (pinned host key)
                                   v
                     <PRMS_REPORTING_DEV_TARGET>: deploy script ──> pull by digest
                                                 ──> migration (DEV DB) ──> swap ──> health
```

---

## 5. Stakeholders / Personas

| Persona | Needs | Key requirements |
|---|---|---|
| Platform operator (DevOps) | Trigger, observe and diagnose deploys without Jenkins | FR-15, FR-17, FR-24, NFR-06 |
| Deployment author | Add a target with configuration only: a registry record, its credential secret, the script on the server and a caller workflow | FR-02, FR-22, NFR-08 |
| Application repo owner / admin | Add the caller workflow; keep branch and Environment rules | FR-22, FR-25 (OD-A6) |
| PRMS Reporting team | DEV deployed correctly; informed of deploy failures | FR-12, FR-13, FR-14 |
| Jenkins administrator | Pause and resume, in a controlled way, the jobs that touch the target | FR-18 |
| Security owner | No forgeable senders, no secrets or internal identifiers in public CI, least privilege | FR-21, FR-25, NFR-02, NFR-09 |
| Architecture | The Executor must not drift into a workflow engine or reabsorb CI | NFR-01, NFR-08 |

---

## 6. Functional Requirements

### FR-01 — Deployment Definitions (deferred; not part of V1)

**V1 (AC-02 V1, owner decision 2026-10-07):** the system SHALL NOT require Deployment Definitions. The Executor does not model containers, application ports, migrations, migration compatibility, health checks or runtime configuration; per-application behavior lives in the target's script (FR-13). Versioned definitions may return in a later change; they are not specified here.

#### Scenario: startup without definitions
- GIVEN the Executor starting with no definition files
- THEN it starts (subject to the platform configuration checks)
- AND it never reads application-specific deployment parameters from the image

### FR-02 — Target Registry

The system SHALL resolve every deploy destination at request time from a runtime Target Registry (one record per `targetId`, AC-02) that declares inline only what is needed to locate the server, connect securely and run the authorized script: the target id, project and environment, SSH host, port and user, the pinned host key, the absolute path of the deploy script on the target (`deployScript`) and the deploy-window policy (FR-24), and that references the SSH credential (`credentialRef`) held in Secrets Manager. Adding or changing a target SHALL NOT require changing, rebuilding or redeploying the Executor.

#### Scenario: new target without redeploy
- GIVEN an administrator registers a valid target record and its credential secret
- WHEN an authorized request names that `targetId`
- THEN the Executor resolves and uses it without any code change, rebuild or restart

#### Scenario: unknown or invalid target
- GIVEN a request whose `targetId` does not exist, or whose record is invalid
- WHEN it is received
- THEN it is `REJECTED` with the matching reason (`TARGET_UNKNOWN`, `TARGET_INVALID`)
- BUT it must NOT consume a sequence, open SSH, take a lock, read the target's credential or affect any other execution

#### Scenario: record changed or deleted during an execution
- GIVEN an accepted execution whose target record is edited or deleted before dispatch
- THEN the execution keeps using the snapshot taken at acceptance (host, port, user, host key, script path, window policy)
- AND the credential is still read only at connect time, through the snapshot's `credentialRef`
- AND a redelivery of the accepted request (dedupe item `BOUND`) is a no-op, never a rejection

#### Scenario: missing host key
- GIVEN a target record without a host key
- THEN it is invalid even if the credential exists, and no connection is attempted

#### Scenario: deploy script path
- GIVEN a target record
- THEN `deployScript` is an absolute path without `..`, arguments, whitespace or shell metacharacters, else the record is invalid
- AND the script to run always comes from the record, never from the request

#### Scenario: mandatory window policy (Judgment Day round 2, R2-W2)
- GIVEN a record that omits the window policy
- THEN it is invalid
- BUT there must NOT be a default value that leaves a shared target unprotected

#### Scenario: secrets and write access
- GIVEN the registry
- THEN it contains no credential value (only `credentialRef`)
- AND only the administrative principal can write it; the Executor can only read it (`GetItem`) and the CI role has no access

### FR-03 — Deploy request contract and execution identity

The system SHALL accept deployments only through a `DEPLOY_REQUESTED` message that matches a strict schema: `specVersion`, `eventType`, `requestId`, `targetId` (FR-02), `commitSha` (40 hex), `artifacts` (artifact unit → image digest), audit-only `ci` metadata, and the ordering fields fixed by OD-A1. It SHALL create at most one execution per `targetId` + `requestId` (the dedupe scope), with `executionId` = `<targetId>-<sequence>` and a monotonic sequence per target. (V1: there is no `deploymentId`.)

#### Scenario: valid request
- GIVEN a schema-valid request from an authorized sender (FR-21) for a known and valid `targetId`
- WHEN the Executor receives it
- THEN an execution is created in `QUEUED` with a new `executionId`
- AND it records `requestId`, `commitSha`, the digests and the `ci` metadata

#### Scenario: no infrastructure fields
- GIVEN a request that carries any field not in the schema (host, IP, port, user, credential, command, script or script path, image repository, registry, tag, environment variables)
- WHEN it is validated
- THEN it is `REJECTED` and audited
- BUT it must NOT be deployed

#### Scenario: digest only
- GIVEN a request whose artifact value is a tag, or a digest not of the form `sha256:<64-hex>`
- THEN it is `REJECTED`
- AND the Executor checks the format only; the target's script rejects a unit it does not know (FR-13)

#### Scenario: image repository from trusted configuration
- GIVEN a valid request
- THEN the script pulls `<repository from its own trusted configuration>@<digest from the request>`
- BUT the request must NOT be able to choose the repository or registry

#### Scenario: duplicate request
- GIVEN a `requestId` already processed for the same `targetId`
- WHEN it arrives again
- THEN no other execution is created
- AND IT MUST NOT consume a new sequence number

#### Scenario: CI metadata is audit only
- GIVEN the `ci` fields (repository, run id, run attempt, workflow ref)
- THEN they are stored for traceability
- BUT they must NOT drive authorization or target resolution; the only ordering input is `ci.runNumber`, inside the single source of the target (OD-A1 resolved, FR-23)

### FR-04 — Event reception and validation

The system SHALL consume messages from a Standard SQS queue with a DLQ, assuming **at-least-once** delivery and no guaranteed order. Messages carry identifiers and references, never artifacts, logs or secrets.

#### Scenario: known message types
- GIVEN a parseable message of a known type (`DEPLOY_REQUESTED`, the internal lock-wait and reconciliation events, the operator window events, the operator `TARGET_RESOLUTION_RECORDED` event)
- WHEN the Executor receives it
- THEN it authenticates the sender (FR-21), validates the schema and processes it by type

#### Scenario: contract-invalid request
- GIVEN a parseable `DEPLOY_REQUESTED` that fails the schema
- THEN it is `REJECTED` with the violated rule recorded, and acknowledged
- BUT it must NOT be retried or sent to the DLQ

#### Scenario: poison message
- GIVEN an unparseable message, or one whose processing fails persistently
- WHEN it has been received 5 times
- THEN it ends up in the DLQ and an alarm fires
- BUT it must NOT block processing of the other messages

### FR-05 — Persistent execution state

The system SHALL persist each execution's state outside the Executor's process, at execution level (no step entities), with a **closed** list of transitions published in the design and immutable terminal states.

| States | Terminal |
|---|---|
| `QUEUED, WAITING_LOCK, DEPLOYING, SUCCEEDED, FAILED, SUPERSEDED, REJECTED, UNKNOWN_TARGET_STATE` (no `RECEIVED`: an execution is created directly in `QUEUED` or `REJECTED`, design X1/X2; CW-3) | `SUCCEEDED, FAILED, SUPERSEDED, REJECTED, UNKNOWN_TARGET_STATE` |

#### Scenario: invalid transition
- GIVEN an execution in a terminal state
- WHEN any event tries to change it
- THEN the state does not change and the event is logged as a no-op

#### Scenario: single allowed backward transition (Judgment Day round 2, R2-1)
- GIVEN an execution in `DEPLOYING` whose script reports target busy (code 50)
- WHEN that result is processed
- THEN it returns to `WAITING_LOCK` with the same `executionId`, releasing the attempt's resources
- BUT there must NOT be any other backward transition

#### Scenario: conditional writes
- GIVEN two processes attempting transitions on the same execution
- THEN each transition is conditional on the current state and version
- AND IT MUST NOT rely on in-memory state as the source of truth

#### Scenario: Executor restart
- GIVEN an Executor restart
- WHEN it resumes processing
- THEN it continues from the persisted state

### FR-07 — Idempotent processing and dedupe

The system SHALL guarantee that receiving the same message more than once produces no additional effects: no second execution, no second SSH script run, no second migration, and no invalid transitions.

#### Scenario: duplicate DEPLOY_REQUESTED
- GIVEN an execution already created for a `deploymentId` + `requestId` (the dedupe scope; `run_id` is unique only within a repository, P-G9)
- WHEN the same message is redelivered (or CI sends it twice)
- THEN no state changes
- BUT it must NOT open another SSH session or run another migration

#### Scenario: concurrency between instances
- GIVEN two Executor processes receive copies of the same message at the same time
- THEN only one creates the execution and the other treats it as already processed

#### Scenario: failure between recording the intent and the result
- GIVEN the Executor recorded the intent to run the script and stopped before recording a result
- WHEN the message is redelivered
- THEN the script is **not** started again automatically
- AND IT MUST resolve the execution through reconciliation (FR-15)

#### Scenario: re-run of the same CI run
- GIVEN a GitHub re-run of a run that was already deployed (new `requestId`, same digests)
- WHEN it is processed and is not older per FR-23
- THEN the script's idempotent path applies (FR-13): no second migration with effects

### FR-11 — Deploy lock and target mutex

The system SHALL prevent two Executor executions from deploying at the same time onto the same deploy unit, with a distributed lock that has an owner, a lease and a fencing token, and SHALL rely on the target mutex (FR-13) as a second barrier. Neither layer replaces the other.

#### Scenario: acquisition
- GIVEN a deploy unit with no lock or with an expired lease
- WHEN an execution in `WAITING_LOCK` requests it
- THEN it obtains the lock with owner = its `executionId`, a lease and a new fencing token

#### Scenario: busy
- GIVEN a valid lock held by another execution
- THEN the execution stays in `WAITING_LOCK` and retries with backoff
- AND after 30 minutes of total waiting it fails with `LOCK_TIMEOUT` and a notification is sent
- AND `LOCK_TIMEOUT` MUST be the only outcome of exhausting the wait, whoever detects it

#### Scenario: ownership
- GIVEN a lock held by execution A
- WHEN execution B tries to renew or release it
- THEN the operation has no effect

#### Scenario: renewal and release
- GIVEN a deploy in progress
- THEN the lease is renewed periodically while it lasts
- AND on any outcome the lock is released

#### Scenario: lease lost during the script
- GIVEN a renewal fails while the script is running
- THEN the Executor does **not** abort the script
- AND it records that the lock was lost and, when the script ends, its real result

#### Scenario: orphan lock
- GIVEN an owner that stopped renewing
- WHEN the lease expires
- THEN another execution can acquire it
- AND IT MUST be decided by the lease's expiration, not by deletion of the record

### FR-12 — Deploy via SSH

The system SHALL deploy by executing, over SSH on the target resolved by the registry, the deploy script installed on that target at the record's `deployScript` path, with a fixed argument vector built only from the validated request and the execution, and SHALL capture its result.

#### Scenario: host key
- GIVEN a target whose presented host key does not match the registered one
- THEN the connection is aborted and the execution fails with `HOST_KEY_MISMATCH`
- BUT it must NOT accept any unregistered host key

#### Scenario: credentials
- GIVEN the SSH credential
- THEN it is fetched at the point of use and kept in memory only
- BUT it must NOT be written to disk, image or logs
- AND IT MUST support a private key and, only if the entry marks it as temporary, a password

#### Scenario: script on the target
- GIVEN a deploy
- THEN the script executed is the one at the `deployScript` path of the execution's target snapshot, and the path and the record version are recorded
- AND the Executor uploads no file to the target
- BUT the script's integrity is the target's responsibility: it must be owned by an administrator and not writable by the deploy user (onboarding requirement)

#### Scenario: arguments
- GIVEN the script arguments
- THEN they are passed escaped, with no additional shell interpretation
- BUT it must NOT build commands by concatenating text from the request

#### Scenario: bounded sessions
- GIVEN more concurrent deploys than the configured SSH session limit
- THEN the excess wait
- AND every exit path releases the session slot

#### Scenario: connection retries
- GIVEN a failed connection
- THEN it is retried up to 2 times **before** starting the script
- BUT it must NOT automatically retry a script that has already started

#### Scenario: result
- GIVEN the script finishes
- THEN the exit code, the output tail and the final `CICD_RESULT` line are recorded and mapped per FR-13

### FR-13 — Deploy script contract (target side)

Every deploy script SHALL honor the interface (design §6.5): take the target mutex for the `targetId` before any effect; pull images **by digest** from its own trusted repositories only; exit with the codes below and end with a `CICD_RESULT` line; be idempotent for digests already in service. Its internal procedure is the target administrator's responsibility. **The PRMS Reporting DEV script (reference implementation) SHALL additionally**, in this order: materialize the runtime configuration temporarily; run migrations (when enabled) with the new image **while the previous version remains in service**; replace the containers; health-check; clean up, retaining the previous image; the scenarios below on migration, health, previous image and temporary configuration apply to it.

| Code | Meaning | Previous version |
|---|---|---|
| 0 | Success (including "already running these digests") | Replaced or unchanged |
| 10 | Login or pull failed | Intact |
| 20 | Migration failed | Intact (not stopped) |
| 30 | Startup failed; the previous one was restored | Restored |
| 40 | Health check failed; the previous one was restored | Restored |
| 50 | Target busy: the target mutex is held; **nothing was done** | Intact |
| other / lost session | Unknown | `UNKNOWN_TARGET_STATE` |

#### Scenario: immutable artifact references
- GIVEN the script's artifact arguments
- THEN each is `<unit>=sha256:<digest>` and the script resolves the unit to `<its trusted repository>@sha256:<digest>`
- BUT the script must NOT pull or run anything by tag, or from a repository named by the request

#### Scenario: second barrier on the target
- GIVEN a deploy operation in progress on the unit (even if the distributed lock expired)
- WHEN another deploy starts on the same unit
- THEN the second one exits with 50, with no pull, migration or swap
- BUT it must NOT replace the distributed lock from FR-11

#### Scenario: migration compatibility (V1)
- GIVEN a script that runs migrations
- THEN keeping migrations backward compatible with the version in service is the application team's responsibility, recorded in the target's onboarding
- BUT the platform must NOT present that property as guaranteed, and the Executor does not check it in V1

#### Scenario: failed migration
- GIVEN version N in service and the migration of N+1 fails
- THEN the script exits with 20 and N keeps serving
- BUT it must NOT stop or remove N's containers

#### Scenario: failed health check
- GIVEN N+1 started but does not pass the health check
- THEN the script restores N and exits with 40

#### Scenario: previous image kept
- GIVEN any outcome
- THEN N's image remains available on the host, identified by digest
- BUT cleanup must NOT remove the previous image

#### Scenario: idempotent re-run
- GIVEN the script run again with the digests already in service
- THEN it exits 0 with an equivalent result
- AND there is no second migration with effects and no unnecessary swap

#### Scenario: temporary configuration
- GIVEN runtime configuration materialized in a temporary file
- THEN its name contains the `executionId`, only the deploy user reads it, and it is removed **on the target** on any outcome

#### Scenario: target's AWS credentials
- GIVEN the target
- THEN the script obtains its AWS permissions without depending on static credentials left by previous executions
- AND IT MUST NOT write AWS credentials on the host (dependency: OD-Q5)

### FR-14 — Notifications

The system SHALL notify the **deploy lifecycle** from the Executor through a notification service with interchangeable providers (Slack in the PoC): accepted, rejected, superseded, lock timeout, deploy failure (including `UNKNOWN_TARGET_STATE`), and success.

#### Scenario: content
- GIVEN a notification
- THEN it includes `executionId`, `targetId`, commit, the GitHub run link and a link to logs
- BUT it must NOT include secret values or real infrastructure identifiers

#### Scenario: CI failures stay in GitHub
- GIVEN a CI run that fails
- THEN no deploy request exists and the Executor sends no notification
- AND the failure is visible in GitHub; an optional Slack step in the reusable workflow is **OD-A5**

#### Scenario: provider failure
- GIVEN Slack unavailable
- THEN the error is logged and the deploy continues
- AND IT MUST NOT change the execution's state because of a notification failure

### FR-15 — Reconciliation (deploy state only)

The system SHALL run, every 5 minutes or less, from a scheduled tick, a reconciliation that closes executions alive past their deadline, expired lock waits and expired deploy windows. An orphan lock needs no reconciliation action: it is freed by lease expiry, never by deleting the record (FR-11 "orphan lock", design §7.5). It SHALL NOT reconcile any CI state.

#### Scenario: wait budget exhausted
- GIVEN an execution in `WAITING_LOCK` past its wait budget
- THEN it ends `FAILED (LOCK_TIMEOUT)` and a notification is sent

#### Scenario: interrupted deploy (aligned with design X11/X16, CW-3)
- GIVEN an execution in `DEPLOYING` past its deadline (a crashed owner stops renewing, so the deadline bounds detection)
- THEN, if the script may have started for the current attempt, it ends `UNKNOWN_TARGET_STATE` and a notification asks for manual verification (runbook)
- AND if the script provably did not start for the current attempt, it ends `FAILED (DISPATCH_INTERRUPTED)`
- BUT it must NOT automatically re-run the deploy

#### Scenario: stalled execution re-driven (CW-2)
- GIVEN an execution in `QUEUED` or `WAITING_LOCK` whose next step was never scheduled because the Executor crashed
- WHEN the reconciliation finds it past its deadline
- THEN it resumes it (window and supersede checks, then a lock attempt) within the remaining lock-wait budget
- BUT it must NOT end it `LOCK_TIMEOUT` while budget remains

#### Scenario: single instance safety
- GIVEN two Executor instances handling the same tick
- THEN their effects do not duplicate (conditional writes)

### FR-16 — Failure behavior

The system SHALL behave as this table indicates. Each row is independently verifiable. (v2's F1–F8, all CI failures, are removed: they no longer reach the Executor.)

| # | Failure | Mandatory behavior |
|---|---|---|
| F1 | CI fails (lint, test, build, push) | No request is sent; the Executor is not involved |
| F2 | Unparseable message or persistent processing failure | DLQ after 5 receptions; alarm |
| F3 | Contract-invalid request, or unknown or invalid `targetId` | `REJECTED`, audited, acknowledged; no deploy |
| F4 | Unauthorized sender | `REJECTED`, audited, alarm; no deploy (FR-21) |
| F5 | Duplicate request | No-op (FR-07) |
| F6 | Older request per FR-23 | `SUPERSEDED`; no SSH; notification |
| F7 | Lock busy | `WAITING_LOCK` within the 30-minute budget; then `FAILED (LOCK_TIMEOUT)` |
| F7b | Target requires a window and none is valid (entry check, lock retry, after code 50, or right before SSH) | `FAILED (DEPLOY_WINDOW_CLOSED)` at once; no waiting; no script run; resources released; notification (FR-24) |
| F8 | SSH connection fails | 2 retries before the script; then `FAILED`; lock released |
| F9 | Host key mismatch | `FAILED (HOST_KEY_MISMATCH)`; no retry |
| F10 | Code 10 | `FAILED (PULL)`; no retry |
| F11 | Code 20 | `FAILED (MIGRATION)`; previous version serving; no retry |
| F12 | Code 30 / 40 | `FAILED (START)` / `FAILED (HEALTH)`; previous version restored |
| F13 | Code 50 | Back to `WAITING_LOCK` within the same budget |
| F14 | Other code, lost session, Executor crash mid-script | `UNKNOWN_TARGET_STATE`; runbook; no re-run |
| F15 | Lease renewal fails during the script | Script not aborted; loss recorded; real result recorded |
| F16 | Slack fails | Logged; processing continues |
| F17 | Executor restart | Resumes from persisted state |

### FR-17 — Observability and audit

The system SHALL emit structured logs in which every entry related to an execution carries `executionId`, `requestId` and `targetId`, and SHALL expose alarms for: messages in the DLQ, oldest message age, executions past their deadline, an inactive Executor, and rejected senders.

#### Scenario: reconstruction
- GIVEN an `executionId`
- WHEN an operator queries DynamoDB, CloudWatch, Slack and the stored GitHub run link
- THEN they can determine who requested it (sender reference), which commit and digests, which target record version and script path, how long each phase took, and why it ended as it did, with no access to Jenkins

#### Scenario: redaction
- GIVEN any Executor log or notification
- THEN it contains no secrets, credentials or tokens

### FR-18 — Coexistence with Jenkins

The system SHALL operate the PoC's real deploys only within test windows in which the Jenkins jobs that deploy onto the same deploy unit are disabled, and SHALL keep a record of each window. The technical backing is FR-24.

#### Scenario: window procedure
- GIVEN a deploy test on `<PRMS_REPORTING_DEV_TARGET>`
- THEN before starting, it is announced, no Jenkins builds of those jobs are in progress, and the jobs are disabled
- AND when it finishes, they are re-enabled and the owner, schedule and executions are recorded

#### Scenario: global Jenkins
- BUT it must NOT shut down Jenkins globally or modify Jenkinsfiles

#### Scenario: precondition
- GIVEN the list of jobs is not confirmed (configuration inventory)
- THEN no real deploys are run on that target

### FR-21 — Request authentication and deployment authorization (NEW)

The system SHALL accept each message only from a sender identity authorized for that message type; for `DEPLOY_REQUESTED` that identity is **the CI role shared by the authorized repositories** (V1, owner decision 2026-10-07). The sender identity SHALL come from a source the sender cannot forge. The mechanism is SQS `SenderId` role binding (**OD-A2 resolved by the owner, 2026-10-06**; P-A4).

**Owner statements (2026-10-06; the third amended for V1 on 2026-10-07):** authorization uses the AWS-provided sender identity (role ID) and the trusted sender binding; caller-controlled session names are never an authorization input; a CI sender is authorized only for the event types explicitly assigned to it. *V1: with one shared CI role there is no per-`deploymentId` or per-target sender assignment.*

#### Scenario: authorized sender
- GIVEN a request whose sender is the configured CI role
- THEN it proceeds to target resolution, validation and dedupe

#### Scenario: unauthorized sender
- GIVEN a `DEPLOY_REQUESTED` sent by any role other than the configured CI role
- WHEN it is received
- THEN it is `REJECTED`, audited with the sender reference and reason, and an alarm fires
- BUT it must NOT open SSH, take a lock or affect any other execution

#### Scenario: CI selects another project's target (OPEN, escalated to the owner)
- GIVEN an authorized repository's run that names another project's `targetId`
- THEN the Executor cannot distinguish it from a legitimate request (same role ID; `ci.*` is body-asserted) and processes it
- AND because the shared role can push to every application repository, this allows an arbitrary image to be deployed on any target, and a higher `runNumber` blocks that target's legitimate source with no reset in the PoC (`architecture-change-02.md` V1-R1)
- BUT this is **not** accepted by assumption: it is an open point for the owner; while the CI role trusts a single repository (the PoC) there is no exposure, and a second repository is not onboarded before the owner decides

#### Scenario: identity claims in the body
- GIVEN a request whose `ci.repository` claims to be the bound repository
- THEN that claim is ignored for authorization
- AND IT MUST NOT accept any identity asserted only by the message body

#### Scenario: colliding requestId from another source (JD round 1, CC-2)
- GIVEN a request whose `requestId` is not `<ci.runId>-<ci.runAttempt>`
- THEN it is `REJECTED`
- AND deduplication is scoped to `targetId` + `requestId`; a pre-claim of another target's `requestId` by an authorized repository is part of the open point V1-R1

#### Scenario: other message types
- GIVEN an operator window event, an internal event or a reconciliation tick
- THEN it is accepted only from the identity configured for that type (operator, Executor, scheduler)

### FR-22 — CI contract (NEW)

The reusable workflow SHALL be the only producer of deploy requests in the normal path, and SHALL: run the push-and-send job in a GitHub Environment; obtain AWS credentials only via OIDC; push images and capture their **digests**; send **exactly one** `DEPLOY_REQUESTED` after every CI step has succeeded; keep internal identifiers out of logs; contain no deploy logic.

#### Scenario: CI success
- GIVEN lint, tests, builds and pushes all succeed
- THEN exactly one request is sent, with the caller-configured `targetId`, the pushed digests and `requestId` derived from the run and attempt

#### Scenario: CI failure
- GIVEN any CI step fails
- THEN no request is sent

#### Scenario: credentials
- GIVEN the workflow
- THEN it requests an OIDC token (`id-token: write`) and assumes its CI role
- BUT it must NOT use static AWS keys

#### Scenario: public-safe logs
- GIVEN the run's logs and workflow file (treated as public, P-A7)
- THEN no credential and no AWS authentication secret appears in the workflow, its configuration or its logs: AWS access is OIDC only; the role ARN, region, repository name, queue name and bound ref are Environment variables, and the registry host and queue URL are derived after OIDC (owner direction, 2026-10-06, v3.7; design DD-24 v4.7)
- BUT the role ARN and the AWS account ID MAY appear in logs (owner-accepted: neither is a credential), and no AWS access key or secret access key may exist anywhere

#### Scenario: requestId derivation
- GIVEN a successful run
- THEN `requestId` is exactly `<run_id>-<run_attempt>` of that run, and `ci.runId` / `ci.runAttempt` carry the same values

#### Scenario: actions pinned by commit SHA (owner approval 2026-10-06; see FR-25)
- GIVEN the trusted reusable workflow
- THEN every `uses: owner/repo[/path]@ref` (third-party and GitHub-owned) is pinned by a full 40-hex commit SHA with the human-readable version as a trailing comment, and every `docker://` reference by image digest
- BUT it must NOT reference any action by a mutable ref (`@main`, `@master`, a branch, or a tag such as `@v4`); local `./` references are the only exemption
- AND IT MUST be enforced by a static guard that fails on any non-compliant reference

#### Scenario: no deploy logic
- GIVEN the workflow
- THEN it never selects a host, script, command or image repository for the deploy
- AND IT MUST NOT hold SSH credentials

#### Scenario: manual trigger
- GIVEN an operator who needs a deploy without a new push
- THEN they use `workflow_dispatch` on the caller workflow, which runs the same contract

#### Scenario: tags
- GIVEN tags pushed for humans
- THEN they never drive a deploy
- AND IT MUST NOT push tags that collide with the integer tags Jenkins uses in the shared repository (OD-A7)

### FR-23 — Supersede ordering (NEW; split from FR-11)

The system SHALL guarantee that **an older build that finishes or is re-run later never replaces a newer deployment of the same `lockKey`** (V1: the same `targetId`). "Older" and "newer" are defined by `ci.runNumber` **inside the single trusted source** of the target (**OD-A1 resolved for the PoC by the owner, 2026-10-06**; V1: exactly one trusted GitHub source — repository + workflow + environment — per `targetId`, a configuration rule that the Executor cannot verify with the shared CI role, V1-R2); an equal `runNumber` is the same logical run or a re-run, not older. Multi-source ordering is **out of the PoC**; `runNumber` values are never compared across sources. A renamed or reset workflow makes deploys stop (accepted fail-safe limitation); rebinding requires the future audited OD-A8 procedure.

#### Scenario: late older build
- GIVEN build B2 (newer) already deployed on the `lockKey`
- WHEN the request of build B1 (older) arrives afterwards
- THEN B1 ends `SUPERSEDED` without opening SSH, and a notification is sent

#### Scenario: re-run of an older run
- GIVEN run R1 (older) and run R2 (newer) deployed
- WHEN R1 is re-run and its new request arrives
- THEN it ends `SUPERSEDED`
- BUT a re-run must NOT become "newer" only because it ran later

#### Scenario: newer already accepted
- GIVEN an older request waiting for the lock while a newer request for the same `lockKey` has been accepted
- THEN the older one MUST NOT deploy after the newer one

#### Scenario: two sources on one target (V1)
- GIVEN two different sources (repositories or workflows) configured to deploy the same `targetId`
- THEN the configuration violates the single-source rule; onboarding and the caller configuration must prevent it, because the Executor cannot detect it in V1 (V1-R2); no ordering across sources is attempted
- BUT the system must NOT fall back to an undocumented rule; where order cannot be established, the documented rule applies and the outcome is audited

#### Scenario: check under the lock
- GIVEN the supersede check
- THEN it is evaluated while holding the lock, against the newest of: the deployment recorded with fencing, and **every ordering value that was ever dispatched** to the target (recorded atomically with the dispatch intent)
- AND the only way to deploy an older version is an explicit operator path (OD-A8), never the CI role

#### Scenario: newer deployment ended in an unknown state (JD round 1, CS-2)
- GIVEN a newer request that reached the target and ended `UNKNOWN_TARGET_STATE`
- WHEN an older request takes the lock
- THEN the older one ends `SUPERSEDED` without opening SSH
- AND the `lockKey` is listed as unresolved until an operator records the resolution (runbook)

#### Scenario: equal ordering values (JD round 2, R2-1)
- GIVEN the dispatched-value record already holds this request's ordering value
- WHEN the same execution re-enters dispatch after a code 50, or a re-run of the same run arrives
- THEN it is **not** superseded: equal is not older, and the record accepts an equal value
- BUT a strictly lower value MUST be superseded

#### Scenario: newer deployment lost its lease
- GIVEN a newer execution whose lease expired while its script ran, and whose success write was rejected by fencing
- WHEN an older request takes the lock (even after a code 50)
- THEN the older one ends `SUPERSEDED`
- AND the newer one's success is recorded with the rejected write flagged and notified

### FR-24 — Deploy windows (NEW ID; split from FR-18, Judgment Day S-4, R2-W1)

The system SHALL provide a generic per-target deploy-window capability: on a target whose policy requires a window, no deploy **starts** without an open, valid window covering the deploy's possible duration.

#### Scenario: no window (fail fast)
- GIVEN a target that requires a window and no open window valid for the deploy's maximum duration
- WHEN the execution reaches the entry check (before waiting for the lock)
- THEN it ends `FAILED (DEPLOY_WINDOW_CLOSED)` immediately and a notification is sent
- BUT it must NOT wait for a window, take the lock or open SSH

#### Scenario: valid window
- GIVEN a window
- THEN it is valid only if opened by an authorized operator with an owner and a non-empty list of disabled external jobs, recorded for audit
- AND V1: external deployers are not modeled in the registry; that the list covers all of them is attested by the operator (coexistence runbook), not checked by the Executor
- AND a window cannot be opened for an unknown or invalid target, or for a target whose policy does not require one

#### Scenario: revalidation (Judgment Day round 2, R2-W1)
- GIVEN an execution that passed the entry check
- THEN the window is checked again on every lock retry, after a code 50 before retrying, and **immediately before the SSH call**, each time covering the deploy's maximum duration
- AND if it is no longer valid at any of those points, the execution ends `FAILED (DEPLOY_WINDOW_CLOSED)` without running the script, releasing every resource it holds

#### Scenario: window expires while the script runs
- GIVEN a script already running when the window closes
- THEN the script is **not** aborted; the closure during the run is recorded and notified

#### Scenario: maximum duration
- GIVEN an open window
- THEN it closes automatically after at most 8 hours

#### Scenario: no Jenkins logic
- BUT the core must NOT contain Jenkins-specific logic; the policy is retired by changing registry data

### FR-25 — CI trust boundary (NEW)

The infrastructure SHALL restrict who can obtain AWS credentials from GitHub and what they can do.

#### Scenario: trust bound to the pinned reusable workflow and immutable IDs (JD round 2, R2-A1, R2-4)
- GIVEN the CI role's trust policy
- THEN it requires, by exact equality, the AWS STS audience, a repository ID from the authorized list (V1: one role shared by the authorized repositories), the repository owner ID, the Environment, and the `job_workflow_ref` of the platform reusable workflow pinned at an immutable commit SHA, plus the default environment-form `sub` as a redundant check (all direct IAM condition keys, P-G6)
- BUT it must NOT rely on an environment-only subject, on branch-only subjects, on wildcards, or on the mutable `sub` string format alone (P-A2, P-G2, P-G10)
- AND IT MUST NOT depend on P-A3 for fork safety

#### Scenario: event allowlist
- GIVEN a run of the pinned reusable workflow
- WHEN its triggering event is not `push` or `workflow_dispatch`, **or** its ref is not the bound ref (for both events, R2-3)
- AND the bound ref is read only from a value that repository administrators alone control (design DD-24 item 2, E1), never from a workflow input, the request or a repository-level variable
- THEN it fails before any job requests an OIDC token, and no request is sent
- AND this guard is the only event control: the triggering event is not an IAM condition key (P-G6)

#### Scenario: untrusted triggers cannot deploy
- GIVEN a workflow run triggered by `pull_request` (including from a fork), `pull_request_target` or `workflow_run`
- WHEN it tries to assume the CI role or to send a deploy request
- THEN the assumption fails or the run stops at the event allowlist, and nothing is sent

#### Scenario: job outside the pinned workflow
- GIVEN a job that references the Environment but is written directly in a caller workflow, or calls the reusable workflow at another ref
- WHEN it tries to assume the CI role
- THEN the assumption fails (`job_workflow_ref` does not match)

#### Scenario: organization plan
- GIVEN the repositories in scope
- THEN the organization's plan provides Environment deployment branch rules and environment secrets for each of them (P-G7, OD-A9); without them, the IAM binding and the guard still hold but GitHub-side branch gating and environment-scoped secrets are lost, and the owner decides at OD-A9
- AND IT MUST be re-checked after any change of repository visibility, because protection rules are ignored after converting to private on some plans

#### Scenario: pinned code behind the pinned workflow
- GIVEN `job_workflow_ref` pins the reusable workflow by commit SHA
- THEN the actions it uses are also pinned by commit SHA (FR-22), so trusted code cannot change through a moved tag

#### Scenario: least privilege
- GIVEN the CI role
- THEN its scope is the authorized repositories + environment (V1: one shared role), with ECR authentication and push to the platform's application repositories only, and `sqs:SendMessage` on the deploy queue only
- BUT it must NOT have SSH, EC2, Secrets Manager, database or infrastructure permissions

#### Scenario: queue policy
- GIVEN the deploy queue
- THEN `SendMessage` is allowed only to the configured senders (the CI role, the operator identity, the scheduler, the Executor)

#### Scenario: environment rules
- GIVEN the GitHub Environment used by the push-and-send job
- THEN its deployment branch rules allow only protected branches
- AND production environments (later waves) MUST require reviewers; the Executor adds deploy windows but no approval step

---

## 7. Non-Functional Requirements

| ID | Requirement | Measure / verification |
|---|---|---|
| **NFR-01 Executor boundary** | The Executor MUST NOT: clone or fetch source, hold git or a GitHub credential; install dependencies, compile, test or build images; invoke, orchestrate or correlate CI (no Lambda, CodeBuild or CI callbacks in the normal path); run scripts from application repos; connect to application databases; read application secrets; contain per-project or per-application code branches; interpret expressions, loops or embedded scripts; host the Docker daemon or socket | Image inspection (no toolchains, no git, no socket); IAM review (no S3, Lambda, CodeBuild, GitHub rights); boundary guards: project identifiers in Executor code = 0; schema rejects expressions |
| **NFR-02 Security** | No secrets in requests, definitions, registry, the Executor image or logs; no internal identifiers in public CI logs (exception, G-10: the CI role ARN and the AWS account ID are owner-accepted in CI logs (G-10, design DD-24 v4.7); hosts, IPs, credential IDs, credentials and secret values stay forbidden). Least privilege per component, repository and environment. CI credentials short-lived (OIDC). Executor AWS credentials temporary or explicitly justified (OD-Q12). Pinned host key. SSH credential in memory only | Scans of image, logs and a CI run log; IAM review; FR-25 checks |
| **NFR-03 Reliability** | Correctness under at-least-once delivery, out-of-order delivery and restarts. No duplicate deploys. Locks recoverable without intervention | Duplicate, concurrency and kill tests |
| **NFR-04 Resource footprint** | Container with CPU and memory limits; no working-disk volume. Concurrent SSH sessions bounded and configurable | Container configuration review |
| **NFR-05 Coordination latency** | From a valid request becoming visible in the queue to the script starting, when the lock is free and the window open: ≤ 60 s | p95 over ≥ 10 executions; if the spread exceeds the threshold, it is reported, not taken as evidence |
| **NFR-06 Operability** | An operator can reconstruct any deploy from persisted state, logs, notifications and the GitHub run link | Runbook exercise |
| **NFR-07 Cost** | CI on standard GitHub-hosted runners (larger runners only by decision); no new permanent compute for the Executor. Measured durations, GitHub minutes and Executor resources are reported | Measurement report. Zero CI cost depends on P-A5 (OD-A9) |
| **NFR-08 Extensibility without project code** | Adding a project or target requires only configuration: a registry record, its credential secret, the deploy script on the server, a caller workflow using the reusable workflow, and the repository added to the shared CI role trust — **no Executor code change, rebuild or redeploy** (AC-02 V1) | Test: a second target record used with no code change or restart |
| **NFR-09 Environment isolation** | All PoC resources and permissions, including the CI role, are DEV. No access to STAGING or PROD | IAM review (single account, FA §2) |
| **NFR-10 Non-interference** | The PoC does not modify Jenkinsfiles, application code, `<QUALITY_WORKER_FUNCTION>` or `<LEGACY_CODEBUILD_PROJECT>`, and does not remove existing credentials on hosts. The only application-repo change is the caller workflow and its GitHub Environment, subject to **OD-A6** | Change review |

---

## 8. Defect classes and gates

Name the defect class, then the gate. Gates A–D are the proposal's (§18).

| Defect class | Gate that detects it | Where it can be verified | No automatic gate → substitute |
|---|---|---|---|
| Invalid or racing state transition | Domain tests with DynamoDB Local and simulated concurrency | Gate A | — |
| Double execution, double deploy or double migration | Idempotency tests; E2E duplicate injection | A (unit/integration); C (E2E) | — |
| Lock or fencing wrong; supersede wrong (late older build, re-run, two sources) | Lock and supersede tests (contention, expiry, foreign owner, ordered injection) | A (logic); C (E2E re-run on GitHub) | — |
| Request contract too permissive (extra fields, tags, foreign repository) | Schema negative tests | A | — |
| **Unauthorized sender accepted** | Tests with simulated sender identities | A (logic only); **B** (real `SenderId` format, P-A4, and real foreign role) | — |
| **Trust-boundary misconfiguration (OIDC / IAM / queue policy)** | (1) **Static policy check** of the trust and permission documents: exact `sub`, no `pull_request`, no wildcard, scoped ECR and SQS actions. (2) **Negative tests:** `pull_request`, `pull_request_target` and `workflow_run` runs, and a job outside the pinned reusable workflow, cannot assume the CI role or send; a role without binding cannot send. (3) Subject template content and opt-out state checked | (1) A, on the documents in `infra/` (only if they are written as concrete policies; their application is B). (2) **C only** (N-32): needs the real GitHub repo, Environment and AWS account | GitHub Environment branch rules and branch protection: **no automatic gate**; human inspection of repository settings by a repo admin at Gate C, before the first real run |
| CI workflow violates the contract (sends on failure, sends twice, no digest, deploy logic) | Static validation of the workflow files | A (static); C (first real run, N-32) | Review of the caller in the application repo (OD-A6) |
| Internal identifiers in public CI logs | Scan of a real run log for hosts, IPs, credential IDs, credentials and secret values (the CI role ARN and account ID are expected, G-10) | **C** (N-32) | Human review of the first runs |
| Invalid target record accepted | Validation tests with negative cases | A | — |
| Type error in contracts | Type-check / build | A | — |
| Secret leaked into image, registry or logs | Automated scan | A (image); C (registry review, E2E logs) | Human review of the scan at the E2E HITL |
| Executor boundary breach (toolchain, git, project logic, CI work) | Image inspection + boundary guards + IAM review | A (guards, image); B (IAM) | Design review on every PR |
| Deploy script in the wrong order (migrates after stopping) | E2E with a deliberately broken migration | C | Human verification of the service |
| Ineffective restore after a failed health check | E2E with an image that fails health | C | Human verification |
| Missing network connectivity | Network spike (N-23) | B, before the Executor is deployed | — |
| Excessive IAM permission (beyond the FR-25 checks) | **No complete automatic gate** | B | Human policy review at the infrastructure HITL; residual accepted risk |
| Interference with Jenkins | **No automatic gate** | C | Window checklist (FR-18) verified by the Jenkins admin |
| Latency (NFR-05) | Measurement over ≥ 10 executions | C | — |

---

## 9. Open decisions and dependencies

None is resolved by assumption. OD-A1 and OD-A2 were resolved by the owner on 2026-10-06; all others remain open.

| OD | Question (unanswered) | Dependent requirements | What remains undecided |
|---|---|---|---|
| OD-Q5 | Does `<PRMS_REPORTING_DEV_TARGET>` support an instance profile? Dedicated deploy user? Which jobs use its leftover keys? | FR-13, FR-18 | The target's AWS permission mechanism; FR-13 requires the outcome |
| OD-Q7 | CDK or Terraform? | FR-25, all infrastructure | The IaC tool |
| OD-Q11 | Which host is the microservices server? PROD? Swarm? Proxy? | NFR-04, NFR-09, connectivity | The host |
| OD-Q12 | How does the Executor obtain AWS credentials without exposing them to other containers? | NFR-02 | The mechanism |
| OD-Q13 | Do the tests need configuration with secrets? | FR-22 (moved out of the Executor) | Whether CI needs a secret; NFR-02 forbids real `.env` in CI logs in any case |
| OD-Q14 | Does anyone consume `<JENKINS_EXECUTIONS_TABLE>`? | None in the PoC | Future record compatibility |
| OD-Q15 | Repo size and GitHub authentication | None in the Executor (no clone) | Recorded until the owner closes it |
| OD-N1 | CI for this platform repo | Gate D | The owner decides |
| OD-A1 | Supersede ordering mechanism | FR-03, FR-23 | **RESOLVED (owner, 2026-10-06):** `ci.runNumber` inside a single trusted source per `deploymentId`, one `deploymentId` per `lockKey`; multi-source out of the PoC. V1 (2026-10-07): per `targetId`, single source as a configuration rule |
| OD-A2 | Request authentication mechanism | FR-21, FR-25 | **RESOLVED (owner, 2026-10-06):** `SenderId` role binding to `allowedSender`; session names never authorize. V1 (2026-10-07): one shared CI role, no per-deployment binding |
| OD-A3 | Who performs non-SSH deploys | Out of scope | Later waves |
| OD-A4 | Store for non-Docker artifacts | Out of scope | Later waves |
| OD-A5 | Slack notification for CI failures | FR-14 | Whether the reusable workflow posts to Slack |
| OD-A6 | Approval to add workflows to application repos (the reusable workflow is pinned by commit SHA wherever the trust depends on it, DD-24) | FR-22, NFR-10 | Approval and pinning |
| OD-A7 | ECR tag immutability on `<ECR_REPOSITORY>` | FR-22 (tags) | Not needed by the PoC (digest only) |
| OD-A8 | Operator deploy-only / rollback path | FR-23 | Whether it exists and its authorization |
| OD-A9 | Confirm P-A5 per repository and the organization plan (P-G7) | NFR-07, FR-25 | Repository visibility and plan; gates B (N-29) and C (N-32) |

Evidence still missing: Jenkins job names (FR-18); current migration commands and order (FR-13); Dockerfiles and `.dockerignore` of `<PRMS_REPORTING_REPO>` (FR-22); whether frontend build values are secret (FR-22, NFR-02).

---

## 10. Requirement ID Index

| ID | Name | Strength | Proposal v3 |
|---|---|---|---|
| FR-01 | Deployment Definitions | Deferred (V1) | §10.4 |
| FR-02 | Target Registry | SHALL | §10.4 |
| FR-03 | Deploy request contract and execution identity | SHALL | §10.3, R-DIGEST |
| FR-04 | Event reception and validation | SHALL | §10.6 |
| FR-05 | Persistent execution state | SHALL | §10.7, §10.8 |
| FR-07 | Idempotent processing and dedupe | SHALL | §10.10 |
| FR-11 | Deploy lock and target mutex | SHALL | §10.10 |
| FR-12 | Deploy via SSH | SHALL | §10.11 |
| FR-13 | Deploy script contract | SHALL | §10.11 |
| FR-14 | Notifications | SHALL | §10.13 |
| FR-15 | Reconciliation | SHALL | §10.14 |
| FR-16 | Failure behavior | SHALL | §10.14 |
| FR-17 | Observability and audit | SHALL | §10.13 |
| FR-18 | Coexistence with Jenkins | SHALL | §12 |
| FR-21 | Request authentication and authorization | SHALL | R-AUTHN, §13.2 |
| FR-22 | CI contract | SHALL | R-CI, §10.2 |
| FR-23 | Supersede ordering | SHALL | R-ORDER, §10.9 |
| FR-24 | Deploy windows | SHALL | §10.10, §12 |
| FR-25 | CI trust boundary | SHALL | R-TRUST, §13.2 |
| NFR-01…10 | Non-functional | MUST / SHALL | §6, §13, §14 |

### 10.1 v2 → v3 mapping

| v2 ID | v3 status | Note |
|---|---|---|
| FR-01 Pipeline Definitions | **Modified** | Flat Deployment Definition; step vocabulary, `needs`, interpolation and CodeBuild-project scenarios removed; `allowedSender` added |
| FR-02 Target Registry | **Kept** | R2-W2 scenario preserved; window semantics referenced to FR-24 |
| FR-03 Execution request and identity | **Modified** | `DEPLOY_REQUESTED` contract; digest-only; `<deploymentId>-<sequence>` |
| FR-04 Event reception | **Modified** | Validation and `REJECTED` path; native AWS normalization and orphan events removed |
| FR-05 Persistent state | **Modified** | Execution-level only; R2-1 single backward transition preserved |
| FR-06 Step scheduling | **Removed** | One execution, one remote call |
| FR-07 Idempotent processing | **Modified** | Duplicate request, crash between intent and result, CI re-run |
| FR-08 Source preparation | **Removed** | No clone in the Executor |
| FR-09 Quality in Lambda | **Removed** | Tests in GitHub Actions |
| FR-10 Build in CodeBuild | **Removed** | Builds in GitHub Actions |
| FR-11 Lock and supersede | **Modified** | Lock + fencing + lease loss; canonical `LOCK_TIMEOUT` preserved; supersede moved to FR-23 |
| FR-12 Deploy via SSH | **Kept** (+ bounded sessions) | |
| FR-13 Deploy script contract | **Modified** | Digest references, mutex first, idempotent re-run; code 50 and migration precondition preserved |
| FR-14 Notifications | **Modified** | Deploy lifecycle only; CI failures in GitHub (OD-A5) |
| FR-15 Reconciliation | **Modified** | Deploy state only; CodeBuild recovery removed |
| FR-16 Failure behavior | **Modified** | F1–F8 (CI) removed; request and sender rows added; v2 F18 → F13, v2 F19 → F7b (fail fast, RL-1) |
| FR-17 Observability | **Modified** | `requestId`, GitHub run link, sender audit, rejected-sender alarm |
| FR-18 Coexistence with Jenkins | **Modified** | Procedure kept; technical backing and revalidation (S-4, R2-W1) moved to FR-24 |
| FR-19 Artifact retention | **Removed** | No source ZIPs or S3 artifacts remain; previous-image retention lives in FR-13; state-record TTL is a design concern |
| FR-20 GitHub webhook | **Removed** | GitHub triggers workflows natively; manual trigger is `workflow_dispatch` (FR-22) |
| — | **New** FR-21, FR-22, FR-23, FR-24, FR-25 | See above |
| NFR-01 | **Modified** | No clone/git/CI orchestration added |
| NFR-02 | **Modified** | Public CI logs, OIDC; ZIP/S3 clauses removed |
| NFR-03, NFR-09 | **Kept** | NFR-09 also covers the CI role |
| NFR-04 | **Modified** | No working disk; OD-Q15 dependency removed |
| NFR-05 | **Modified** | Measured from request to script start |
| NFR-06 | **Modified** | Adds the GitHub run link |
| NFR-07 | **Modified** | GitHub-hosted runners instead of CodeBuild/Lambda |
| NFR-08 | **Modified** | Configuration includes the caller workflow and CI role |
| NFR-10 | **Modified** | Caller workflow allowed under OD-A6 |

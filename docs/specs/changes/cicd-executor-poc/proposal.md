# Proposal — CI/CD Executor PoC (Jenkins Replacement, PRMS Reporting DEV)

> **Verdict in one line:** **GitHub Actions owns CI, SQS is the asynchronous handoff, the Executor owns deployment coordination only, and the target's versioned script owns the application-specific procedure.** For the dominant model (P1 Docker → ECR → SSH) and the PRMS Reporting DEV PoC this is the simplest safe architecture, with no fundamental blockers. Recommendation: **GO WITH CONDITIONS**, with four gates: writing code, deploying in DEV, the end-to-end deploy, and retiring Jenkins (§18).

---

## 1. Document Control

| Field | Value |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Slug | `cicd-executor-poc` |
| Type | **Change** (new feature, greenfield) |
| Approval Mode | `gated` (human gate, ctx §20) |
| Status | **v3.4**: rewritten under the approved Architecture Change AC-01; plan **approved by the owner on 2026-10-06** |
| Date | 2026-10-06 |
| Owner | CI/CD Platform Team |
| Sources | **AC-01** = `architecture-change-01.md` (APPROVED 2026-10-06; authority for this revision); **ctx** and **FA** = the local context and feasibility documents cited in v2 (sanitized section references only); owner directives 2026-10-05 and 2026-10-06 |
| Parent Spec | none (family in §16, not yet created) |
| Depends on | none |
| Parallel-safe | yes (with respect to `jenkins-config-inventory` and `cicd-security-remediation`) |

### 1.1 Evidence and how it is cited

`VERIFIED (FA §x)` = established by the feasibility analysis citing the Jenkinsfile (primary evidence for the current system). `VERIFIED (AC-01 §3, P-A#)` = an external-platform premise verified at its primary documentation. `UNVERIFIED — confirm at source before relying on it` = no primary evidence; never a basis for a decision.

### 1.2 Change history

| Version | Change |
|---|---|
| v1 | Written without the FA. Fargate runtime, generic CodeBuild, new Lambda worker |
| v2 | Validated against the FA. Runtime on the existing microservices server, CodeBuild per app+environment, `<QUALITY_WORKER_FUNCTION>` reused, per-deploy-unit lock + supersede, Jenkins coexistence, three gates |
| **v3** | **AC-01 (Model B).** CI moves to GitHub Actions; one `DEPLOY_REQUESTED` per build goes through SQS. Removed from the Executor's normal path: Lambda, CodeBuild, source clone/packaging, `/work`, git, the GitHub credential, the step planner/DAG, CI callbacks and correlation, the webhook ingress. Added: the CI → AWS trust boundary (OIDC, CI roles, sender binding), digest-only artifacts, supersede ordering as an open evaluated question (OD-A1), OD-A1…OD-A9. Non-SSH deploys explicitly out of the PoC (OD-A3). Application repos gain a caller workflow (OD-A6). Four gates re-derived |
| **v3.4** | **owner approval 2026-10-06:** OD-A2 and OD-A1 resolved (DD-25 approved; DD-27 approved for the PoC under the single-source invariant); new rule: actions in the trusted reusable workflow pinned by commit SHA |
| **v3.3** | Editorial E1–E5 after JD APPROVED (2026-10-06): bound-ref source, OD-A6 wording. No new decision |
| **v3.2** | **JD round-2 correction:** trust bound to direct IAM keys (`job_workflow_ref` at an immutable SHA, repository and owner IDs, Environment), no custom subject template; guard checks the bound ref for both events; P-A6 verified at source |
| **v3.1** | **JD round-1 correction:** CS-1 (custom OIDC subject with `job_workflow_ref` + event allowlist; negatives for `pull_request`, `pull_request_target`, `workflow_run`), CS-2 (supersede against every dispatched value), CC-1 (organization plan is a gate), CC-2 (dedupe scoped to `deploymentId`), SU-1 (secrets, not variables), CW-3 (`RECEIVED` removed from §10.8) |

---

## 2. Intent

Prove with a real PoC that the deployment responsibilities of a representative Jenkins pipeline can be replaced **without a new permanent CI server and without turning the Executor into another Jenkins**.

Cycles: **GitHub Actions** build → test → push by digest → send one request; **Executor** receive → validate → authenticate → resolve → coordinate → deploy → record → notify; **target script** lock → pull → migrate → swap → health → restore or prune → report.

This proposal covers the PoC (PRMS Reporting DEV) and its reusable contracts: CI contract, deploy request, Deployment Definition, Target Registry, state, locks, SSH and the deploy script.

---

## 3. Problem / Current Behavior

Facts unchanged from v2.

| # | Statement about the current state | Status |
|---|---|---|
| C1 | 152 pipeline files (150 `Jenkinsfile` and 2 `Jenkinsfile copy`) across 25 project folders, 9 deploy patterns, and ~40 credential IDs. Verdict **B**: Jenkins is removable, with gaps | VERIFIED (FA §1, §2, §24) |
| C2 | No pipeline needs a Jenkins-exclusive capability. There is no `input`, `build job:`, `stash`, `lock`, `retry`, or cron in the files. `parallel` appears in 9, `when` in 6, `timeout` in 2, and `post`/`finally` in all | VERIFIED (FA §1, §13) |
| C3 | ~45 pipelines build without Docker on the Jenkins host (Angular, Next, Astro, Vite, OpenNext, esbuild, Maven, `sam build --use-container`): this is **Blocker B1** | VERIFIED (FA §1, §19 B1) |
| C4 | The jobs' configuration (triggers, parameters, concurrency, global variables, credentials) is not in the repo. **What triggers each job is UNKNOWN** | VERIFIED as an absence (FA §1.4, §19 B2). The content remains `UNVERIFIED — confirm at source before relying on it` |
| C5 | 3 pipelines migrate the DB **from the Jenkins host** (PRMS reporting prod and prod-serverless, TANZANIA dev against RDS). About ~12 migrate on the target and RISK does it via Lambda | VERIFIED (FA §5.5 R42–R45, §19 H1) |
| C6 | ≥15 deploys delegate to scripts outside the repo: on hosts (`<HOST_SCRIPT_PATH>`…), as Secrets Manager values (`<SECRET_STORED_SCRIPT>`), or in application repos | VERIFIED their existence (FA §1.3, §19 H2). The content is `UNVERIFIED — confirm at source before relying on it` |
| C7 | `aws configure set` writes static keys on servers (35 files) and other jobs depend on those leftover keys | VERIFIED (FA §12.2.1, §9.3.5, §19 H3) |
| C8 | Unsafe concurrency: fixed S3 keys (`s3://<LEGACY_POC_BUCKET>/codebuild/frontend.zip`), fixed container names, `rmi N-1`, Docker pruning across the whole host, and **up to 8 jobs that deploy the same `<SERVER_CONTAINER>` and `<CLIENT_CONTAINER>` containers** | VERIFIED (FA §10.2, §10.3) |
| C9 | Security debt: `<AWS_CREDENTIAL_REF>` reads prod secrets (355 bindings), quality ZIPs with prod secrets, `.git` published on a public static site, an image in a public registry with a prod secret, SSH by password in 44 files, and host-key checking disabled in all of them | VERIFIED (FA §12.2) |
| C10 | **No pipeline does a rollback.** In P1, if the migration fails the old container has already been removed and the service is left down. `rmi N-1` deletes the only rollback image | VERIFIED (FA §11.4, §16) |
| C11 | There is a quality PoC in Lambda (`<QUALITY_WORKER_FUNCTION>`, with the contract `status, failedCommand, exitCode, error, logS3Uri, logUrl`) and a CodeBuild PoC for the frontend only (`<LEGACY_CODEBUILD_PROJECT>`), which polls with no timeout | VERIFIED its existence and output contract (FA §2, §5.3 R23, §16, §23). The implementation is `UNVERIFIED — confirm at source before relying on it` (outside the repo) |
| C12 | A single AWS account (`<AWS_ACCOUNT_ID>`) for all environments, in `<AWS_REGION>` (TANZANIA in `<AWS_REGION_SECONDARY>`). Environment separation **can only be by IAM/resource, not by account** | VERIFIED (FA §2) |

---

## 4. Proposed Outcome

Once the PoC is closed, an operator can:

1. Deploy PRMS Reporting DEV **without Jenkins**: a push to the allowed branch, or `workflow_dispatch` on the caller workflow, runs CI in GitHub Actions and sends one deploy request.
2. Verify the split of responsibilities:
   - GitHub Actions lints, tests, builds both images and pushes them to `<ECR_REPOSITORY>` **by digest**;
   - the Executor validates the request, authenticates the sender, dedupes, persists, applies supersede, the lock and the deploy window;
   - the Executor connects via SSH to `<PRMS_REPORTING_DEV_TARGET>` and runs the approved `deploy-container.sh`, which migrates and deploys.
3. Reconstruct what happened from the GitHub run (CI), DynamoDB, CloudWatch logs by `executionId`, and the Slack thread.
4. Verify that a duplicate request does not deploy twice, two requests do not collide, **a late older build never replaces a newer deployment**, an unauthorized sender is rejected, and **a failed migration leaves the previous version serving** (today it leaves it down, C10).
5. Keep Jenkins as the rollback: only its jobs pointing at the same target are temporarily disabled, during the test windows (§12).

---

## 5. Scope

### 5.1 In scope (PoC)

| Area | Includes |
|---|---|
| CI | One **reusable GitHub Actions workflow** in this platform repo (build, push by digest, send request) and the **PRMS Reporting DEV caller workflow** |
| Contracts | CI contract, deploy request schema, `deployment.schema.json` (replaces `pipeline.schema.json`), `targets.schema.json` (kept), DynamoDB model, SSH and deploy-script contracts |
| Executor | SQS consumer, request validation, sender authentication, dedupe, execution-level state machine, supersede, DynamoDB lock with fencing, deploy windows, SSH semaphore, SSH/SFTP with pinned host key, Slack, reconciler (deploy state only), structured logging |
| Trust boundary | GitHub OIDC provider in IAM, one CI role for `prms-reporting-dev`, SQS queue policy, GitHub Environment with deployment branch rules |
| Deploy | `deploy-container.sh` (versioned, delivered via SFTP per execution), adapted to digest references |
| DEV infra | Resources from §14.1 tagged `cicd-poc` |

### 5.2 Documented, not implemented in the PoC

Non-SSH deploy types (later waves, OD-A3), the non-Docker artifact store (OD-A4), the operator deploy-only/rollback path (OD-A8, designed only if decided), and Lambda/CodeBuild as **exceptional** mechanisms (§10.15).

---

## 6. Non-Goals

| Non-goal | Reason |
|---|---|
| Any CI work in the Executor (clone, package, install, lint, test, build, image push, CI result correlation) | GitHub Actions owns CI (AC-01 §4). Doing it in the Executor is the "another Jenkins" drift |
| Retiring or modifying Jenkinsfiles | Jenkins is the rollback (ctx §21). Disabling jobs temporarily is not modifying them |
| Covering all 152 pipelines, or non-SSH deploys | OD-A3. The PoC proves P1 only; coverage is mapped in §15.1 |
| An approval engine in the Executor | Production approval = GitHub Environments + Executor deploy windows (§13.2) |
| Self-hosted runners | They recreate a build fleet (AC-01 §9.3) |
| The Executor handling application secrets or connecting to a DB | Runtime and migration secrets are read by the target (§10.12) |
| Expression language, loops, logic driven by a command's return value | "Another Jenkins" signal (FA §19 H5) |
| SSH → SSM, Jira Builds API, Teams, email, web dashboard, all security debt | Future or parallel tracks (§13.5) |

**No longer a non-goal (v2 → v3):** "application repos are not modified". The PRMS Reporting repo gains a caller workflow file. Who approves that, and how the reusable workflow is pinned, is **OD-A6 (open)**.

---

## 7. Affected Users, Systems, And Specs

| Actor / System | Impact | Source |
|---|---|---|
| Existing microservices server | Hosts the `cicd-executor` container (no `/work` volume any more) | Owner decision. Exact host: OD-Q11 |
| `<PRMS_REPORTING_DEV_TARGET>` (credential `<SSH_CREDENTIAL_REF>`) | Target. Containers `<SERVER_CONTAINER>` (<SERVER_PORT_MAPPING>) and `<CLIENT_CONTAINER>` (<CLIENT_PORT_MAPPING>); pulls images by digest | VERIFIED (FA §23, §11.1) |
| Repo `<PRMS_REPORTING_REPO>` (server + client monorepo) | Gains the caller workflow and a GitHub Environment (OD-A6) | VERIFIED as the PoC source (FA §23) |
| This platform repo; GitHub (Actions, Environments, OIDC issuer); AWS IAM | Reusable workflow lives here; GitHub runs CI and enforces branch/Environment rules; IAM gains the OIDC provider and CI role, the Executor role loses S3, Lambda, CodeBuild rights | AC-01 §3, §6, §11 |
| ECR `<ECR_REPOSITORY>` (server and client) | CI pushes here; shared by up to 8 Jenkins jobs | VERIFIED (FA §10.3) |
| Up to 8 Jenkins jobs on the same containers | Disabled during the test windows (§12) | VERIFIED the files (FA §10.3). Job names: `UNVERIFIED — confirm at source before relying on it` (B2) |
| `<QUALITY_WORKER_FUNCTION>`, `<LEGACY_CODEBUILD_PROJECT>` | **Not used and not modified** | AC-01 §9.1 |
| PRMS Reporting DEV DB | Receives migrations from the target. **Shared by the Jenkins variants** (R9) | Inferred from FA §10.3; `UNVERIFIED — confirm at source before relying on it` |
| Slack `<SLACK_CHANNEL>` | Executor deploy notifications | VERIFIED (FA §15) |

---

## 8. Visual Reference

- Source: None
- Location: n/a
- Notes: backend and infrastructure change with no UI.

---

## 9. Requirement Delta Preview (v3 vs v2)

The requirements phase turns these into FRs (AC-01 §10).

### ADDED

| ID | Requirement | Expected FR |
|---|---|---|
| R-CI | A deploy-ready request is sent only by GitHub Actions after CI succeeds, once per build, with immutable artifact identities. CI failure sends nothing | New FR: CI contract |
| R-AUTHN | Each request is accepted only from the sender bound to its `deploymentId` (OD-A2 **resolved by the owner**: SQS `SenderId` role binding; session names never authorize). Otherwise `REJECTED`, audited, alarmed, never deployed | New FR: request authentication |
| R-DIGEST | Artifacts are deployed by digest only. The image repository comes from trusted configuration, never from the request. Tags are rejected | FR-03 / FR-13 |
| R-ORDER | An older build that finishes or is re-run later never replaces a newer deployment. Single trusted source per `deploymentId` and per `lockKey`; multi-source ordering out of the PoC (OD-A1 resolved) (OD-A1) | FR-11 |
| R-TRUST | The CI → AWS boundary uses OIDC with `sub` restricted to repository + GitHub Environment, least-privilege CI roles, and no internal identifiers in public CI logs (*refined by G-10: the CI role ARN and the AWS account ID are owner-accepted in CI logs (G-10, design DD-24 v4.7); hosts, IPs, credential IDs, credentials and secret values stay forbidden*) | New FR or NFR (design decides) |

### MODIFIED

| v2 item | v3 |
|---|---|
| R-DEF / FR-01 Pipeline Definitions | **Deployment Definitions**: flat, no step graph; `pipelineId` → `deploymentId` (semantic id `prms-reporting-dev` unchanged) |
| R-ID / FR-03 | `executionId = <deploymentId>-<sequence>` kept; the dedupe key is `deploymentId` + `requestId`, and `requestId` must equal `<ci.runId>-<ci.runAttempt>` (JD round 1, CC-2). Image tags are no longer derived from `executionId` (CI pushes; deploy is by digest) |
| R-QUEUE / FR-04 | One external message type, `DEPLOY_REQUESTED`, plus internal events. Strict schema with no infrastructure fields |
| R-IDEM / FR-07 | Kept; dedupe on `deploymentId` + `requestId` (DD-20 leased claim) |
| R-LOCK / FR-11 | Kept; ordering key `ci.runNumber` inside the single source (OD-A1 resolved) |
| R-ROLLBACK-READY / FR-13 | The previous image is kept **by digest**; exit 50 (target busy) part of the contract |
| R-NOSECRETS | No secrets in requests, definitions, the Executor image, logs, or **public CI logs** (ZIP and S3 clauses disappear) |
| R-RECON / FR-15 | Reduced to deploy state, orphan locks and past deadlines |
| FR-14 / AC9 | Deploy outcomes notify Slack; CI failures stay in GitHub (Slack for CI is OD-A5) |
| FR-16, FR-17 | Re-derived for one remote call and one result channel |
| FR-19 Artifact retention | Re-scoped: S3 retention disappears; what remains is fixed in requirements |
| NFR-01 | Narrowed: the Executor does not clone, package or hold a GitHub credential either |
| Trigger | Manual trigger = GitHub `workflow_dispatch` (was an IAM-signed SQS message) |

### REMOVED

- FR-06 Step scheduling and R-PAR (DAG, fan-in, `finally`): one execution, one remote call.
- FR-08 Source preparation, FR-09 Quality in Lambda, FR-10 Build in CodeBuild: CI runs in GitHub Actions.
- FR-20 GitHub webhook trigger: GitHub triggers workflows natively.

---

## 10. Proposed design (preview; `design.md` formalizes it)

### 10.1 Architecture and boundaries

```text
<PRMS_REPORTING_REPO> ── push (allowed branch) / workflow_dispatch ──> caller workflow
                                                      │ uses (pinned, OD-A6)
                                                      v
                         reusable workflow (this repo) on GitHub-hosted runners
                         checkout · install · lint · test · build · docker build
                         push to <ECR_REPOSITORY> → capture sha256 digests
                                                      │ OIDC → CI role (repo + Environment)
                                                      │ (ECR push to its repos, sqs:SendMessage)
                                                      v
                      SQS cicd-events-dev (Standard) ── maxReceiveCount 5 ──> DLQ → alarm
                                                      │
              ┌────────────── Existing microservices server ──────────────┐
              │ cicd-executor (CD coordination only)                       │
              │ validate · authenticate sender · dedupe · persist ·        │
              │ supersede · lock (fencing) · window · SSH semaphore · Slack│
              └──────────┬───────────────────────────────┬─────────────────┘
               DynamoDB cicd-executions-dev         SSH/SFTP (pinned host key)
               CloudWatch · Slack · Secrets Mgr            v
                                         <PRMS_REPORTING_DEV_TARGET>: deploy-container.sh
                                         flock · pull by digest · migrate · swap · health
                                         · restore · prune · CICD_RESULT
```

| Component | Owns | Never does |
|---|---|---|
| GitHub Actions | All CI, image push by digest, then **one** `DEPLOY_REQUESTED` | Choose a host, SSH, run commands on targets, hold SSH keys, read runtime secrets |
| SQS | Asynchronous at-least-once CI → CD handoff; DLQ | Order or deduplicate (the Executor does) |
| Executor | Deployment coordination: validation, sender authentication, dedupe, state, idempotency, supersede, lock, windows, SSH semaphore, trusted target and script resolution, Slack, audit, failure handling, reconciliation of deploy state | Clone, package, build, test, invoke CI, correlate CI results, read application secrets, connect to databases, per-project logic |
| Target script | The application-specific procedure (§10.11) | Decide ordering or locking across executions |

### 10.2 CI contract (what the reusable workflow must do)

| Rule | Detail |
|---|---|
| Runs in a GitHub Environment | The job that pushes and sends declares `environment: <GITHUB_ENVIRONMENT>`; its deployment branch rules gate it |
| Short-lived AWS credentials only | `permissions: id-token: write`; assumes the CI role via OIDC. No static AWS keys in GitHub |
| Immutable output | Captures the pushed **digest** of each image. Tags pushed for humans never drive a deploy and must not collide with Jenkins's integer tags in the shared repository (OD-A7) |
| One request per successful build | Sends exactly one `DEPLOY_REQUESTED` after all CI steps succeed. Any CI failure ends the run with nothing sent |
| Action pinning | Every action in the trusted reusable workflow is pinned by a full commit SHA (trailing version comment); `docker://` by digest; mutable refs prohibited; `./` exempt; enforced by a static guard (owner rule, 2026-10-06) |
| Public-safe logs | Role ARN, registry and queue URL come only from GitHub **secrets** (configuration variables render unmasked); the account ID is masked explicitly (P-A7, §13.3). *Refined by owner direction (2026-10-06): design DD-24 v4.7 — no GitHub secret; the role ARN is an Environment variable and may appear in logs with the account ID; registry and queue URL are derived after OIDC; OIDC only* |
| Event allowlist | The pinned reusable workflow runs only for `push` or `workflow_dispatch`, and only when the ref is the bound ref (both events), read from an administrator-controlled Environment variable, never from caller input (design DD-24); `pull_request`, `pull_request_target` and `workflow_run` stop before any OIDC token is requested (§13.2) |
| No deploy logic | The workflow never selects a host, script or command |

### 10.3 Deploy request contract (draft; the design fixes it)

```json
{
  "specVersion": 1,
  "eventType": "DEPLOY_REQUESTED",
  "requestId": "<github-run-id>-<run-attempt>",
  "deploymentId": "prms-reporting-dev",
  "commitSha": "<40-hex>",
  "artifacts": { "server": "sha256:<digest>", "client": "sha256:<digest>" },
  "ci": { "repository": "<GITHUB_ORG>/<PRMS_REPORTING_REPO>", "runId": "<id>", "runAttempt": 1, "workflowRef": "<ref>" }
}
```

| Rule | Why |
|---|---|
| `additionalProperties: false`. No host, IP, port, user, command, script, image repository, registry, `sudo` or environment variables | A request asks for a deployment; it never says how |
| Artifacts are digests only; tags rejected | What was tested is what is deployed |
| Ordering field is `ci.runNumber` | Inside the single bound source (OD-A1 resolved by the owner, §10.9) |
| `ci.*` is audit only; it never drives behavior | Traceability to the GitHub run |

### 10.4 Deployment Definition and target resolution (trusted)

`deploymentId` → **Deployment Definition** (bundled in the image, DD-19), a flat `deployment.schema.json` with:

- `targetRef` → Target Registry (`connectionRef`, `credentialRef`, `hostKeyRef`; DD-23 references); `deployScript` → the approved versioned script, delivered via SFTP (DD-10).
- Static script parameters: logical containers, `portRef`, `imageRepositoryRef` per artifact. Coordination: `lockKey`, `deployWindowPolicy`, `externalDeployers`, timeout, Slack channel.
- `allowedSender`: a **logical reference** to the CI role identity, resolved at startup like other identifier references (DD-23); never a raw ID in Git.

None of these values can be overridden by a request. Step-graph fields and reserved step types are dropped.

### 10.5 Executor runtime: existing microservices server

**Unchanged decision:** a `cicd-executor` Docker container on the existing microservices server (OD-Q11, OD-Q12 open). Limited `--memory`/`--cpus`, `restart=unless-stopped`, non-root, **no** `docker.sock`, **no** `/work` volume.

**Outbound connectivity only:** 443 to SQS, DynamoDB, Secrets Manager (SSH credential and Slack token: 2 reads, plus existence checks), CloudWatch, STS (OD-Q12) and Slack; **22** to `<PRMS_REPORTING_DEV_TARGET>` (network spike, Gate B, N-23). Removed vs v2: GitHub, S3, Lambda API, CodeBuild API. Any proxy is part of OD-Q11.

### 10.6 SQS

Unchanged from v2: Standard + DLQ (correctness from DynamoDB, DD-02/DD-03), long polling 20 s, visibility 120 s extended every 60 s while a deploy runs (DD-14), `maxReceiveCount` 5, retention 4 days / DLQ 14 days. **New:** a queue policy allowing `SendMessage` only from the configured principals, with sender binding **per message type**: `DEPLOY_REQUESTED` only from bound CI roles (or an operator role if OD-A8 adds one); internal types (lock retry, reconciliation tick) only from the Executor or the scheduler principals; deploy-window events only from the operator principal. Alarms: DLQ > 0, oldest message > 10 min, `REJECTED` sender.

### 10.7 DynamoDB (reduced)

Table `cicd-executions-dev`, on-demand, TTL `expiresAt`. Kept entities: execution, dedupe (DD-20), sequence, lock (DD-09), deploy window (DD-21), target state (current and previous digests, last deployed ordering value), instance lease. **Dropped:** step entities and step-level index use. Every state change is a conditional write (DD-03).

### 10.8 Execution state machine (closed, ~9 transitions; AC-01 §4.4)

```text
request ─validate─> QUEUED ─> WAITING_LOCK ⇄ (lock busy, bounded wait)
   │                    │            │
   │                    │            └─lock + window OK─> DEPLOYING ─exit 0──────> SUCCEEDED
   │                    │                                  │ exit 10/20/30/40 ─────> FAILED(code)
   │                    │                                  │ exit 50 ─────────────> WAITING_LOCK (only backward edge)
   │                    │                                  └ no result / crash ───> UNKNOWN_TARGET_STATE
   │                    └─ newer deployment per OD-A1 ordering ─> SUPERSEDED
   └─ invalid contract / unauthorized sender ─> REJECTED (audited, never deployed)
   WAITING_LOCK past its budget ─> FAILED(LOCK_TIMEOUT)
   no valid window (entry, retry, after 50, right before SSH) ─> FAILED(DEPLOY_WINDOW_CLOSED), fail fast
```

Kept: intent-then-act with `dispatchToken` before SSH (DD-04), exit 50 back-edge, canonical `LOCK_TIMEOUT`, `UNKNOWN_TARGET_STATE` (no blind retry). Dropped: step graph, asynchronous redispatch, `RETRY_LATER`/`ORPHAN` routing. The design publishes the exact closed list.

### 10.9 Supersede ordering (OD-A1 — RESOLVED by the owner on 2026-10-06 for the PoC; design DD-27)

**Owner decision:** exactly one `deploymentId` per `lockKey`; exactly one trusted GitHub source per `deploymentId` (repository + workflow + environment + allowed sender); `ci.runNumber` orders inside that source; equal = same logical run or re-run, not older; `highestAccepted` protects acceptance and `highestDispatched` protects deployment from X9 on; an older run never deploys after a newer run reached the deployment intent boundary. Multi-source ordering is out of the PoC (revisit DD-27 if ever needed; never compare `runNumber` across sources). Workflow rename/reset is an accepted fail-safe limitation; rebinding requires the future audited OD-A8 procedure. The candidate evaluation below is kept for the record.

**Safety goal:** an older build that finishes or is re-run later must never replace a newer deployment of the same `lockKey`. Behavior across reruns and across several repositories or workflows targeting one deploy unit must be defined.

| Candidate | Strength | Concern to evaluate |
|---|---|---|
| Commit SHA + ancestry check | Orders by code history, not by timing | Needs repository access from the Executor (a GitHub credential returns) or a trusted ancestry proof |
| GitHub run metadata (`run_number`, `run_attempt`, `run_id`) | Available in every run; no extra access | Scoped to one workflow; rerun behavior rests on P-A6 (VERIFIED at source in JD round 2) |
| Executor-issued monotonic sequence | Fully under Executor control | Orders by arrival, so a late older build arrives "newer" |
| Commit timestamps | Simple | Author/committer times are client-set and not monotonic |
| Bound source: one `deploymentId` ↔ one repository + environment + workflow; ordering inside that source | Removes cross-repo ambiguity; pairs with sender binding | Up to 8 Jenkins variants share the unit today (C8); multi-source units need a rule |

**Criteria:** safety under at-least-once delivery and reruns; no new Executor credential; works with sender binding (OD-A2); verifiable by test (AC17); simplest that meets the goal.

### 10.10 Locks, windows and idempotency (kept)

Dedupe on `deploymentId` + `requestId` with a leased claim (DD-20); DynamoDB lock per deploy unit with lease, fencing and bounded wait (DD-09, design §7.6); target-side kernel `flock`, exit 50 when busy (DD-22) — the two lock layers never replace each other; per-target deploy windows with Jenkins as data (DD-21, §7.7); SSH semaphore and resource release (§7.5); intent-then-act before the SSH call (DD-04).

A re-run of the same CI run produces a new `requestId` with the same digests; the script's idempotent no-op path applies (FR-13).

### 10.11 SSH and the deploy-script contract

- `ssh2` (exec + SFTP). **Pinned host key mandatory** (disabled in all pipelines today, FA §11.1). Key preferred; password only as a temporary, explicit fallback (FA §23.5). Credential read per execution, memory only.
- The Executor runs `<approved-script> --execution-id <id> --lock-key <k> --fencing-token <t> --artifact <unit>=<repo-from-config>@sha256:… <static params>` with escaped arguments; records the script checksum; captures exit code, log tail and the final `CICD_RESULT {json}` line. No blind SSH retry once the script has started.
- `deploy-container.sh` is the first Docker implementation. Order (fixes C10):

1. Take the kernel `flock` by `lockKey`; if busy, exit 50 having done nothing.
2. Log in to ECR with the host's role; pull **by digest**.
3. Read the runtime secret → unique temporary `.env` (0600), deleted on the target.
4. Run migrations with the new image **before** stopping the old container. If they fail: exit 20; the old version keeps serving.
5. Swap; health check. If it fails: restore the previous image and exit 40.
6. Prune: never remove the previous image.

| Exit | Meaning | Previous state preserved |
|---|---|---|
| 0 | OK | n/a |
| 10 | Login or pull failed | Yes |
| 20 | Migration failed | Yes (DB may be partially migrated if not transactional) |
| 30 | Start failed; previous restored | Yes |
| 40 | Health failed; previous restored | Yes |
| 50 | Target busy (local mutex held); nothing done | Yes |
| other / lost session | Unknown | `UNKNOWN_TARGET_STATE` + runbook |

Migrations must be **backward compatible**. The exact current migration mechanism is `UNVERIFIED — confirm at source before relying on it` (Q2).

### 10.12 Secrets and credentials: who reads what

| Secret | Today | In the PoC |
|---|---|---|
| Frontend build values (`environment*.ts`) | Jenkins writes them into the tree | GitHub Actions, from **Environment-scoped** secrets, never exposed to fork PRs. Whether they are secret or public-safe config is `UNVERIFIED — confirm at source before relying on it` (Q2) |
| Server runtime and migration `.env` | Target, with leftover `aws configure` keys | **The target**, with its own role (OD-Q5) |
| Test configuration | Inside quality ZIPs (prod secrets in the current PoC) | Fake, non-secret configuration in CI; real `.env` never enters CI (OD-Q13 recorded) |
| SSH credential | Jenkins (`<SSH_CREDENTIAL_REF>`) | Secrets Manager `<SSH_CREDENTIAL_REF>`, memory only |
| GitHub token | UNKNOWN global credential | **None in the Executor** |
| Slack | `<SLACK_TOKEN_REF>` | `<SLACK_TOKEN_REF>` |
| Executor AWS credentials | `<AWS_CREDENTIAL_REF>` (reads prod) | Dedicated `cicd-executor-dev` role, DEV only (OD-Q12) |
| CI AWS credentials | n/a | OIDC short-lived, one role per repository + environment |

**Trap on the target (unchanged):** leftover `~/.aws/credentials` eclipse an instance profile. The script forces the role chain or a dedicated deploy user is used. Existing keys are **not deleted** in the PoC (C7, H3).

### 10.13 Notifications and observability

- Slack (Web API, one thread per execution) for: accepted, deploy failure (incl. `UNKNOWN_TARGET_STATE`, `LOCK_TIMEOUT`), success, superseded, rejected. Best-effort: a Slack failure never fails a deploy.
- CI failures are visible in GitHub; a Slack step in the reusable workflow is OD-A5.
- JSON logs with `executionId`, `requestId`, `deploymentId`; EMF metrics (executions, deploy duration, lock wait); alarms (DLQ, stale queue, heartbeat, rejected sender). The GitHub run link is stored for audit.

### 10.14 Failure behavior

| Failure | Behavior |
|---|---|
| CI fails (lint, test, build, push) | Stays in GitHub; no request is sent; the Executor sees nothing |
| Malformed request / unknown `deploymentId` / unauthorized sender | `REJECTED`, audited, alarm; never deployed |
| Duplicate request | Dedupe → no-op |
| Older build arrives after a newer deploy | `SUPERSEDED` (OD-A1 ordering) |
| Lock busy | `WAITING_LOCK`, bounded; then `FAILED(LOCK_TIMEOUT)` |
| Target requires a window and none is valid | `FAILED(DEPLOY_WINDOW_CLOSED)` at once (v2 semantics kept) |
| SSH connect fails | Up to 2 retries **before** the script starts; then `FAILED`; lock released |
| Script exits 10/20/30/40 | `FAILED(code)`; no automatic retry |
| Script exits 50 | Back to `WAITING_LOCK` within the wait budget |
| Session lost mid-script / Executor crash | `UNKNOWN_TARGET_STATE` + runbook; never re-run blindly |
| Stuck execution / orphan lock | Reconciler: deadlines and leases |
| Slack fails | Logged; deploy continues |
| Poison message | DLQ → alarm → manual redrive |

### 10.15 Exceptions (not the normal path, not banned)

CodeBuild in a VPC or a VPC Lambda for work needing an AWS-internal network and no target server (e.g. migrations against RDS, TANZANIA, H1); Lambda for small AWS event processing. Self-hosted runners are not recommended. Adding an exception to the Executor's vocabulary requires a spec change. It adds nothing to the normal path.

---

## 11. Approach Options

| Option | Status | Notes |
|---|---|---|
| **A. Executor → Lambda / CodeBuild → SSH** (v2) | **Superseded** by AC-01 | Step DAG, 13 transitions, three asynchronous result channels; B1 unsolved; Executor clones and holds a GitHub credential (AC-01 §6) |
| **B. GitHub Actions (CI) → SQS → Executor (CD) → SSH** | **Selected** | ~45–50% less Executor code, one result channel, B1 builds covered by native toolchains, CI free on public repos (P-A1) |
| **C. GitHub Actions deploys directly** | Rejected | See below |
| **D. AWS Step Functions** | Not selected | Warning signs below |
| **B'. Same Executor on ECS Fargate** (formerly A') | Alternative | Isolates from the shared host (R2, R3) for a small fixed cost. Plan B if OD-Q11 or OD-Q12 resolve badly |
| Script preinstalled at `/opt/deploy` | Alternative | Simpler, can drift from Git. SFTP delivery per execution is preferred |

**Why C is rejected (AC-01 §5):** the test is "does this need centralized deployment coordination?".

| Responsibility | Central? | Why |
|---|---|---|
| Network reach to private targets | Yes | Hosted runners would need inbound SSH from the internet, or a self-hosted fleet |
| SSH key custody | Yes | Keys would live in GitHub secrets of public repos |
| Cross-repo lock and supersede | Yes | Up to 8 jobs deploy the same containers (C8); GitHub `concurrency` groups are not cross-repo, durable or fenced |
| Deploy windows (Jenkins coexistence) | Yes | One policy per target, not per workflow (DD-21) |
| Central Slack and audit | Yes, moderately | One format and a reconstructable trail |
| Lint, test, build, push | No | Moved to GitHub Actions |

**Warning signs for reconsidering Step Functions** (FA §19 H5, §24.7): nested conditional branching; sub-workflows or retry graphs; expressions, loops or a growing DSL; long waits the Executor must sustain; per-project logic; sagas. **New sign:** CI work or CI result correlation creeping back into the Executor. Two or more signs → re-evaluate before extending the Executor.

---

## 12. Recommended Approach and coexistence with Jenkins

**Option B.** GitHub Actions does CI; the Executor stays within deploy coordination; application procedures live in versioned target scripts.

**Coexistence with Jenkins (FR-18, unchanged).** Up to 8 jobs deploy `<SERVER_CONTAINER>` and `<CLIENT_CONTAINER>` on `<PRMS_REPORTING_DEV_TARGET>` (FA §10.3); seven are identified as `<JENKINS_JOB_ID>` entries, plus whatever the inventory reveals. Procedure for each **deploy test window**:

1. Announce the window in the PRMS team's channel.
2. Confirm in Jenkins that none of those jobs have builds in progress.
3. **Disable** them ("Disable Project", reversible, Jenkinsfiles untouched). Requires the job names (Q1 / B2) and the Jenkins owner's approval.
4. Open the Executor deploy window (DD-21) listing the disabled jobs; run the tests.
5. Close the window, re-enable the jobs, record who/when/executions in `docs/jenkins-coexistence-log.md`.

Jenkins is not shut down globally. Deploying to separate PoC containers is allowed for early iterations but **does not replace** testing on the real target (shared DEV DB, R9).

---

## 13. Security

### 13.1 Required for the PoC (FA findings, re-derived)

| Measure | FA finding |
|---|---|
| Dedicated DEV AWS role for the Executor; **never** `<AWS_CREDENTIAL_REF>` | §12.1, §12.2.2 |
| The Executor does not run `aws configure set`; the target uses its own role (with the §10.12 trap) | §12.2.1, H3 |
| Pinned host key in SSH | §12.2.6 |
| SSH credential in Secrets Manager, memory only, redacted in logs | §12.3 |
| Remote temporary `.env` with a unique name and 0600, deleted **on the target** | §11.4, §12.2.8 |
| Executor credential mechanism with no exposure to other containers (OD-Q12) | §12.3 |
| No secrets baked into images; build values from Environment-scoped secrets only | §12.2.3 (adapted) |

Removed vs v2: ZIP/S3 secret controls (no ZIPs) and webhook HMAC (no ingress).

### 13.2 New boundary: GitHub → AWS → Executor (AC-01 §8)

| Threat | Control |
|---|---|
| Fork, PR, `pull_request_target` or `workflow_run` obtains AWS credentials | An environment `sub` does not carry the event, and those triggers run on the default branch (design P-A2, P-G2). So the trust policy requires, by exact equality, the **`job_workflow_ref` of the platform reusable workflow pinned at an immutable commit SHA**, the **repository and owner IDs** (immutable; robust to rename and transfer, design P-G10) and the Environment, all direct IAM condition keys (design P-G6); no custom subject template. The **event allowlist** (`push` or `workflow_dispatch`, bound ref only) runs inside that pinned workflow and is the only event control. Never wildcards. Does not rely on P-A3 (UNVERIFIED) |
| Workflow modified in a branch to deploy | GitHub Environment **deployment branch rules** (protected branches only); branch protection on the default branch (reviews, no force-push) |
| Production deploy without approval | GitHub Environment **required reviewers** for production; Executor deploy windows on top. No approval engine in the Executor |
| CI role over-privileged | One role per repository + environment: ECR auth + push to **its** repositories only; `sqs:SendMessage` on the deploy queue only. No SSH, EC2, Secrets Manager, DB or infra rights |
| Request for a deployment the repo does not own | `SenderId` role binding to the definition's `allowedSender` (OD-A2 resolved by the owner; P-A4). Session names are never an authorization input; a CI sender is authorized only for its assigned event types and `deploymentId` values. Mismatch → `REJECTED` + alarm |
| Malicious request content | Strict schema, no infrastructure fields (§10.3); digest format validated; unknown `deploymentId` rejected |
| Mutable tag swapped after tests | Digest only; image repository from trusted config (`imageRepositoryRef`), never from the request. Tag immutability is OD-A7 |
| Replayed or duplicate message | Dedupe on `deploymentId` + `requestId`, with `requestId` validated against `ci.runId`/`ci.runAttempt` (DD-20); idempotent script path |
| Older build replaces newer | Supersede with the OD-A1 ordering (§10.9), checked under the lock against every value ever dispatched, so a newer run ending in an unknown state or losing its lease still blocks older ones |
| Operator rollback to an older version | Only via a separately authorized, audited path (OD-A8); never through the CI role |

### 13.3 Public repositories: what becomes visible

- **Workflow files and CI logs are public** (P-A7, UNVERIFIED; the safe assumption is yes): role ARNs, registry host and queue URL come only from **secrets** (variables render unmasked); the account ID is masked explicitly (refined by design DD-24 v4.7, owner direction 2026-10-06: no GitHub secret; the role ARN is a variable; registry and queue URL are derived after OIDC). DD-23's publication policy extends to application repos.
- **The deploy request** carries only public-safe identifiers; hosts never appear. **Build-time secrets:** prefer none; otherwise Environment-scoped, never available to fork PRs.
- **P-A5 "repositories are public"** is UNVERIFIED per repository (OD-A9). If a repo is private, the security model depends on the organization plan: deployment branch rules and environment secrets need Pro/Team or higher, required reviewers need Enterprise, and on Free a conversion to private makes protection rules be ignored (design P-G7). Not resolved here: OD-A9 gates B and C.

### 13.4 Security assumptions (AC-01 §15)

GitHub's OIDC issuer is trusted (compromise limited to ECR push and SQS send). **Repository admins are inside the deploy trust boundary.** A CI role compromise can at most request **its own** `deploymentId`, still subject to supersede, windows, locks and the script. `SenderId` is set by AWS (P-A4). Public CI logs are treated as public.

### 13.5 Parallel remediation and longer-term cleanup (unchanged; do not block the PoC)

`cicd-security-remediation`: rotate `<AWS_CREDENTIAL_REF>` and separate IAM for prod and non-prod. Stop `aws configure set` and put instance profiles on every host. Remove prod secrets from `s3://<LEGACY_POC_BUCKET>` and from the staging jobs. Retire the image published in a public registry with a prod secret. Stop publishing `.git` on the affected static site. Migrate SSH password → key in the 44 files and enable host keys. Fix the `finally` blocks that run on the wrong host. Move plaintext secrets in Lambda environment variables to Secrets Manager. Change the default credentials of the affected monitoring service.

Longer term: shell injection in `getLastCommitInfo` (disappears with Jenkins). Unauthenticated JMX in a Java service. `sudo -S` with a password. `chmod 777` on secrets directories. Guards for `docker swarm leave --force`. Growth of Lambda permission policies. Relocate `RECORDS/BRANCH`.

---

## 14. Resources, cost, plan, files

### 14.1 PoC resources (DEV, account `<AWS_ACCOUNT_ID>`, `<AWS_REGION>`)

| Resource | Name / content |
|---|---|
| SQS Standard + DLQ | `cicd-events-dev`, `cicd-events-dev-dlq`, with a **queue policy** restricting `SendMessage` |
| DynamoDB | `cicd-executions-dev` |
| ECR | `cicd-executor` (Executor image). Existing `<ECR_REPOSITORY>` reused as the CI push target |
| IAM OIDC provider | GitHub Actions issuer (new) |
| IAM roles | `cicd-executor-dev` (SQS consume, DynamoDB, 2 secret reads, logs); **CI role** for `prms-reporting-dev` (ECR push to its repos, `sqs:SendMessage`), trust bound to repo + Environment |
| EventBridge Scheduler | `cicd-reconcile-dev` (`RECONCILE_TICK`, DD-13). The CodeBuild state rule is removed |
| Secrets Manager | `<SSH_CREDENTIAL_REF>` (+ `<SSH_HOST_KEY_REF>`), `<SLACK_TOKEN_REF>` |
| CloudWatch | Log groups (30 days), alarms, saved queries |
| GitHub | Environment `<GITHUB_ENVIRONMENT>` on `<PRMS_REPORTING_REPO>` (branch rules), CI role trust bound to repository and owner IDs, Environment and the SHA-pinned reusable workflow, identifiers as secrets; reusable workflow in this repo |
| Microservices server | `cicd-executor` container; credentials per OD-Q12 |
| `<PRMS_REPORTING_DEV_TARGET>` | Instance profile or equivalent (pull from `<ECR_REPOSITORY>`, read the DEV runtime secret; OD-Q5), deploy user, authorized key |

**Removed vs v2:** CodeBuild project and role, S3 `cicd-artifacts-dev`, Lambda Destinations and role, the CodeBuild EventBridge rule, the ingress Lambda + Function URL and role, `<GITHUB_CREDENTIAL_REF>`, `<WEBHOOK_SECRET_REF>`, the `/work` volume.

### 14.2 Cost categories

| Category | Expectation |
|---|---|
| GitHub Actions | Standard hosted runners free on public repos (P-A1); larger runners always charged. ~0 if P-A5 holds (OD-A9) |
| Executor | Existing server; no new fixed compute |
| SQS, DynamoDB on-demand, Scheduler, Secrets Manager, CloudWatch | Immaterial to low |
| ECR | Existing repos; watch image retention |

CodeBuild minutes (v2's main variable cost), Lambda GB-s and S3 disappear from the PoC.

### 14.3 Plan by increments

| Inc | Delivers | Gate |
|---|---|---|
| 0 | v3 spec set approved after the scoped Judgment Day. Obsolescence cleanup; schemas (deployment, request, targets), PoC definition (N-01–N-03) | A |
| 1 | Domain and store: state machine, request validation and sender-binding logic, dedupe, lock, supersede, windows, coordinator with a fake transport, SSH adapter, script adaptation. Tests with DynamoDB Local (N-04–N-20) | A |
| 2 | Reusable workflow + PRMS caller, statically validated in this repo; Gate A closure (N-21, N-22) | A |
| 3 | **Network spike** (443 to AWS and Slack; 22 to the target); DEV infra (queue + policy, table, OIDC provider, CI role, Executor role) and the Executor container. Synthetic requests: valid → Slack; poison → DLQ; wrong sender → `REJECTED`. Infra only: no real CI run (N-23–N-29) | B |
| 4 | Target preparation; caller in the application repo (OD-A6): first real CI → ECR by digest → SQS; request ends `FAILED (DEPLOY_WINDOW_CLOSED)` with no SSH (N-30–N-32) | **C** |
| 5 | SSH and window validation, then SSH + lock + `deploy-container.sh` + migration on the target, in a window with Jenkins disabled (N-31, N-33) | C |
| 6 | Failure tests: Executor kill, broken migration, duplicates, late older build and real re-run, wrong sender, PR run cannot assume the CI role (N-34) | C |
| 7 | Acceptance E2E and measurement report vs §14.2 (N-34, N-35) | C |

### 14.4 Files expected during execution (not now)

Added: `.github/workflows/` (reusable workflow + example caller), `schemas/{deployment,deploy-request,targets}.schema.json`, deployment definitions (directory rename from `pipeline-definitions/` fixed in design). Kept: `executor/`, `deploy-scripts/deploy-container.sh`, `infra/RESOURCES.md` (IaC tool: OD-Q7), runbooks and `docs/jenkins-coexistence-log.md`. Removed: `ingress/`, buildspecs, source/Lambda/CodeBuild handlers, the planner. Outside this repo, only the caller workflow in `<PRMS_REPORTING_REPO>` (OD-A6). Jenkinsfiles, application code, `<QUALITY_WORKER_FUNCTION>` and `<LEGACY_CODEBUILD_PROJECT>` are not modified.

---

## 15. Validation against the 152 pipelines, risks, and questions

### 15.1 Coverage under Model B

| FA pattern | ≈# | Build (GitHub Actions) | Deploy | Status |
|---|---:|---|---|---|
| P1 Docker → ECR → SSH | 57 | Yes | Executor + SSH | **The PoC**; password → key migration remains |
| P2 SSH + script on host | 18 | Yes where possible | Executor + SSH | Script content UNKNOWN (H2) |
| P3 static → S3 → CloudFront | 8 (+~10) | Yes (B1 builds covered) | Not SSH | **Later wave; OD-A3 open** |
| P4 / P4b Lambda image | 6 (+2) / 9 | Yes | AWS API | **Later wave; OD-A3 open** |
| P5 Lambda ZIP | 8 | Yes | AWS API | **Later wave; OD-A3, OD-A4 open** |
| P6 SAM / CFN / repo scripts | 15 | Yes (toolchains available) | Not SSH | **Later wave; OD-A3 open**; manual change sets stay manual |
| P7 Swarm | 4 | Yes | Executor + SSH | Host-scoped lock (future) |
| P8 CI only | 22 | Yes | none | Entirely GitHub Actions; no Executor |
| P9 utilities | 3 | — | — | Outside the Executor |

| Still unresolved | Note |
|---|---|
| Non-SSH deploys (~55 pipelines) | OD-A3. Blocks retiring Jenkins, not the PoC |
| Groovy control logic (`sshCommand`-driven flow, branch-tip gating, secret transformations, source `sed`, file patching) | Belongs in workflows or scripts, never in the Executor |
| Migrations with no target server (TANZANIA → RDS) | Needs an exception mechanism (§10.15) |
| Concurrency the lock does not cover | Executor vs Jenkins (§12), shared DEV DB (R9), port conflicts (registry validation), destructive host operations (future host lock) |
| Jenkins functions with no full replacement | Console/replay (partly GitHub runs + CloudWatch), coverage trends, Jira plugin (87 pipelines), job configuration (B2) |
| External inputs missing | Job names/triggers (B2); Dockerfiles and `.dockerignore`; migration commands and order; consumers of `<JENKINS_EXECUTIONS_TABLE>` |

**Genuine blocker for the PoC:** none fundamental. R2, R3 may force a host change (to B'), and OD-A6 gates the real CI run.

### 15.2 Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Jenkins and the Executor deploy to the same target | §12 procedure + DD-21 windows; job names via the inventory |
| R2 | The "microservices server" is the **PROD host** (`<MICROSERVICES_PROD_HOST>`) where Jenkins runs `swarm leave --force` | Confirm the host (OD-Q11); if PROD, another host or B' |
| R3 | Executor AWS credentials reachable by other containers on the shared host | OD-Q12; blast radius smaller than v2 (no S3, Lambda, CodeBuild, GitHub) |
| R5 | Leftover keys in the target's `~/.aws` eclipse the instance profile | Dedicated deploy user or forced role chain (§10.12) |
| R6 | Migrations are not backward compatible | Documented requirement; DEV DB snapshot before the first test |
| R8 | Unknown target state after the SSH is cut | `UNKNOWN_TARGET_STATE` + runbook; idempotent script |
| R9 | DEV DB shared with Jenkins variants from other branches | Windows with jobs disabled; snapshot; check migration state before and after |
| R10 | The Executor grows into a workflow engine or reabsorbs CI | §11 warning signs; vocabulary review per wave; boundary guards (T-21) |
| R11 | **GitHub becomes the CI critical path**: an outage blocks new deploys | Deploy-only path with an already-built digest (OD-A8); Jenkins stays as rollback during the PoC |
| R12 | **Public CI logs** leak account IDs, role ARNs or hosts | Secrets only (variables are unmasked); explicit account-ID mask; log review in AC12. *Superseded by design DD-24 v4.7 (owner, 2026-10-06): no GitHub secret; role ARN and account ID may appear in logs; no credential ever does* |
| R13 | **Repository admins** weaken branch or Environment rules | Admins are in the trust boundary (§13.4); sender binding, supersede and windows still apply; periodic settings review |
| R14 | OIDC trust policy too broad (wildcard or environment-only `sub`, untrusted triggers) | Exact match on direct IAM keys (`job_workflow_ref` at an immutable SHA, repository and owner IDs, Environment), event allowlist; negative tests (AC15) |
| R15 | Supersede ordering wrong under reruns or multiple repositories | OD-A1 resolved: single source per `lockKey`, multi-source out of the PoC; AC17 |
| R16 | Shared `<ECR_REPOSITORY>` with mutable tags and Jenkins integer tags | Digest-only deploy; non-colliding tag convention; OD-A7 |
| R17 | Adding the caller workflow to the application repo is not approved | OD-A6 escalated to the owner; no workaround assumed |

Dropped from v2: R4 (worker async support) and R7 (clone disk) — their causes left the Executor.

### 15.3 Questions and open decisions

| ID | Question | Status | Notes |
|---|---|---|---|
| Q1 | 152-pipeline report + PRMS Reporting DEV `config.xml` | **PARTIALLY RESOLVED** | FA available; job names, triggers, concurrency missing (B2). Blocks Gate C |
| Q2 | Previous PoC and current deploy | **PARTIALLY RESOLVED** | Worker input format and previous buildspec **no longer needed** (not used), still recorded until the owner closes them. Still needed: Dockerfiles/`.dockerignore`, migration commands and order, reference branch, nature of frontend build values |
| Q3 | Coexistence with Jenkins | **PARTIALLY RESOLVED** | Policy decided (§12); job names and the approving Jenkins owner missing |
| Q4 | SSH vs SSM | **RESOLVED** | SSH for the PoC |
| Q5 / OD-Q5 | Instance profile on the target | **OPEN** | Blocks Gate C |
| Q6 | Network | **PARTIALLY RESOLVED** | Connectivity reduced (§10.5); spike in Gate B (N-23) |
| Q7 / OD-Q7 | IaC tool | **OPEN** | Blocks Gate B |
| Q8 | Framework | **PARTIALLY RESOLVED** | TypeScript, no web framework (DD-15) |
| Q9 | Artifact retention | **Re-opened in scope** | S3 retention gone; ECR/state retention fixed in requirements (FR-19) |
| Q10 | GitHub Actions | **RESOLVED by AC-01** | Selected for CI (owner, 2026-10-06) |
| Q11 / OD-Q11 | Which host is the microservices server? | **OPEN** | Blocks Gate B (R2) |
| Q12 / OD-Q12 | Executor AWS credentials on that host | **OPEN** | Blocks Gate B (R3) |
| Q13 / OD-Q13 | Do tests need `.env`? | **OPEN, moved out of the Executor** | Now a CI-workflow concern |
| Q14 / OD-Q14 | Consumers of `<JENKINS_EXECUTIONS_TABLE>` | **OPEN** | Blocks retiring Jenkins |
| Q15 / OD-Q15 | Repo size and GitHub authentication | **OPEN, moved out of the Executor** | No clone in the Executor; recorded until the owner closes it |
| OD-N1 | CI for this platform repo | **OPEN** | GitHub Actions is the natural candidate; the owner decides |
| OD-A1 | Supersede ordering key | **RESOLVED (owner, 2026-10-06)** | `ci.runNumber` inside a single trusted source; multi-source out of the PoC (§10.9, DD-27) |
| OD-A2 | Request authentication model | **RESOLVED (owner, 2026-10-06)** | `SenderId` role binding to `allowedSender` (DD-25) |
| OD-A3 | Who performs non-SSH deploys | **OPEN** | Out of the PoC; Gate D waves |
| OD-A4 | Store for non-Docker artifacts | **OPEN** | Non-Docker waves |
| OD-A5 | CI failure notification to Slack | **OPEN** | Design (AC9) |
| OD-A6 | Approval to add workflows to application repos (the reusable workflow is pinned by commit SHA wherever the trust depends on it, DD-24) | **OPEN** | Blocks Inc 4 (Gate C, N-32) |
| OD-A7 | ECR tag immutability on `<ECR_REPOSITORY>` | **OPEN** | Not the PoC (digest only) |
| OD-A8 | Operator deploy-only / rollback path and its authorization | **OPEN** | Design |
| OD-A9 | Confirm P-A5 (public) per repository | **OPEN** | Gate B |

---

## 16. Initiative decomposition (documented, no directories created)

| Order | Initiative | Purpose | Depends on | Parallel-safe |
|---|---|---|---|---|
| 1 | `cicd-executor-poc` (this one) | Prove Model B with PRMS Reporting DEV | none | yes |
| 1 | `jenkins-config-inventory` | Export `config.xml`, triggers, parameters, concurrency, plugins, credentials, the `db-operations` library; map job → file; inventory host and Secrets Manager scripts | none | yes |
| 1 | `cicd-security-remediation` | §13.5 | none | yes |
| 2 | `cicd-build-runtime-poc` (**proposed re-scope**) | Prove a non-Docker build in GitHub Actions and decide OD-A3/OD-A4 with one static site and one Lambda ZIP | 1 | no |
| 3+ | Migration waves (FA §25.10) | Only after the PoC is validated | 1, inventory, 2 for P3/P5/P6 | no |

```text
Executor PoC development can start  ≠  Jenkins can be retired
```

---

## 17. Success Criteria / Acceptance

| # | Criterion | Test |
|---|---|---|
| AC1 | PRMS Reporting DEV deploys end-to-end with no Jenkins: caller workflow → ECR by digest → SQS → Executor → SSH → `deploy-container.sh` | E2E in DEV (push and `workflow_dispatch`) |
| AC2 | The Executor image contains no build toolchain and **no git** (no build npm, mvn, docker CLI or socket, git) | Image inspection |
| AC3 | The Executor has no network path or credentials to any DB, application secret or GitHub | IAM, secrets and network review |
| AC4 | **No CI work in the Executor**: no clone, package, build, test, CI invocation or CI result correlation; no S3, Lambda or CodeBuild permissions | Code, boundary guards, IAM review |
| AC5 | A duplicate `DEPLOY_REQUESTED` produces no second deploy or migration | Duplicate injection |
| AC6 | Two concurrent requests for one deploy unit: serialized deploys, fencing respected | Concurrent test |
| AC7 | A failed migration leaves the previous version serving | Broken migration on a test branch |
| AC8 | A failed health check restores the previous image (by digest) | Image that fails health |
| AC9 | CI failure stays in GitHub and sends no request; deploy failures notify Slack | Red test; failing deploy |
| AC10 | Killing the Executor mid-deploy ends in a terminal state or `UNKNOWN_TARGET_STATE`, with the lock released | Container kill |
| AC11 | A poison message goes to the DLQ and triggers the alarm | Malformed message |
| AC12 | No secrets in the image, definitions, requests or logs; no account ID, role ARN or host in public CI logs. *Refined by owner direction (2026-10-06, G-10): the CI role ARN and the AWS account ID are owner-accepted in CI logs (G-10, design DD-24 v4.7); hosts, IPs, credential IDs, credentials and secret values stay forbidden* | Scan + log review |
| AC13 | An operator reconstructs a deploy from the GitHub run, DynamoDB, CloudWatch and Slack | Runbook exercise |
| AC14 | Jenkins jobs are re-enabled and work after each window | Subsequent Jenkins run |
| AC15 | **Sender authorization:** a request from a role not bound to the `deploymentId` is `REJECTED`, audited and alarmed with no SSH; `pull_request`, `pull_request_target` and `workflow_run` runs, and a job outside the pinned reusable workflow, cannot assume the CI role or send a request | Negative tests |
| AC16 | **Digest only:** a request with a tag, image repository, host or any extra field is `REJECTED`; the target pulls `<trusted repository>@sha256:…` | Schema tests + target log |
| AC17 | **Late older build:** an older build that completes or is re-run after a newer deployment ends `SUPERSEDED` and is never deployed (ordering per OD-A1), including when the newer one ended `UNKNOWN_TARGET_STATE` or lost its lease | Ordered injection + rerun + forced unknown state and lease loss |
| AC18 | Duration and resource measurements (GitHub run, Executor) and cost comparison against §14.2 | Inc 7 report |

---

## 18. Recommendation: **GO WITH CONDITIONS**

Model B is viable for the PoC and is simpler than v2. Conditions are separated into gates.

| Gate | Conditions |
|---|---|
| **A: before resuming Executor code** (Inc 0–2) | (1) Approve this proposal v3. (2) Revised requirements, design and tasks. (3) Scoped Judgment Day `APPROVED` (AC-01 §16). (4) Owner approves the execution plan, including the fate of the frozen in-flight work. OD-A1 and OD-A2 resolved by the owner (2026-10-06): DD-27 and DD-25 approved. Nothing depends on AWS, the host or GitHub settings |
| **B: before deploying the Executor and infra in DEV** (Inc 3; infra only) | OD-Q11 (host, R2), OD-Q12 (credentials), OD-Q7 (IaC). DEV access in `<AWS_ACCOUNT_ID>`. Network spike green. Slack token. Authority to create the OIDC provider and CI role. OD-A9 (repo visibility **and organization plan**, design P-G7). OD-N1 for the platform repo CI task |
| **C: before the end-to-end deploy on `<PRMS_REPORTING_DEV_TARGET>`** (Inc 4–7) | OD-A6 approved; the GitHub Environment configured by a repo admin; the trust-policy IDs and SHA pin observed in a real token (design P-G10, P-G11); plan support (P-G7) re-checked (first real CI run, N-32). AC17 real re-run as E2E confirmation of P-A6. Job names and approval of the §12 procedure (Q1, Q3). OD-Q5 (target role without breaking leftover-key jobs). SSH credential (key preferred) and host key in Secrets Manager. Migration command and order confirmed (Q2). DEV DB snapshot |
| **D: before retiring Jenkins** (any job) | B2 complete (`jenkins-config-inventory`). OD-A3 and OD-A4 decided and non-SSH waves validated. Non-Docker builds proven in GitHub Actions per wave (B1). H1 (server-less migrations relocated via an exception mechanism). H2 (scripts inventoried and versioned). H3 (instance profiles; `<AWS_CREDENTIAL_REF>` rotation). Jira Builds API. Credentials migrated. OD-Q14. OD-N1. Each wave validated with Jenkins in parallel |

---

## 19. Next Step

**Recommended:** `/akili-specify changes/cicd-executor-poc` to revise requirements → design → tasks as one coherent change (AC-01 §10), followed by the scoped Judgment Day (AC-01 §16). Implementation stays paused until `JUDGMENT: APPROVED` and the owner approves the execution plan.

```text
/akili-specify changes/cicd-executor-poc
```

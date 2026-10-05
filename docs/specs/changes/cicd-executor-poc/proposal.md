# Proposal — CI/CD Executor PoC (Jenkins Replacement, PRMS Reporting DEV)

> **Verdict in one line:** the architecture (lightweight Executor in a Docker container on the **existing microservices server**, SQS Standard + DLQ, DynamoDB for state and locks, Lambda for quality, **CodeBuild per application and environment**, SSH to a versioned deploy script that runs the migrations on the target) **covers the PRMS Reporting DEV PoC with no fundamental blockers**. Recommendation: **GO WITH CONDITIONS**, with three distinct gates: writing code, deploying the PoC end-to-end, and retiring Jenkins (§17).

---

## 1. Document Control

| Field | Value |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Slug | `cicd-executor-poc`, derived from the free-text argument of the first invocation |
| Type | **Change** (new feature, greenfield) |
| Approval Mode | `gated` (the context requires a human gate, ctx §20) |
| Status | Draft **v2**: reviewed against the feasibility analysis. Pending approval |
| Date | 2026-10-05 |
| Owner | CI/CD Platform Team |
| Sources | **ctx** = `JENKINS_REPLACEMENT_AKILI_CONTEXT.md`; **FA** = `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md` (primary evidence); owner's architecture decisions (2026-10-05 review) |
| Parent Spec | none (family proposed in §16, not yet created) |
| Depends on | none |
| Parallel-safe | yes (with respect to `jenkins-config-inventory` and `cicd-security-remediation`) |

### 1.1 Evidence and how it is cited

- Workspace checked with `find . -type f`: `JENKINS_REPLACEMENT_AKILI_CONTEXT.md`, `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md` and this proposal. The Jenkinsfiles, the code of `<QUALITY_WORKER_FUNCTION>`, the buildspec of `<LEGACY_CODEBUILD_PROJECT>` and the Dockerfiles of `<PRMS_REPORTING_REPO>` are **not** in the workspace.
- The FA is a read-only analysis of the 152 pipeline files. It cites file and line (`L123`). It is taken as **primary evidence**. `VERIFIED (FA §x)` means the FA establishes it by citing the Jenkinsfile.
- `UNVERIFIED — confirm at source before relying on it` is used only where the FA says UNKNOWN or provides no evidence.

### 1.2 Change history

| Version | Change |
|---|---|
| v1 | Written without the FA. Fargate as the runtime, generic CodeBuild, new Lambda worker, SSM as an alternative |
| v2 | Validated against the FA. Runtime on the existing microservices server. CodeBuild per app+environment. `<QUALITY_WORKER_FUNCTION>` is reused. The Executor does not handle application secrets. Per-deploy-unit lock plus a *supersede* rule. Coexistence model with 8 Jenkins jobs. Security findings classified into 3 levels. Review of Q1–Q10. Three gates |

---

## 2. Intent

Determine, with a real PoC, whether the responsibilities of a pipeline representative of Jenkins can be replaced **without creating another permanent CI server and without turning the Executor into another Jenkins**.

Executor cycle: **receive → resolve definition → coordinate → dispatch → record → notify**.

This proposal covers the PoC (PRMS Reporting DEV) and the reusable contracts: definition schema, events, state, locks, and contracts for Lambda, CodeBuild, SSH, and the deploy script.

---

## 3. Problem / Current Behavior

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

1. Trigger PRMS Reporting DEV **without Jenkins** (manual trigger toward SQS and, as the last increment, a GitHub webhook).
2. Verify that the Executor only coordinates:
   - clones and packages **with no secrets**;
   - invokes `<QUALITY_WORKER_FUNCTION>` ×2 in parallel;
   - launches two builds in CodeBuild `prms-reporting-dev` (server and client);
   - receives the completions via EventBridge → SQS;
   - takes the deploy unit's lock;
   - connects via SSH to `<PRMS_REPORTING_DEV_TARGET>` and runs the versioned script, which migrates and deploys.
3. Reconstruct what happened using DynamoDB, the CloudWatch logs by `executionId`, and the Slack thread.
4. Verify that a duplicate event does not deploy twice, that two executions do not collide, and that **a failed migration leaves the previous version serving** (today it leaves it down, C10).
5. Keep Jenkins as the rollback: only its jobs pointing at the same target are temporarily disabled, during the test windows (§12).

---

## 5. Scope

### 5.1 In scope (PoC)

| Area | Includes |
|---|---|
| Contracts | `pipeline.schema.json` v1, Target Registry, event envelope, DynamoDB model, and contracts for Lambda, CodeBuild, SSH, and the deploy script |
| Executor | SQS consumer, state machine, planner (DAG by `needs` + `finally`), and `source`, `lambda`, `codebuild`, `ssh` (exec + sftp), `notify` capabilities. Plus LockService, reconciler, and structured logging |
| Ingress | Manual trigger (IAM-signed SQS message). GitHub webhook with Lambda HMAC in the last increment |
| Quality | **Existing** `<QUALITY_WORKER_FUNCTION>`, adapted to asynchronous invocation with Destinations |
| Build | CodeBuild `prms-reporting-dev` (new, covers server and client) with a versioned buildspec |
| Deploy | Generic versioned `deploy-container.sh` script, delivered via SFTP on each execution |
| DEV infra | Resources from §14.1 tagged `cicd-poc` |

### 5.2 Designed in the schema, not implemented in the PoC

`when`, typed parameters, per-execution timeouts, the `schedule` trigger, re-run, and the step types `lambda-deploy`, `s3-sync`, `cloudfront-invalidate`, `cloudformation`, `http-check`. They are reserved in the schema so later waves don't break it.

---

## 6. Non-Goals

| Non-goal | Reason |
|---|---|
| Retiring or modifying Jenkinsfiles | Jenkins is the rollback (ctx §21). Temporarily disabling jobs is not modifying them |
| Non-Docker builds (B1) in the PoC | PRMS V2 Reporting DEV builds both components **inside Docker** (FA §23). B1 is tested in a second PoC (§16) |
| Migrating SSH → SSM | Out of scope for the PoC by the owner's decision. Remains a future improvement |
| Having the Executor handle application secrets or connect to a DB | Build secrets are read by CodeBuild, and runtime and migration secrets are read by the target (§10.10) |
| Jira Builds API, Teams, email | Full replacement (§10.15) |
| Remediating all security debt | Parallel track (§13.2) |
| Expression language, loops, logic conditioned on an SSH command's return value | Signal of "another Jenkins" (FA §19 H5) |
| Web dashboard | Future |

---

## 7. Affected Users, Systems, And Specs

| Actor / System | Impact | Source |
|---|---|---|
| Existing microservices server | Hosts the `cicd-executor` container | Owner's decision. The host's exact identity is Q11 |
| `<PRMS_REPORTING_DEV_TARGET>` (credential `<SSH_CREDENTIAL_REF>`) | Target. Containers `<SERVER_CONTAINER>` (<SERVER_PORT_MAPPING>) and `<CLIENT_CONTAINER>` (<CLIENT_PORT_MAPPING>) | VERIFIED (FA §23, §11.1) |
| Repo `<PRMS_REPORTING_REPO>` (server + client monorepo) | Source for the PoC | VERIFIED (FA §23) |
| ECR `<ECR_REPOSITORY>` (server and client) | Image destination. Currently shared by up to 8 jobs | VERIFIED (FA §10.3) |
| Up to 8 Jenkins jobs on the same containers | Disabled during the test windows (§12) | VERIFIED the files (FA §10.3). Job names: `UNVERIFIED — confirm at source before relying on it` (B2) |
| `<QUALITY_WORKER_FUNCTION>` | Reused. Its asynchronous invocation configuration changes | VERIFIED (FA §23) |
| `<LEGACY_CODEBUILD_PROJECT>` | Not reused (fixed key, frontend only). Replaced by `prms-reporting-dev` | VERIFIED (FA §23 points 1 and 3) |
| PRMS Reporting DEV DB | Receives migrations from the target. **Shared by the Jenkins variants** (R9) | Inferred from FA §10.3; `UNVERIFIED — confirm at source before relying on it` |
| Slack `<SLACK_CHANNEL>` | Executor notifications | VERIFIED (FA §15) |

---

## 8. Visual Reference

- Source: None
- Location: n/a
- Notes: backend and infrastructure change with no UI. The dashboard is future work.

---

## 9. Requirement Delta Preview

### ADDED

- **R-DEF**: each pipeline is described in versioned YAML validated against a schema. The Executor does not infer flows and contains no `if project == X`.
- **R-ID**: `executionId = <pipelineId>-<sequence>` (e.g. `prms-reporting-dev-184`), with an atomic sequence per pipeline. Appears in state, logs, S3 keys, image tags, remote temporary files, and Slack.
- **R-QUEUE**: SQS Standard plus a DLQ, **at-least-once** delivery. Messages carry references, never artifacts.
- **R-IDEM**: reprocessing any event produces no effects.
- **R-LOCK**: a single active deploy per deploy unit. The *supersede* rule prevents deploying an older commit over a newer one.
- **R-PAR**: quality ∥ quality and build ∥ build. Fan-in advances exactly once.
- **R-MIG**: the migration runs on the target **before** stopping the old version. If it fails, the old version keeps serving.
- **R-ROLLBACK-READY**: `previousImageTag` is kept per deploy unit, and the previous image is not deleted until the new one is healthy.
- **R-NOSECRETS**: no secrets in ZIPs, S3 keys, the Executor's image, definitions, or logs.
- **R-RECON**: stuck executions and orphan locks close themselves.
- **R-OBS**: JSON logs with `executionId`, state in DynamoDB, and Slack with a link to logs.

### MODIFIED

- PRMS Reporting DEV deploy: Jenkins → Executor during validation.
- Deploy order on the target: today kill → pull → migrate → run (FA §16). Becomes pull → migrate → swap → health → cleanup.
- AWS credentials for the deploy on the target: leftover keys → instance profile (or equivalent mechanism, Q5).

### REMOVED

- None in the PoC.

---

## 10. Proposed design (preview; `design.md` formalizes it)

### 10.1 Architecture and boundaries

```text
Manual (aws sqs send-message / script) ─┐       GitHub webhook → Lambda ingress (HMAC) ─┐   (Inc 8)
                                        v                                               v
                              SQS cicd-events-dev (Standard) ── maxReceiveCount 5 ──> cicd-events-dev-dlq → alarm
                                        │   ▲            ▲                        ▲
                                        │   │ Lambda     │ EventBridge            │ EventBridge Scheduler
                                        │   │ Destinations│ (CodeBuild state)     │ (RECONCILE_TICK, 5 min)
                                        v   │            │
           ┌──────────── Existing microservices server ────────────┐
           │  cicd-executor container (Node.js/TS, CPU/mem limits) │
           │  receive → resolve → coordinate → dispatch → record → notify │
           └───────┬──────────────┬───────────────┬───────────────┬───────┘
                   │              │               │               │ SSH/SFTP
          S3 executions/{id}/   Lambda          CodeBuild         v
                   │         <QUALITY_WORKER_FUNCTION>  prms-reporting-dev   <PRMS_REPORTING_DEV_TARGET>
                   └── DynamoDB cicd-executions-dev (state, dedupe, locks, targets)
                       CloudWatch Logs · Slack · Secrets Manager / IAM
```

| Component | Does | Does not do |
|---|---|---|
| Executor | Consumes events, transitions state, decides the next step, clones and packages, uploads to S3, invokes Lambda, launches CodeBuild, does SSH and SFTP, manages locks, and notifies | `npm`/`mvn`/`docker build`, repo scripts, DB connections, reading application secrets, per-project logic |
| `<QUALITY_WORKER_FUNCTION>` | Lint and tests from a ZIP in S3 | Slack, DynamoDB |
| CodeBuild `prms-reporting-dev` | Reads DEV build secrets, `docker build`, push to ECR | Decide the flow |
| Target and script | Reads DEV runtime secrets, pull, migration, swap, health check, cleanup | Know the full pipeline |

### 10.2 Executor runtime: existing microservices server

**Decision:** `cicd-executor` Docker container on the existing microservices server. This avoids replacing the large Jenkins server with another permanent CI server.

The FA confirms that a small container is reasonable under four conditions (FA §17):

| Condition | How it is met |
|---|---|
| Never install dependencies or compile | The image does not include `npm`, `mvn`, or `docker`. This is reviewed as an acceptance criterion (AC2) |
| Bounded concurrency | Maximum N simultaneous source preparations (default 2) and M SSH sessions (default 4). The rest wait in the queue |
| Long event-driven waits | Asynchronous Lambda and CodeBuild via EventBridge. Only the deploy SSH keeps an open session |
| Disk for N × the largest clone | Dedicated `/work` volume. The size of `<PRMS_REPORTING_REPO>` is UNKNOWN (Q15) and is measured in Inc 3 |

Container configuration: limited `--memory` and `--cpus`, `restart=unless-stopped`, dedicated `/work` volume, non-root user, and **no** mounting of `docker.sock`.

**Required connectivity (outbound only; the Executor does not expose any orchestration ports):**

| Destination | Protocol / port | For what | Validation |
|---|---|---|---|
| SQS `cicd-events-dev` | HTTPS 443 | Receive and send events | Inc 2 |
| DynamoDB | 443 | State, locks, dedupe | Inc 2 |
| S3 `cicd-artifacts-dev` | 443 | Upload ZIPs (streaming multipart) | Inc 3 |
| Lambda API | 443 | `Invoke` (Event) | Inc 4 |
| CodeBuild API | 443 | `StartBuild`, `BatchGetBuilds` (the latter only in the reconciler) | Inc 5 |
| EventBridge | n/a | The Executor **does not** call it. EventBridge writes to SQS | — |
| Secrets Manager | 443 | SSH credential, GitHub token, Slack token | Inc 2 |
| CloudWatch Logs and metrics | 443 | Logs (`awslogs` driver or agent) and EMF metrics | Inc 2 |
| STS | 443 | Temporary credentials (per Q12) | Inc 2 |
| GitHub (`github.com`) | 443 | `git fetch` of the exact commit | Inc 3 |
| Slack (`slack.com`) | 443 | `chat.postMessage` | Inc 2 |
| `<PRMS_REPORTING_DEV_TARGET>` | **TCP 22** | Deploy SSH and SFTP | **Inc 0 (network spike)** |

If the server reaches the internet through a proxy, the AWS SDK, `git`, and the Slack client must be configured to use it. This is determined in Q11.

**Risks specific to this runtime** (detail in §15):

- The FA's microservices server (`<MICROSERVICES_PROD_HOST>`) is a **PROD host**. A job that runs `docker swarm leave --force` runs on it, a DEV monitoring job deploys there, and there are port conflicts (FA §10.3). If it is the same host, a DEV Executor would end up on a PROD host that Jenkins still modifies (R2).
- If the host is EC2, the instance profile is shared by all of the host's containers (R3, Q12).

### 10.3 SQS: topology, visibility, retries, retention

| Parameter | Proposed value | Reason |
|---|---|---|
| Type | **Standard** | Correctness comes from DynamoDB. FIFO deduplicates for only 5 minutes and does not cover consumer failures |
| Queues | `cicd-events-dev` and `cicd-events-dev-dlq` | One work queue is enough for CI/CD volume; `eventType` discriminates |
| Long polling | `WaitTimeSeconds=20` | Fewer empty requests |
| Visibility timeout | 120 s base. The handler **extends it every 60 s** (heartbeat) while it works: clone, SSH | A deploy SSH can take minutes; the heartbeat prevents a duplicate delivery while it's still alive |
| `maxReceiveCount` | 5 → DLQ | Poison messages or persistent errors |
| Retention | Main queue 4 days; DLQ 14 days | Time for manual redrive |
| Effect retry | Decided by the Executor based on state, not SQS (§10.13) | Avoids repeating destructive effects |
| Alarm | DLQ visible > 0, and age of the oldest message in the main queue > 10 min | Executor down or stuck |

**Envelope:**

```json
{
  "specVersion": 1,
  "eventId": "uuid",
  "eventType": "BUILD_COMPLETED",
  "executionId": "prms-reporting-dev-184",
  "pipelineId": "prms-reporting-dev",
  "environment": "dev",
  "stepId": "server-image",
  "status": "SUCCEEDED",
  "attempt": 1,
  "timestamp": "2026-10-05T15:04:05Z",
  "source": "executor|lambda|codebuild|ingress|scheduler",
  "payload": { "buildId": "prms-reporting-dev:…", "imageUri": "…" }
}
```

Events: `PIPELINE_REQUESTED`, `QUALITY_COMPLETED|FAILED|TIMED_OUT`, `BUILD_COMPLETED|FAILED|TIMED_OUT`, `DEPLOYMENT_COMPLETED|FAILED`, `PIPELINE_COMPLETED|FAILED`, `RECONCILE_TICK`. Native Lambda Destinations and EventBridge records are **normalized** to this envelope upon receipt.

### 10.4 Pipeline definitions and step vocabulary

**Minimal vocabulary derived from the FA** (§13, §21):

| Step type | Covers (FA patterns) | Phase |
|---|---|---|
| `source` (implicit) | R6, R14, R15: clone, ZIP, S3 | **PoC** |
| `lambda` | Quality (R16–R23), migration via VPC Lambda (R45), future *Lambda builder* (B1) | **PoC** |
| `codebuild` | Docker/ECR (R24–R26), ARM (R25), `sam --use-container` (R33), heavy builds | **PoC** |
| `ssh` (`exec` + `upload`) | P1, P2, P7: R36–R38, R41–R43, R47–R50 | **PoC** |
| `notify` (`slack` provider; later `jira-builds`, `teams`, `email`) | R62–R65 | **PoC** (Slack) |
| `lambda-deploy` | P4, P4b, P5: R56 (code, configuration, alias, and waiters) | Full |
| `s3-sync` (sync/delete semantics) | P3: R54 | Full |
| `cloudfront-invalidate` | R55 | Full |
| `cloudformation` (change set + waiter) | P6: R58 | Full |
| `http-check` | R52, R53 | Full |
| `apigateway-upsert`, `scheduler-upsert`, `ecr-ensure` | R57, R59, R29 (or better, move to IaC) | Full / evaluate |

Flow control is limited to `needs` (DAG, which provides parallelism), `finally` (always-run), declarative `when` (`param|branch == value`, no expressions), and `timeoutMinutes`. This covers the FA's only patterns: `parallel` (9), `when` (6), `timeout` (2), and `post`/`finally` (all).

**PRMS Reporting DEV example** (the `<…>` values depend on Q2):

```yaml
schemaVersion: 1
pipelineId: prms-reporting-dev
project: prms-reporting
environment: dev
repository:
  url: <github.com/…/<PRMS_REPORTING_REPO>>
  branch: <reference variant's branch>       # Q2
  credentialRef: <GITHUB_CREDENTIAL_REF>
triggers: [ { type: manual } ]                         # github-push in Inc 8
notifications: { slack: { channel: "<SLACK_CHANNEL>", tokenRef: <SLACK_TOKEN_REF> } }

source:
  packages:
    - { name: server, path: <server-dir> }
    - { name: client, path: <client-dir> }
  # .git, node_modules, and secret files (.env*, unversioned environment*.ts) are always excluded

steps:
  - id: server-quality
    type: lambda
    with: { function: <QUALITY_WORKER_FUNCTION>, task: backend-quality, package: server }
  - id: client-quality
    type: lambda
    with: { function: <QUALITY_WORKER_FUNCTION>, task: frontend-quality, package: client }

  - id: server-image
    type: codebuild
    needs: [server-quality]
    with: { project: prms-reporting-dev, package: server, env: { COMPONENT: server } }
  - id: client-image
    type: codebuild
    needs: [client-quality]
    with: { project: prms-reporting-dev, package: client, env: { COMPONENT: client } }

  - id: deploy
    type: ssh
    needs: [server-image, client-image]
    timeoutMinutes: 20
    with:
      target: prms-reporting-dev                       # Target Registry entry
      script: deploy-container.sh                      # versioned; delivered via SFTP
      args:
        - --execution-id=${execution.id}
        - --unit=prms-reporting-dev-unit
        - --image=server=${steps.server-image.outputs.imageUri}
        - --image=client=${steps.client-image.outputs.imageUri}
        - --run-migrations

finally:
  - { id: notify, type: notify }
```

**Target Registry** (`pipeline-definitions/targets/dev.yaml`). Separates the "where" from the "what":

```yaml
prms-reporting-dev:
  host: <<PRMS_REPORTING_DEV_TARGET>>
  user: <deploy user>
  credentialRef: <SSH_CREDENTIAL_REF>       # key (preferred) or password (temporary)
  hostKeyRef: <SSH_HOST_KEY_REF>  # mandatory
  lockKey: deployment#<PRMS_REPORTING_DEV_TARGET>#prms-reporting-dev-unit
  containers:
    - { name: <SERVER_CONTAINER>, ports: ["<SERVER_PORT_MAPPING>"], envSecretRef: <DEV server runtime secret> }
    - { name: <CLIENT_CONTAINER>, ports: ["<CLIENT_PORT_MAPPING>"] }
  migration: { component: server, check: "migration:check:ci", run: "migration:run" }   # Q2
```

The validator rejects duplicate ports or containers between targets on the same host. This addresses the FA's port conflicts (§10.3: 3002, 4700, 4040), which a lock would not resolve.

Interpolation: only from a closed allowlist (`${execution.*}`, `${steps.<id>.outputs.*}`).

### 10.5 CodeBuild: isolation by application and environment

**Decision:** one project per application or process **and** per environment (`prms-reporting-dev`, `prms-reporting-staging`, `prms-reporting-prod`). The definition explicitly maps its environment to its project.

| What it isolates | Why it matters here |
|---|---|
| IAM role | A single AWS account for everything (C12). Without per-environment roles, DEV could touch PROD, which is exactly `<AWS_CREDENTIAL_REF>`'s problem (C9) |
| Secrets | The DEV role only reads `dev/*` secrets |
| ECR | The DEV role only pushes to `<ECR_REPOSITORY>` |
| VPC, logs, cost | Separated per project |

Projects are not servers left running: you pay per build minute (§14.2). What is optimized is **unnecessary build minutes**, not the number of projects.

**Several projects within the same environment?** Per the FA, only when the *build environment* changes, not the component:

| Case | Separate project? | Evidence |
|---|---|---|
| Server and client of PRMS Reporting DEV | **No.** Same workload type (docker build/push), same permissions (ECR dev, dev secrets). One project, two parallel builds with `COMPONENT` as an override | FA §23 |
| ARM64 build (an AICCRA pipeline, `<JENKINS_JOB_ID>`) | Yes: requires a native ARM environment | FA §8.1 |
| Build that needs a VPC (e.g. TANZANIA migration via CodeBuild-in-VPC) | Yes, if that path is chosen | FA §20 |
| `sam build --use-container` | Not necessarily: same privileged mode as docker | FA §8.3 |

**Lambda vs CodeBuild policy:** Lambda is preferred if the workload fits reasonably and safely. Otherwise, the environment's CodeBuild. Applied to the evidence:

| Workload | Location | Basis |
|---|---|---|
| Node lint and tests | Lambda (`<QUALITY_WORKER_FUNCTION>`, already proven in PRMS reporting) | FA §6 R16–R19 |
| Tests that need a DB, Karma/Chrome, pnpm monorepos, Maven | Measure; CodeBuild if they don't fit | FA §19 H7 |
| `docker build`/push and ARM | CodeBuild (justified) | FA §8.1 |
| **Do not** reproduce "build test image + docker run" for quality | Lambda | FA §8.2 (53 files, cost savings) |
| Do not clone inside CodeBuild | Source = the execution's ZIP via `sourceLocationOverride` | FA §8.2 |
| Do not put deploy SDK calls or waits in the buildspec | Executor | FA §8.2 |
| Static and esbuild builds (B1) | *Lambda builder* preferred; the environment's CodeBuild as a measured fallback | FA §19 B1. **Out of scope for the PoC** |
| `sam build --use-container` | The environment's CodeBuild (short term) | FA §8.3 |
| Mirroring upstream images | ECR pull-through cache, not CodeBuild | FA §8.2 |

**`StartBuild` contract:** `projectName` (from the definition), `sourceTypeOverride=S3`, `sourceLocationOverride=executions/{id}/source/{package}.zip`, env `EXECUTION_ID, STEP_ID, IMAGE_TAG, COMPONENT`, and `idempotencyToken = dispatchToken`.

**Buildspec:** versioned in the platform repo and associated with the project (it does not travel in the ZIP). Its flow:

1. Reads the DEV build secrets from Secrets Manager.
2. Writes `environment.ts` or `.env` **inside the build container**.
3. Runs `docker build`; with BuildKit secrets if `.dockerignore` allows it.
4. Pushes the unique tag and emits `imageUri` and `digest`.

**Completion:** EventBridge rule `CodeBuild Build State Change` (`SUCCEEDED|FAILED|STOPPED|TIMED_OUT`, filtered by project) → SQS. Correlated by `buildId` and `EXECUTION_ID`. No polling (FA §5.4 R35 notes that the current PoC polls with no timeout).

### 10.6 Lambda: contract

- `<QUALITY_WORKER_FUNCTION>` is **reused** with its output contract (`status, failedCommand, exitCode, error, logS3Uri, logUrl`; FA §21.7).
- Invocation change: synchronous (today it waits up to 900 s) → `InvocationType=Event`, `MaximumRetryAttempts=0`, and Destinations `onSuccess`/`onFailure` → `cicd-events-dev`. This keeps the Executor from being blocked.
- Result classification:
  - `status=FAILED` → `QUALITY_FAILED` (business-level);
  - function error → `QUALITY_FAILED` (`errorClass=INFRA`);
  - timeout → `QUALITY_TIMED_OUT` (not `FAILED`, per FA §16).
- The worker's input format and whether it accepts asynchronous invocation without code changes are `UNVERIFIED — confirm at source before relying on it` (Q2). Plan B: a thin Lambda wrapper that invokes the worker synchronously and publishes to SQS.

### 10.7 Source preparation and S3

Validated by the FA (§7.2): the clone and the ZIP belong to the Executor, with these constraints.

```text
git fetch --depth 1 <exact sha>   (short-lived token from <GITHUB_CREDENTIAL_REF>)
→ /work/{executionId}/
→ ZIP per package, excluding .git, node_modules, and secret files
→ streaming (multipart) upload to s3://cicd-artifacts-dev/executions/{executionId}/source/{package}.zip
→ rm -rf /work/{executionId} in finally
→ on startup, sweep of orphan /work/*
```

- **No second clone** for `getLastCommitInfo` (FA §5.2 R7): the SHA comes from the first fetch.
- **New bucket** `cicd-artifacts-dev`. `<LEGACY_POC_BUCKET>` is not reused, since it contains prod secrets (C9).

| Prefix | Lifecycle |
|---|---|
| `executions/{id}/source/` | Explicit deletion when finished (success or failure) **and** expiration at **7 days** as a safety net |
| `executions/{id}/quality/` (logs and reports) | Expiration at **30 days** (troubleshooting) |
| Incomplete multipart | Abort at 1 day |

SSE enabled, Block Public Access, and a bucket policy limited to the PoC's roles.

### 10.8 SSH: the PoC's deploy mechanism

- `ssh2` library (exec + SFTP). **Pinned host key mandatory** (currently disabled in all pipelines, FA §11.1).
- Authentication: **key** preferred. Password (credential `<SSH_CREDENTIAL_REF>`) only as a temporary, explicit fallback in the Target Registry, because the FA considers it acceptable for the PoC (§23.5).
- The credential is read from Secrets Manager on each execution, kept **in memory only**, and never goes to disk, the image, or logs.
- The Executor knows only: `target`, `script`, `args`, `timeout`, and `executionId`.
- **Script delivery:** the Executor uploads via SFTP the pinned version of the script, from the platform repo, to `/tmp/cicd-{executionId}/deploy-container.sh`. It runs it with escaped args (no shell interpolation), records its checksum, and deletes it at the end. This way the reviewed version always runs and nothing needs to be preinstalled (alternative: preinstall at `/opt/deploy`, §11).
- `exitCode`, the tail of stdout/stderr (to CloudWatch), and a final `CICD_RESULT {json}` line are captured.

### 10.9 Deploy scripts: inventory and what the PoC needs

| Current pattern | Examples (FA) | Treatment |
|---|---|---|
| Inline `sshCommand` commands in the Jenkinsfile | ~57 P1 pipelines, **including PRMS V2 Reporting DEV** | Consolidated into a generic versioned `deploy-container.sh` (FA §25.6) |
| Scripts resident on hosts | Various `<HOST_SCRIPT_PATH>` (names in the local inventory) | Inventoried in `jenkins-config-inventory`. **Do not affect the PoC** |
| Scripts as Secrets Manager values | `<SECRET_STORED_SCRIPT>` (one application family) | Move to Git. **Do not affect the PoC** |
| Scripts in application repos | `scripts/deploy-ecr.sh`, `deploy-api.sh`, `migrate-remote.sh`, `deploy-web.sh` | Require a runtime with a toolchain (§15.1). **Do not affect the PoC** |

**For PRMS Reporting DEV:** there is no resident script. The deploy is inline in the reference Jenkinsfile (FA §23): kill/rm, ECR login, pull, conditional migrations, `docker run` of both containers, and deletion of the remote `.env` in `finally`. The PoC needs **a single new script**, `deploy-container.sh`, written during execution (not now).

### 10.10 Secrets and credentials: who reads what

| Secret | Today | In the PoC |
|---|---|---|
| Frontend build secrets (`environment*.ts`) | Jenkins writes them into the tree and they end up in ZIPs and images | **CodeBuild `prms-reporting-dev`** reads them (DEV role) inside the build |
| Server runtime and migration `.env` | The target reads them with leftover keys from `aws configure set` | **The target** reads them with its instance profile and writes them to `/tmp/deploy-{executionId}.env` (0600). Deleted in `finally` **on the target** |
| Quality test secrets | Go inside the ZIP (prod secrets in the current PoC) | ZIP **with no secrets**. If the tests need them (Q13), the worker reads them by ARN with a DEV read-only role |
| SSH credential | Jenkins (`<SSH_CREDENTIAL_REF>`) | Secrets Manager `<SSH_CREDENTIAL_REF>`, memory only |
| GitHub token | Repos cloned anonymously or with an UNKNOWN global credential | `<GITHUB_CREDENTIAL_REF>` (GitHub App, preferred, or a read-only PAT) |
| Slack | `<SLACK_TOKEN_REF>` | `<SLACK_TOKEN_REF>` |
| Executor's AWS credentials | `<AWS_CREDENTIAL_REF>` (reads prod) | Dedicated `cicd-executor-dev` role, DEV only, mechanism per Q12 |

**The Executor never sees application secrets.** This reduces its blast radius, the FA's main security concern (§12.3).

**Trap on the target:** if an instance profile is added but the SSH user keeps `~/.aws/credentials` with leftover keys, the AWS CLI **prioritizes the static keys**. The script must force the role chain (e.g. `AWS_SHARED_CREDENTIALS_FILE=/dev/null`) or a dedicated deploy user with no `~/.aws` must be used. In the PoC, existing keys **are not deleted**, because other jobs depend on them (C7, H3).

### 10.11 Migrations on the target

| Variant in the FA | Does it fit the "target executes" model? |
|---|---|
| Conditional `migration:check:ci → migration:run` on the target (PRMS reporting family, including the PoC) | **Yes** |
| Unconditional on the target (ALLIANCE-INDICATORS, CLARISA v2) | **Yes** |
| From the Jenkins host toward the DB (PRMS reporting prod and prod-serverless) | Yes, by moving it into the target's script |
| From the Jenkins host toward RDS (TANZANIA, serverless, **no target server**) | **No.** Needs a `lambda` step toward a VPC Lambda (RISK pattern) or CodeBuild in a VPC |
| Via Lambda (RISK) | Yes (`lambda` step) |

**Order in `deploy-container.sh`** (fixes C10):

1. Log in to ECR with the host's role and pull the new images.
2. Read the runtime secret → `/tmp/deploy-{executionId}.env`.
3. `docker run --rm --env-file … <new server image> npm run migration:check:ci`. If there are pending ones, `migration:run`. **If it fails: exit 20; the old containers stay up.**
4. Swap: stop the old container, start the new one with the same name and ports.
5. Health check. If it fails: restore `previousImageTag` and exit 40.
6. Cleanup: delete the temporary `.env` and images older than `previous`. **Never** `rmi` the previous image.

| Exit | Meaning | Previous state preserved |
|---|---|---|
| 0 | OK | n/a |
| 10 | Login or pull failed | Yes |
| 20 | **Migration failed** | Yes (the DB may end up partially migrated if the migration is not transactional) |
| 30 | Startup failed; the previous image was restored | Yes (after restoring) |
| 40 | Health check failed; the previous image was restored | Yes (after restoring) |
| other / lost session | Unknown | `UNKNOWN_TARGET_STATE` (manual review) |

Requirement: migrations must be **backward compatible**, because the old version runs on the new schema between steps 3 and 4. The current exact mechanism (whether it migrates inside the running container or with an ephemeral container) is `UNVERIFIED — confirm at source before relying on it` (Q2).

### 10.12 DynamoDB: state

Table `cicd-executions-dev`, on-demand, TTL `expiresAt`. Incorporates the fields that FA §9.2 asks to add.

| PK | SK | Content |
|---|---|---|
| `EXEC#<executionId>` | `META` | `pipelineId, definitionRef (sha), project, environment, repository, branch, commit, sequence, trigger, triggeredBy, parameters, status, version, targets[], lockIds[], artifacts[], slackTs, startedAt, finishedAt, error{code,message,stepId}` |
| `EXEC#<executionId>` | `STEP#<stepId>` | `status, attempt, dispatchToken, externalRef (requestId / buildId / SSH session), logUrl, outputs{imageUri, digest…}, migrationsApplied, deadlineAt, startedAt, finishedAt, error` |
| `PIPELINE#<pipelineId>` | `SEQ` | Atomic counter → `executionId` |
| `TARGET#<lockKey>` | `STATE` | `currentImageTags, previousImageTags, lastDeployedSequence, lastExecutionId` |
| `LOCK#<lockKey>` | `LOCK` | See §10.14 |
| `DEDUPE#<key>` | `DEDUPE` | Ingress dedupe (TTL 7 days) |

Indexes: GSI1 `pipelineId + startedAt` (history) and sparse GSI2 `activeStatus + deadlineAt` (reconciler).

```text
Execution: QUEUED → RUNNING → SUCCEEDED | FAILED | TIMED_OUT | CANCELLED     (immutable terminals)
Step:      PENDING → DISPATCHING → RUNNING → SUCCEEDED | FAILED | TIMED_OUT
           PENDING → SKIPPED (failed dependency, `when` false, or SUPERSEDED)
           PENDING → WAITING_LOCK → DISPATCHING
```

Every state change is a conditional `UpdateItem` on `status` and `version`. There is no global `currentStep`: with parallelism, several steps are in progress.

Compatibility with `<JENKINS_EXECUTIONS_TABLE>`: the FA does not know whether anyone consumes that table (§14). In the PoC, it **is not written to**, unless Q14 reveals consumers.

### 10.13 Idempotency

| Layer | Mechanism |
|---|---|
| Ingress | Conditional `DEDUPE#<X-GitHub-Delivery | manual requestId>`: one request produces one execution |
| Consumption | Every effect is a conditional transition. If the condition fails, it was already processed: ack with no effects |
| Dispatch | *Intent-then-act*: `DISPATCHING + dispatchToken` is written **before** calling AWS. CodeBuild uses `idempotencyToken`. Quality in Lambda is read-only (repeating it is harmless) |
| Fan-in | `deploy` moves from `PENDING` to `DISPATCHING` with a conditional write: a single winner |
| Deploy | Lock + step state + idempotent script for the same image |
| Tags | `{pipelineId}-{sequence}` (e.g. `prms-reporting-dev-184`) with OCI labels `commit` and `executionId`. Does not collide with Jenkins's integer tags in the same ECR repo |

Duplicate `BUILD_COMPLETED` → the step is already `SUCCEEDED` → no-op. `deploy` is already `DISPATCHING` or further along → it is not dispatched again. **No second migration and no second `docker run`.**

### 10.14 Deploy locks

| Aspect | Design |
|---|---|
| Key | The Target Registry's `lockKey` = **deploy unit on a host** (`deployment#<PRMS_REPORTING_DEV_TARGET>#prms-reporting-dev-unit`). Covers both containers. Not based on the project name, because 8 jobs from different projects and branches share the unit |
| Acquisition | Conditional `PutItem`: `attribute_not_exists(PK) OR leaseExpiresAt < :now`. Stores `owner=executionId`, `fencingToken`, `leaseExpiresAt = now + step timeout + margin`, and `expiresAt` (TTL) |
| Ownership | Renewing and releasing are conditional on `owner = :executionId` |
| Renewal | Heartbeat every 60 s while the SSH lasts |
| Release | On success, failure, or `finally` |
| Busy | `WAITING_LOCK`, requeues with backoff, and fails with `LOCK_TIMEOUT` after 30 min |
| TTL | Cleanup only (DynamoDB can take up to ~48 h to delete). **Exclusion is decided by `leaseExpiresAt`** |
| Orphan | The lease simply expires. The reconciler marks the owning execution as `TIMED_OUT` and notifies |
| **Supersede** | With the lock taken, if `TARGET.lastDeployedSequence > my sequence`, the step moves to `SKIPPED (SUPERSEDED)`. Prevents deploying an old commit over a new one when two executions compete |
| Host locks (future) | For destructive host-level operations (`swarm leave`, P7) and builds on the server (P2): host-scoped `lockKey` |

### 10.15 Notifications

- `NotificationService` with a `notify(event, execution)` interface and pluggable providers. PoC: `SlackProvider` (Web API `chat.postMessage` with a bot token and a thread per execution). Later: `JiraBuildsProvider` (87 pipelines), `TeamsProvider`, and `EmailProvider` (SES).
- Lambda and CodeBuild know nothing about Slack: they report to SQS and the Executor notifies.
- Notified events: start, quality failure, build failure, deploy failure (including `UNKNOWN_TARGET_STATE`), success, lock timeout. Each with `executionId`, commit, and a link to logs (deep link to Logs Insights or the worker's `logUrl`).
- **Best-effort:** a notification failure never fails the pipeline. That is already the case today (FA §15).

| Integration | Classification |
|---|---|
| Slack | PoC |
| Jira Builds API | Full replacement (without it, Jira visibility for 87 pipelines is lost) |
| Teams (1), email (1, legacy) | Full replacement or retirement |

### 10.16 Observability

JSON logs (`executionId, pipelineId, stepId, eventType, attempt`) from the Executor, the worker, and CodeBuild, filterable by `executionId`. Saved query "execution timeline". EMF metrics: executions, duration per step, and lock wait. Alarms: DLQ > 0, execution alive past its deadline, and Executor with no heartbeat. This is the FA §15 "minimum observability".

### 10.17 Failure behavior

| Failure | Expected behavior |
|---|---|
| Git clone fails | 2 retries with backoff inside the handler. Then `FAILED (SOURCE_CLONE)`, Slack, cleanup of `/work/{id}` |
| Source preparation fails (disk, ZIP) | `FAILED (SOURCE_PREP)`, cleanup. If it's a disk issue, metric and alarm |
| S3 upload fails | SDK retries and 1 step retry. Then `FAILED`. Partial objects are removed by the lifecycle |
| Lambda fails (function error) | `QUALITY_FAILED (INFRA)`. 1 automatic re-dispatch (`attempt+1`) |
| Quality fails (red lint/test) | `QUALITY_FAILED`, no retry. Dependents move to `SKIPPED` and `finally` runs |
| Lambda timeout | `QUALITY_TIMED_OUT` (distinct from FAILED). No automatic retry |
| CodeBuild fails | `BUILD_FAILED` with a link to the build log. No retry. If `StartBuild` (API) failed, 1 re-dispatch |
| Docker/ECR push fails | Occurs inside the build → `BUILD_FAILED` |
| SQS redelivery | No-op via conditional transition (§10.13) |
| SSH connection fails | Up to 2 retries **before** executing the script. Then `DEPLOYMENT_FAILED`. The lock is released |
| Migration fails | Exit 20 → `DEPLOYMENT_FAILED (MIGRATION)`. The old version keeps serving. No automatic retry |
| Deploy script fails | Exit ≠ 0 → `DEPLOYMENT_FAILED` with the code and log tail. No automatic retry |
| Health check fails | Exit 40: the script restored the previous image → `DEPLOYMENT_FAILED (HEALTH)` |
| Slack fails | The error is logged; the pipeline continues |
| The Executor restarts | The state is in DynamoDB. Unacknowledged messages reappear after the visibility timeout and are reprocessed idempotently. `/work` is swept on startup. An interrupted SSH leaves the lease unrenewed → the reconciler resolves it |
| Stuck execution | The reconciler (every 5 min) looks for `deadlineAt < now`. For CodeBuild it queries `BatchGetBuilds` and recovers the lost event. For the rest it marks `TIMED_OUT`, runs `finally`, and notifies |
| Orphan lock | Expires via its lease. The reconciler closes the owning execution. If the SSH session was cut mid-script → `UNKNOWN_TARGET_STATE` and manual verification with a runbook |
| Poison message | 5 receptions → DLQ → alarm → manual redrive after fixing |

### 10.18 Concurrency

| Scenario (FA §10) | Control |
|---|---|
| Quality and server/client builds | Parallel via DAG; conditional fan-in |
| Two executions of the same pipeline | Both build (distinct artifacts and tags). The deploy is serialized by the lock and *supersede* prevents regressions |
| S3 or workspace collision | `executions/{id}/` and `/work/{id}/` |
| Remote temporary file collision | `/tmp/deploy-{executionId}.env` and `/tmp/cicd-{executionId}/` |
| Port conflicts between different containers | Target Registry validation (a lock does not resolve this) |
| **Executor vs Jenkins** | **Not covered by the lock** → operational procedure (§12) |
| **DEV DB shared across different branch variants** | **Not covered by the lock**: migrations from another branch can alter the schema the PoC uses → R9 |

---

## 11. Approach Options

| Option | Status | Notes |
|---|---|---|
| **A. Lightweight Executor + SQS + DynamoDB on the existing microservices server** | **Selected** | Validate precisely whether a lightweight Executor is enough |
| A'. Same Executor on ECS Fargate | Alternative | Isolates from the shared host (R2, R3) in exchange for a small fixed cost. Plan B if Q11 or Q12 are not resolved well |
| B. AWS Step Functions | Alternative, not selected | See the warning signs below |
| C. GitHub Actions + OIDC | Alternative, not selected | Not the architecture being evaluated |
| Script delivery variant: preinstalled at `/opt/deploy` | Alternative | Simpler, but can drift from Git. Delivering it via SFTP on each execution is preferred |

**Warning signs for reconsidering Step Functions** (FA §19 H5, §24.7):

- Complex or nested conditional branching appears, beyond a simple `when`.
- Sub-workflows, reusing pipelines inside pipelines, or retry graphs are requested.
- Expressions, loops, or a growing DSL are needed in the definitions.
- There are long waits (CloudFormation of ~20 min or more, approvals) that the Executor must sustain.
- The planner or the reconciler grow beyond a small module, or project-specific logic appears.
- Per-step retries with different policies or compensations (sagas) are requested.

If two or more of these signs appear, Step Functions is reevaluated before extending the Executor further.

## 12. Recommended Approach and coexistence with Jenkins

**Option A.** The Executor stays within the vocabulary from §10.4, project logic lives in definitions and versioned scripts, and the heavy lifting goes to Lambda or CodeBuild.

**Coexistence with Jenkins during the PoC.** Up to 8 jobs deploy `<SERVER_CONTAINER>` and `<CLIENT_CONTAINER>` on `<PRMS_REPORTING_DEV_TARGET>` (FA §10.3):

- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`
- `<JENKINS_JOB_ID>`

Plus whatever the inventory reveals. Procedure for each **deploy test window** (Inc 6 onward):

1. Announce the window in the PRMS team's channel.
2. Confirm in Jenkins that none of those jobs have builds in progress.
3. **Disable** those jobs ("Disable Project", reversible and without touching Jenkinsfiles). Requires knowing the job names (Q1 / B2) and the Jenkins owner's approval.
4. Run the PoC's tests.
5. Re-enable the jobs and keep a record (who, when, executions) in `docs/specs/changes/cicd-executor-poc/`.

Jenkins is not shut down globally. Alternative for early iterations: deploy to the PoC's own containers and ports, with no conflict with Jenkins. They share the DEV DB (R9), so that alternative **does not replace** testing on the real target.

---

## 13. FA security findings, classified

### 13.1 Required for the PoC's security

| Measure | FA finding |
|---|---|
| Quality and source ZIPs **with no secrets** and a new `cicd-artifacts-dev` bucket | §12.2.3, H6 |
| S3 keys and tags scoped to the execution; do not use `codebuild/frontend.zip` | §10.2 |
| Dedicated DEV AWS role for the Executor and per CodeBuild project. **Never** `<AWS_CREDENTIAL_REF>` | §12.1, §12.2.2 |
| The Executor does not run `aws configure set`; the target uses its own role (with the §10.10 trap) | §12.2.1, H3 |
| Pinned host key in SSH | §12.2.6 |
| SSH credential in Secrets Manager, memory only, and redacted in logs | §12.3 |
| Remote temporary `.env` with a unique name and 0600, deleted **on the target** | §11.4, §12.2.8 |
| Executor credential mechanism on the shared host with no exposure to other containers (Q12) | §12.3 |
| Webhook HMAC (if enabled) | §12.3 |

### 13.2 Parallel remediation (`cicd-security-remediation`, does not block the PoC)

Rotate `<AWS_CREDENTIAL_REF>` and separate IAM for prod and non-prod. Stop `aws configure set` and put instance profiles on every host. Remove prod secrets from `s3://<LEGACY_POC_BUCKET>` and from the staging jobs. Retire the image published in a public registry with a prod secret. Stop publishing `.git` on the affected static site. Migrate SSH password → key in the 44 files and enable host keys. Fix the `finally` blocks that run on the wrong host. Move plaintext secrets in Lambda environment variables to Secrets Manager. Change the default credentials of the affected monitoring service.

### 13.3 Longer-term cleanup

Shell injection in `getLastCommitInfo` (disappears with Jenkins). Unauthenticated JMX in a Java service. `sudo -S` with a password. `chmod 777` on secrets directories. Guards for `docker swarm leave --force`. Growth of Lambda permission policies. Relocate `RECORDS/BRANCH`.

---

## 14. Resources, cost, plan, files

### 14.1 PoC resources (DEV, account `<AWS_ACCOUNT_ID>`, `<AWS_REGION>`)

| Resource | Name |
|---|---|
| SQS Standard + DLQ | `cicd-events-dev`, `cicd-events-dev-dlq` |
| DynamoDB | `cicd-executions-dev` |
| S3 | `cicd-artifacts-dev` (lifecycle §10.7) |
| ECR | `cicd-executor` (Executor image). The **existing** `<ECR_REPOSITORY>` repos are reused |
| CodeBuild | `prms-reporting-dev` (new, privileged) and its service role |
| Lambda | Existing `<QUALITY_WORKER_FUNCTION>`: async configuration and Destinations (or a DEV copy if the original must not be touched) |
| Lambda (Inc 8) | `cicd-github-ingress-dev` + Function URL |
| EventBridge | Rule `cicd-codebuild-state-dev` → SQS; Scheduler `cicd-reconcile-dev` |
| Secrets Manager | `<SSH_CREDENTIAL_REF>` (+ host key), `<GITHUB_CREDENTIAL_REF>`, `<SLACK_TOKEN_REF>` (+ `<WEBHOOK_SECRET_REF>` in Inc 8) |
| IAM | `cicd-executor-dev`, `prms-reporting-dev`'s service role, Destinations role, and ingress role |
| CloudWatch | Log groups (30 days), alarms, saved queries |
| Microservices server | `cicd-executor` container, `/work` volume, credentials per Q12 |
| `<PRMS_REPORTING_DEV_TARGET>` | Instance profile (ECR pull of `<ECR_REPOSITORY>` and reading the DEV runtime secret), deploy user, and authorized key (or temporary password) |

### 14.2 Cost categories

| Category | Nature | Expectation |
|---|---|---|
| Executor | Marginal: runs on an existing server | No new fixed compute cost (v1's Fargate and NAT removed) |
| CodeBuild | Per build minute, **no cost for an idle project** | Main variable cost. Reduced with layer caching, a single build per image, and no quality in CodeBuild |
| Lambda | GB-s per quality run | Low |
| SQS, DynamoDB on-demand, EventBridge | Per request | Immaterial |
| S3 | GB-month | Low with lifecycle |
| Secrets Manager, CloudWatch Logs | Per secret / GB | Low; watch the build log volume |

### 14.3 Plan by increments

| Inc | Delivers | Requires |
|---|---|---|
| 0 | `/akili-specify` approved. Schema and validator, Target Registry, PoC definition. **Network spike** from the microservices server (443 to AWS, GitHub, and Slack; 22 to `<PRMS_REPORTING_DEV_TARGET>`) | Gate A |
| 1 | Pure domain: state machine, planner, idempotency, LockService, *supersede*. Tests with DynamoDB Local | Gate A |
| 2 | Base DEV infra and the Executor container on the server. Manual no-op pipeline → Slack. Poison message → DLQ | Gate B |
| 3 | `source`: clone, ZIP with no secrets, S3. Measurement of `<PRMS_REPORTING_REPO>`'s size | Gate B |
| 4 | `<QUALITY_WORKER_FUNCTION>` async + Destinations; parallel quality | Gate B + Q2/Q13 |
| 5 | CodeBuild `prms-reporting-dev` + EventBridge; two images with unique tags | Gate B + Q2 |
| 6 | SSH + lock + `deploy-container.sh` + migration on `<PRMS_REPORTING_DEV_TARGET>`, in a window with Jenkins disabled | **Gate C** |
| 7 | Reconciler, timeouts, and failure tests (kill the Executor, broken migration, duplicates) | Gate C |
| 8 | GitHub webhook, acceptance E2E, and measurement/cost report vs. the proposal | Gate C |

### 14.4 Files expected to be created during execution (not now)

```text
cicd-platform/
  executor/src/{main.ts, consumer/, domain/{state-machine,planner,events}.ts,
                handlers/{source,lambda,codebuild,ssh,notify}-step-handler.ts,
                services/{pipeline-definition,execution,state,lock,notification,git,message-queue}.service.ts,
                adapters/{dynamodb,s3,secrets,sqs}/, observability/}
  executor/test/   executor/Dockerfile   executor/docker-compose.yml (deployment on the server)
  ingress/github-webhook/
  buildspecs/prms-reporting-dev.yml
  pipeline-definitions/prms/reporting-dev.yaml
  pipeline-definitions/targets/dev.yaml
  schemas/{pipeline,targets,event}.schema.json
  deploy-scripts/deploy-container.sh
  infra/            (IaC tool: Q7)
  docs/{runbook,resources,jenkins-coexistence-log}.md
docs/specs/changes/cicd-executor-poc/{requirements,design,tasks}.md
```

Jenkinsfiles, application code (`<PRMS_REPORTING_REPO>`), and the previous PoC's Lambda or CodeBuild are not modified, except for the worker's invocation configuration (§10.6).

---

## 15. Validation against the 152 pipelines, risks, and questions

### 15.1 What the architecture covers and what it does not

| FA pattern | ≈# | Fits? | What's missing |
|---|---:|---|---|
| P1 Docker → ECR → SSH | 57 | **Yes** (this is the PoC) | Generic script; password-to-key migration |
| P2 SSH + script on host or build on the server | 18 | Yes, structurally | Script content UNKNOWN (H2). Jenkins workspace reads → secret re-read from the execution |
| P3 static build → S3 → CloudFront | 8 (+~10) | **Partial** | B1 (build runtime) + `s3-sync` and `cloudfront-invalidate` steps |
| P4 Lambda image | 6 (+2) | Yes | `lambda-deploy` step (+ API GW and Scheduler or IaC) |
| P4b Lambda via SSH (credential proxy) | 9 | Yes, better without SSH | `lambda-deploy` |
| P5 Lambda ZIP | 8 | **Partial** | B1 (esbuild → *Lambda builder*) + `lambda-deploy` |
| P6 SAM / CloudFormation / repo scripts | 15 | **Not covered today** | `sam --use-container` in the environment's CodeBuild. Repo scripts with a toolchain: **no runtime decided** |
| P7 Swarm | 4 | Yes via SSH | Host-scoped lock and a guard for destructive operations |
| P8 CI only | 22 | Yes | Lambda (and CodeBuild if there's a push) |
| P9 utilities | 3 | Outside the Executor | `RECORDS/BRANCH` → Lambda or a scheduled task |

**What the design still cannot represent or resolve:**

1. **Runtime for non-Docker builds (B1, ~45 pipelines).** The policy is decided (Lambda builder preferred, the environment's CodeBuild as a fallback), but it is **not tested**. It blocks retiring Jenkins, not the PoC.
2. **Application repo scripts that need a toolchain** (`deploy-ecr.sh`, `deploy-api.sh`, `infra/scripts/*`, `npm run deploy:staging`; RISK, TANZANIA, IBD, and MARLO landing). They only fit as "run a script in the environment's CodeBuild", which turns CodeBuild into a *script runner* with deploy permissions. Requires an explicit decision in the corresponding wave.
3. **Groovy control logic** that must not be ported to the Executor and has to go into scripts:
   - flow driven by `sshCommand`'s return value (two AICCRA and Swarm pipelines, `<JENKINS_JOB_ID>`);
   - *branch-tip gating* with `git rev-list` (MONITORING);
   - secret transformations with python/jq (IA ai-insights, MARLO-V2 dev-lambda);
   - `sed` over the source (INNOVATION-CATALOG);
   - patching `package.json`/`tsconfig` and overwriting the Dockerfile (PRMS V2 reporting variants).

   If the corresponding wave tries to put this into the Executor, that is the "another Jenkins" signal. Secret-to-Lambda-environment-variable transformations can be expressed generically in `lambda-deploy` (`environmentFromSecret` with include/exclude) with no per-project code.
4. **CloudFormation change set run manually** (`<JENKINS_JOB_ID>`): there is no approval step. It stays manual, or an `approval` step is decided, which Jenkins does not use today.
5. **Migrations with no target server** (TANZANIA against RDS): require a VPC Lambda or CodeBuild in a VPC. They fit the vocabulary (`lambda`/`codebuild`), but they have to be built.

**Jenkins functions with no complete replacement:**

- History, console, and replay UI: partial (CloudWatch + DynamoDB; re-run is a full replacement).
- Coverage trend charts: lost.
- Jira plugin (87 pipelines): needs the Builds API.
- Credential store: migrated to Secrets Manager credential by credential.
- Job configuration: B2.

**Concurrency that `executionId` + lock do not resolve:**

- Executor vs Jenkins (§12 procedure).
- DEV DB shared across different branch variants (R9).
- Port conflicts between different containers (registry validation).
- Destructive host-level operations (host lock, future).
- Deploy disorder (*supersede*, included).

**External dependencies not yet available:**

- Job names, triggers, and concurrency (B2).
- `<QUALITY_WORKER_FUNCTION>`'s code and input format.
- The previous PoC's buildspec.
- Dockerfiles and `.dockerignore` of `<PRMS_REPORTING_REPO>`.
- Exact migration commands and their order.
- The repo's size.
- Source of the `db-operations` library.
- Consumers of `<JENKINS_EXECUTIONS_TABLE>`.
- Configuration of the Jira, Slack, and Sonar plugins.

**Network to validate before implementing the deploy:** microservices server → `<PRMS_REPORTING_DEV_TARGET>:22`, and → AWS, GitHub, and Slack over 443. `<PRMS_REPORTING_DEV_TARGET>` → ECR, Secrets Manager, and DEV DB (today it works with Jenkins, but under a different identity).

**Genuine blocker for the PoC:** none fundamental. Risks R1–R3 may force a change of the Executor's host (to A'), not the architecture.

### 15.2 Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Jenkins and the Executor deploy to the same target | §12 procedure; job names via the inventory |
| R2 | The "microservices server" is the **PROD host** (`<MICROSERVICES_PROD_HOST>`), where Jenkins runs `swarm leave --force` and deploys a DEV monitoring job; a DEV Executor there mixes environments | Confirm the host (Q11). If it's PROD: evaluate another host or A'. At minimum, a container outside Swarm and excluded from the destructive jobs |
| R3 | The Executor's AWS credentials on a shared host end up accessible to other containers (instance profile via IMDS) | Q12: dedicated role with minimum DEV privilege. IMDSv2 with hop limit 1 and credentials delivered only to the container (Roles Anywhere or a `credential_process` profile). Never long-lived static keys |
| R4 | `<QUALITY_WORKER_FUNCTION>` does not support async invocation, or its input depends on secrets in the ZIP | Thin wrapper (§10.6); Q13 |
| R5 | Leftover keys in the target's `~/.aws` eclipse the instance profile | Dedicated deploy user or forcing the role chain (§10.10) |
| R6 | Migrations are not backward compatible | Documented requirement; DEV DB snapshot before the first test |
| R7 | Disk and concurrency on the shared host (`<PRMS_REPORTING_REPO>` of unknown size) | Measurement in Inc 3, container limits, bounded concurrency |
| R8 | Unknown target state after the SSH is cut | `UNKNOWN_TARGET_STATE` + runbook; idempotent script |
| R9 | DEV DB shared with 8 Jenkins variants from other branches | Test windows with the jobs disabled; snapshot; verify migration state before and after |
| R10 | The Executor grows into a workflow engine | §11 signals and vocabulary review on every wave |

### 15.3 Review of Q1–Q10 and new questions

| ID | Original question | Status | What's missing |
|---|---|---|---|
| Q1 | Report on the 152 pipelines + PRMS Reporting DEV's Jenkinsfile/`config.xml` | **PARTIALLY RESOLVED** | The FA is available and cites the reference Jenkinsfile line by line. The `config.xml` files are missing: names of the 8 jobs, triggers, concurrency, and each one's branch (B2). Blocks the deploy window (Gate C), not development |
| Q2 | Previous PoC and the current deploy script | **PARTIALLY RESOLVED** | Identified: reference Jenkinsfiles, `<QUALITY_WORKER_FUNCTION>`, `<LEGACY_CODEBUILD_PROJECT>`, and the inline deploy (there is no script). Missing: the worker's input format and whether it supports async; the PoC's buildspec; Dockerfiles and `.dockerignore` of `<PRMS_REPORTING_REPO>`; exact migration commands and order; reference branch |
| Q3 | Coexistence with Jenkins | **PARTIALLY RESOLVED** | Policy decided (disable the target's jobs per window, §12). Missing: job names (Q1) and the Jenkins owner who approves and executes the disable/enable |
| Q4 | SSH vs SSM | **RESOLVED** | SSH for the PoC; SSM remains future work |
| Q5 | Instance profile on the target | **OPEN** | Is `<PRMS_REPORTING_DEV_TARGET>` EC2? Can an instance profile be attached to it? What other jobs use its leftover keys (so as not to break them)? A dedicated deploy user or the current one? |
| Q6 | Network | **PARTIALLY RESOLVED** | Runtime decided and connectivity listed (§10.2). Missing: the real network spike (Inc 0) and whether there is a proxy or outbound firewall |
| Q7 | IaC tool | **OPEN** | No evidence of a standard (the FA found no Terraform or buildspecs in the repo). The CDK vs. Terraform decision is missing. **Blocks Inc 2, not the design or Inc 0–1** |
| Q8 | Framework (NestJS or other) | **PARTIALLY RESOLVED** | Node.js/TypeScript decided. The organization uses NestJS heavily (FA §3). Recommendation: TypeScript with no web framework, with the service structure from §14.4. Standalone NestJS is acceptable if the team prioritizes homogeneity. Decided in `design.md`; does not block |
| Q9 | Artifact retention | **RESOLVED** | Source: explicit deletion + 7-day lifecycle. Logs and reports: 30 days. Multipart: 1 day |
| Q10 | GitHub Actions | **RESOLVED** | Alternative, not selected |
| **Q11** | New: what host exactly is the "microservices server"? Is it `<MICROSERVICES_PROD_HOST>`? Does it use standalone Docker or Swarm? Outbound proxy? | **OPEN** | Blocks Gate B (R2) |
| **Q12** | New: how does the Executor obtain AWS credentials on that host without exposing them to other containers? | **OPEN** | Blocks Gate B (R3) |
| **Q13** | New: do the server and client quality tests need `.env` or `environment.ts` to compile or pass? | **OPEN** | Blocks Inc 4 |
| **Q14** | New: does anything consume the `<JENKINS_EXECUTIONS_TABLE>` table? | **OPEN** | Does not block the PoC; blocks retiring Jenkins |
| **Q15** | New: size of `<PRMS_REPORTING_REPO>` and the GitHub authentication method (private repo? GitHub App available?) | **OPEN** | Measured in Inc 3; authentication blocks Inc 3 |

---

## 16. Initiative decomposition (documented, no directories created)

| Order | Initiative | Purpose | Depends on | Parallel-safe |
|---|---|---|---|---|
| 1 | `cicd-executor-poc` (this one) | Validate the architecture with PRMS Reporting DEV | none | yes |
| 1 | `jenkins-config-inventory` | Export `config.xml`, triggers, parameters, concurrency, globals, plugins, credentials, and the `db-operations` library. Map job → file. Flag dead variants (~15). Inventory scripts on hosts and in Secrets Manager | none | yes |
| 1 | `cicd-security-remediation` | §13.2 | none | yes |
| 2 | `cicd-build-runtime-poc` (**new, recommended by FA §23**) | Test B1 with a static site (a static pipeline from INNOVATION-CATALOG or BI, `<JENKINS_JOB_ID>`) and an esbuild ZIP: Lambda builder vs. the environment's CodeBuild, with measurement | 1 (`cicd-executor-poc`) | no |
| 3+ | Migration waves (FA §25.10): CI-only and P4b → P1 with a key → P1 with a password → P2 → P5 → P3 → P6 → TANZANIA, RISK, PRMS reporting prod | Only after validating the PoC | 1, inventory, 2 (for P3, P5, P6) | no |

```text
Executor PoC development can start  ≠  Jenkins can be retired
```

---

## 17. Success Criteria / Acceptance

| # | Criterion | Test |
|---|---|---|
| AC1 | PRMS Reporting DEV deploys end-to-end with no Jenkins | E2E in DEV (manual; webhook in Inc 8) |
| AC2 | The Executor's image contains no build toolchains (build npm, mvn, docker CLI, or socket) | Image inspection |
| AC3 | The Executor has no network access or credentials toward any DB or application secrets | IAM, secrets, and network review |
| AC4 | CodeBuild only for images; quality in Lambda; one project per app and environment | Definitions + metrics |
| AC5 | A duplicate `BUILD_COMPLETED` or `PIPELINE_REQUESTED` produces no second deploy or second migration | Duplicate injection |
| AC6 | Two concurrent executions: distinct artifacts, serialized deploys, no regression (*supersede*) | Concurrent test |
| AC7 | A failed migration leaves the previous version serving | Broken migration on a test branch |
| AC8 | A failed health check restores `previousImageTag` | Image that fails to start |
| AC9 | Quality and build failures notify in Slack and stop the flow | Red test / broken Dockerfile |
| AC10 | Killing the Executor mid-deploy ends in a terminal state with the lock released | Container kill |
| AC11 | A poison message goes to the DLQ and triggers the alarm | Malformed message |
| AC12 | No secrets in ZIPs, S3 keys, image, definitions, or logs | Scan |
| AC13 | An operator reconstructs an execution using only DynamoDB, CloudWatch, and Slack | Runbook exercise |
| AC14 | Jenkins jobs are re-enabled and work after each window | Subsequent Jenkins run |
| AC15 | Duration and resource measurements (Lambda, CodeBuild, Executor) and cost comparison against §14.2 | Inc 8 report |

---

## 18. Recommendation: **GO WITH CONDITIONS**

The architecture is viable for the PoC and the FA shows no pattern that invalidates it. Concrete conditions remain, separated into distinct gates.

| Gate | Conditions |
|---|---|
| **A: before writing Executor code** (Inc 0–1) | (1) Approve this proposal. (2) `/akili-specify` approved (requirements, design, tasks). Nothing else: the domain, the schema, and the local tests do not depend on AWS or the host |
| **B: before deploying the Executor and infra in DEV** (Inc 2–5) | Q11 (host identified and accepted with respect to R2). Q12 (credential mechanism). Q7 (IaC). Access to DEV in `<AWS_ACCOUNT_ID>`. Inc 0's network spike green. Slack token. Q15 (GitHub authentication). Q2 and Q13 for Inc 4–5 |
| **C: before the end-to-end deploy on `<PRMS_REPORTING_DEV_TARGET>`** (Inc 6–8) | Names of the jobs that touch the target and approval of the §12 procedure (Q1, Q3). Q5 (instance profile or equivalent, with no breakage of jobs that use leftover keys). SSH credential (key preferred) and host key in Secrets Manager. Migration command and order confirmed (Q2). Snapshot or backup of the DEV DB |
| **D: before retiring Jenkins** (any job) | B2 complete (`jenkins-config-inventory`). B1 decided **and tested** (`cicd-build-runtime-poc`). H1 resolved (PRMS prod and TANZANIA migrations relocated). H2 (scripts inventoried and versioned). H3 (instance profiles on all targets and `<AWS_CREDENTIAL_REF>` rotation). SDK steps (`lambda-deploy`, `s3-sync`, `cloudfront-invalidate`, `cloudformation`). Jira Builds API. Credentials migrated. Q14. Each wave validated with Jenkins in parallel |

---

## 19. Next Step

**Recommended: `/akili-specify changes/cicd-executor-poc`** (after approving this proposal).

Why `/akili-specify` and not `/akili-constitution` now:

- Gate A only asks for the spec. The open questions (Q5, Q7, Q11–Q15) block later gates and can be resolved in parallel while specifying.
- The platform decisions (runtime, SQS, DynamoDB, locks, CodeBuild per environment, step vocabulary) are recorded here and in the FA, so the spec has a sufficient base.
- `/akili-constitution` adds value once the `cicd-platform` repo exists and the §16 family starts growing. At that point it's worth moving these decisions into a shared TRD or ADRs, so the waves don't repeat them. It is suggested to do this when archiving this PoC (`/akili-archive`) or before the first wave.

```text
/akili-specify changes/cicd-executor-poc
```

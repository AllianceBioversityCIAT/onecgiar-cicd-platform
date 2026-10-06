# Architecture Change AC-01 — GitHub Actions owns CI, the Executor owns CD

## 1. Document Control

| Field | Value |
|---|---|
| Spec | `changes/cicd-executor-poc` |
| Change ID | AC-01 |
| Type | Change (architectural, material) |
| Status | **APPROVED** by the owner (2026-10-06). Coordinated revision in order: proposal v3 → requirements → design → tasks → scoped Judgment Day. Implementation stays paused until the Judgment Day passes and the owner approves the execution plan |
| Author | CI/CD Platform Team (Leader, T1) |
| Date | 2026-10-06 |
| Trigger | Owner request: evaluate "GitHub Actions = CI; SQS = handoff; Executor = CD coordination; target = deployment procedure" under the principle **START SIMPLE** |
| Effect on execution | **Gate A PAUSED** at 12/23 tasks. Uncommitted in-flight work (T-08 DynamoDB store, T-14 deploy script attempt 3) is frozen in the working tree, neither committed nor discarded |
| Supersedes (if approved) | proposal §10.1, §10.4–§10.7, §11 option C rejection, Q10; requirements FR-01, FR-06, FR-08–FR-10, FR-20; design §3, §5.2, §6.1–§6.3, §6.6, §7.3, DD-05–DD-08, DD-13 (partially) |

### 1.1 Evidence and how it is cited

- Spec documents in this folder: `file:line`.
- Code: path plus measured line counts (`wc -l`, non-test sources, 2026-10-06).
- External platforms: the primary documentation URL, read 2026-10-06. A claim backed only by a secondary source is marked `UNVERIFIED — confirm at source before relying on it`.

---

## 2. Answer

**Adopt Model B.** For normal CI, there is **no strong reason** for the Executor to orchestrate Lambda and CodeBuild.

1. **The original rejection was about scope, not a technical finding.** The approved proposal rejected GitHub Actions only as "not the architecture being evaluated" (`proposal.md:631`, `proposal.md:858`). No requirement, risk or premise depends on CI running inside AWS.
2. **Model B removes the hardest open problem.** The biggest gap in the current design was **B1**: there is no runtime for about 45 non-Docker builds, the policy is "not tested", and it blocks retiring Jenkins (`proposal.md:54`, `proposal.md:785`). GitHub-hosted runners already provide Node, Maven and Docker.
3. **Model B removes the riskiest part of the Executor.** In Model A the Executor clones repositories, packages ZIPs, holds a GitHub credential and a `/work` volume, and correlates asynchronous Lambda and CodeBuild completions. That is a step DAG with fan-in, finally steps, orphan events and a 13-transition machine. This is exactly the drift toward "another Jenkins" that the proposal warns about (`proposal.md:634-643`).
4. **CI is free here.** For public repositories, GitHub Actions on standard GitHub-hosted runners costs nothing (§3, P-A1).
5. **A central Executor is still justified for CD.** §5 explains why GitHub Actions should not deploy directly.

Lambda and CodeBuild stay available as **exceptional capabilities** (§9.3). They leave the normal path.

---

## 3. New premises

| ID | Premise | Status and citation |
|---|---|---|
| P-A1 | GitHub Actions is free for public repositories that use standard GitHub-hosted runners. Larger runners are always charged | **VERIFIED**: docs.github.com, "GitHub Actions billing" ("usage is free … for public repositories that use standard GitHub-hosted runners"; "Larger runners are always charged for") |
| P-A2 | The OIDC `sub` claim distinguishes branch (`repo:ORG/REPO:ref:refs/heads/BRANCH`), environment (`repo:ORG/REPO:environment:NAME`) and pull request (`repo:ORG/REPO:pull_request`). Requesting a token requires `id-token: write` | **VERIFIED**: docs.github.com, "OpenID Connect reference" |
| P-A3 | Workflows triggered by `pull_request` from a fork receive no OIDC token and no secrets, whatever permissions are declared | `UNVERIFIED — confirm at source before relying on it`. Secondary sources agree; the primary GitHub statement must be pinned at the design phase. The design must not depend on it alone (§8, trust restricted by `sub`) |
| P-A4 | SQS can return `SenderId` on receipt. For an IAM role it is `ROLEID:session-name`, where the role ID is assigned by AWS | **VERIFIED**: AWS SQS API Reference, `ReceiveMessage`, `MessageSystemAttributeNames` |
| P-A5 | The repositories in scope are public | Owner input (2026-10-06). `UNVERIFIED — confirm at source before relying on it` per repository; earlier Q15 asked "private repo?" (`proposal.md:863`) |
| P-A6 | `github.run_number` increases with each new run of a workflow and does not change when a run is re-run | `UNVERIFIED — confirm at source before relying on it` (GitHub "contexts" reference). It is the candidate ordering key (OD-A1) |
| P-A7 | Logs and workflow files of public repositories are publicly readable | `UNVERIFIED — confirm at source before relying on it`. The design assumes yes; that is the safe assumption (§8.2) |

---

## 4. Proposed architecture (Model B)

```text
GitHub repo ── push / PR / workflow_dispatch ──> GitHub Actions (CI)
                                                   checkout · install · lint · test · build
                                                   docker build · push to ECR (by digest)
                                                   or: publish artifact (immutable, checksummed)
                                                           │  OIDC → per-repo CI role
                                                           │  (ECR push to its repo, SQS SendMessage)
                                                           v
                                         SQS deploy-requests (Standard) ── DLQ → alarm
                                                           │
                         ┌──────── Existing microservices server ────────┐
                         │  cicd-executor (CD coordination only)          │
                         │  validate · authenticate sender · dedupe ·     │
                         │  persist · supersede · lock · window · Slack   │
                         └───────────┬───────────────────────┬────────────┘
                              DynamoDB (state, dedupe, locks)    SSH/SFTP (pinned host key)
                                                                  v
                                                    Target server: versioned deploy script
                                                    pull by digest · migrate · swap · health
                                                    · restore · prune · CICD_RESULT
```

| Component | Owns | Never does |
|---|---|---|
| GitHub Actions | All CI: checkout, dependencies, lint, tests, builds, Docker build, image push by digest, artifact publication, then **one** `DEPLOY_REQUESTED` | Choose the host, SSH, run commands on targets, hold SSH keys, read runtime secrets |
| SQS | Asynchronous, at-least-once CI → CD handoff; DLQ | Order or deduplicate (the Executor does) |
| Executor | CD coordination: contract validation, sender authentication, dedupe, state, idempotency, supersede, lock, deploy windows, SSH semaphore, target resolution, Slack, result capture, reconciliation, audit | Clone, package, build, invoke CI steps, interpret artifact formats, read application secrets, connect to databases, per-project logic |
| Target and script | The application-specific procedure: retrieve artifact, migrate, swap, health check, restore, prune; deterministic exit codes | Decide ordering or locking across executions |

### 4.1 Deployment request contract (draft; the design phase fixes it)

```json
{
  "specVersion": 1,
  "eventType": "DEPLOY_REQUESTED",
  "requestId": "<github-run-id>-<run-attempt>",
  "deploymentId": "prms-reporting-dev",
  "commitSha": "<40-hex>",
  "ordinal": 184,
  "artifacts": { "server": "sha256:<digest>", "client": "sha256:<digest>" },
  "ci": { "repository": "<GITHUB_ORG>/<REPO>", "runId": "<id>", "runAttempt": 1, "workflowRef": "<ref>" }
}
```

| Rule | Why |
|---|---|
| `additionalProperties: false`. No host, IP, port, user, command, script body, script path, image repository, registry, `sudo` or environment variables | The request asks for a deployment; it never says how to perform it (owner §5) |
| An artifact is an **immutable identity** (an image digest, or object key + version + SHA-256). Tags are never accepted | Mutable tags let what was tested differ from what is deployed (§8) |
| The image **repository** comes from the trusted Deployment Definition; the request supplies only the digest | A request cannot point the target at an arbitrary image |
| `ordinal` is the supersede ordering key (OD-A1) | An older CI run that finishes late must not replace a newer deployment |
| `ci.*` is for audit only and never drives behavior | Traceability to the GitHub run |

### 4.2 Target resolution (trusted, unchanged in spirit)

`deploymentId` → **Deployment Definition** (bundled in the image as in DD-19), which contains:
- `targetRef` → Target Registry (host identity, port, user, `credentialRef`, pinned host key);
- the approved `deployScript` (a versioned file in this repo, delivered over SFTP as in DD-10);
- static script parameters (units, containers, ports, image repositories);
- `lockKey`, the deploy-window policy, the timeout and the Slack channel;
- `allowedSender` (the CI role, §8.1).

None of these values can be overridden by a request.

### 4.3 Deployment script contract (kept from §6.4, generalized)

The Executor runs `<approved-script> --execution-id <id> --lock-key <k> --fencing-token <t> --artifact <unit>=<immutable-ref>… <static params from the definition>`. The contract is standardized; each application's internals are not.

The following stay unchanged:
- exit codes 0/10/20/30/40/50;
- the `CICD_RESULT` line;
- the kernel `flock` mutex;
- migration before the swap;
- the previous version kept available;
- the health check and restore;
- the stale-mutex runbook (design §12.1);
- no blind SSH retry once execution has begun.

`deploy-container.sh` (T-14) becomes the **first implementation for Docker**. A static-artifact script is a later wave.

### 4.4 State machine (execution-level; steps disappear)

```text
RECEIVED ─validate─> QUEUED ─> WAITING_LOCK ⇄ (window closed / lock busy, bounded wait)
   │                    │            │
   │                    │            └─lock + window OK─> DEPLOYING ─exit 0──────> SUCCEEDED
   │                    │                                  │ exit 10/20/30/40 ─────> FAILED(code)
   │                    │                                  │ exit 50 ─────────────> WAITING_LOCK (only backward edge)
   │                    │                                  └ no result / crash ───> UNKNOWN_TARGET_STATE
   │                    └─ a newer ordinal deployed or queued ─> SUPERSEDED
   └─ invalid contract / unauthorized sender ─> REJECTED (audited, never deployed)
   WAITING_LOCK past its budget ─> FAILED(LOCK_TIMEOUT)
```

| Kept, because deployment needs it | Dropped, because only Lambda/CodeBuild needed it |
|---|---|
| Intent-then-act with `dispatchToken` before SSH (crash recovery, DD-04) | Step entities, step graph, `needs`, fan-in, `finally`, cascade skip (DD-06 planner) |
| Exit 50 → `WAITING_LOCK` (formerly T9) | T10 / T13 asynchronous redispatch (Lambda/CodeBuild) |
| Canonical `FAILED(LOCK_TIMEOUT)` | `RETRY_LATER` / `ORPHAN` correlation for CodeBuild results |
| `UNKNOWN_TARGET_STATE` (no blind retry) | Lambda `dispatchToken` correlation, `BatchGetBuilds` reconciliation |
| Deadlines and reconciliation of stuck `DEPLOYING` and orphan locks | Reconciliation of quality and build steps |

There are about 9 transitions instead of 13 step transitions plus the execution-level rules. Spec gaps (a)–(e) recorded during Gate A (multi-step outcome semantics) **disappear**.

### 4.5 Deployment Definition replaces Pipeline Definition

The Executor no longer needs a graph of `lambda → codebuild → ssh`. **Recommendation:** replace `pipeline.schema.json` with a flat `deployment.schema.json` (§4.2 fields). Keep `targets.schema.json` and the reference-resolution rules: DD-23, existence-only `credentialRef`, logical `<…>` refs. `pipelineId` is renamed `deploymentId`; the semantic id `prms-reporting-dev` is unchanged. Reserved future step types (`s3-sync`, `lambda-deploy`, …) are dropped from the schema (OD-A3).

---

## 5. Why keep an Executor at all (option C: GitHub Actions deploys directly)

The owner's test is "does this responsibility need centralized deployment coordination?". It was applied to the alternative of letting GitHub Actions SSH to targets directly.

| Responsibility | Needs central coordination? | Why |
|---|---|---|
| Network reach to targets | **Yes** | Targets are private. GitHub-hosted runners would need inbound SSH from the internet, or self-hosted runners inside the network, which is a Jenkins-like fleet |
| SSH key custody | **Yes** | Keys would live in GitHub secrets of public repositories. In Model B they never leave Secrets Manager and the Executor |
| Cross-repo / cross-branch lock and supersede | **Yes** | Up to 8 jobs deploy the same containers (`proposal.md:59`). GitHub `concurrency` groups do not cover several repositories, have no fencing and are not durable |
| Deploy windows (Jenkins coexistence) | **Yes** | It is one policy per target, not per workflow (DD-21) |
| Central Slack and audit | **Yes, moderately** | One format, one channel and a reconstructable trail, independent of each workflow |
| Lint, test, build, image push | **No** | GitHub Actions does these natively → moved out |
| Quality/build completion correlation | **No** | It existed only because CI ran outside GitHub → removed |

**Result:** option C is rejected. The Executor keeps only the left-column "Yes" items.

---

## 6. Comparison: Model A (approved) vs Model B (proposed)

| Criterion | A: Executor → Lambda / CodeBuild → SSH | B: GitHub Actions → SQS → Executor → SSH |
|---|---|---|
| Architecture complexity | Step DAG, 13 step transitions, asynchronous correlation of 3 result channels (Lambda Destinations, EventBridge, SSH) | One execution, one remote call, ~9 transitions, one result channel (SSH) |
| Custom Executor code (estimate) | ~5,500–6,000 production LOC planned in the Executor (budget ~8,700 total incl. tests/scripts, design §13) | ~2,800–3,300 production LOC (§12) |
| AWS infrastructure | Adds a CodeBuild project + role, an S3 artifacts bucket + lifecycle, Lambda async config + Destinations role, an EventBridge rule, ingress Lambda + Function URL | Adds an IAM OIDC provider, one least-privilege CI role per repository, an SQS queue policy. **Removed:** CodeBuild, S3, Destinations, EventBridge, ingress |
| Operational burden | Executor clones (disk, `/work`, repo size unknown — R7, OD-Q15), CodeBuild images and caches, Lambda worker ownership | No clone, no disk volume, no GitHub credential. CI is operated by GitHub |
| CI execution suitability | B1 unsolved for ~45 non-Docker builds; the quality worker's input format is unknown (Q2, Q13) | Native toolchains (Node, Maven, Docker, SAM CLI). B1 is solved for builds |
| Security | Executor holds a GitHub token and AWS rights to S3, Lambda and CodeBuild; build secrets in CodeBuild | Executor holds only SSH + Slack refs. New trust boundary: public repository → OIDC → AWS (§8) |
| IAM | Executor role is broad (S3, Lambda, CodeBuild, SQS, DynamoDB, Secrets) | Executor: SQS consume, DynamoDB, 2 secret reads. CI role: ECR push to one repo, SQS SendMessage |
| Failure modes | Lost completions, orphan results, CodeBuild "not found", partial fan-in, Executor crash mid-clone | CI failure never reaches the Executor. Lost or duplicate requests → DLQ and dedupe. SSH failures unchanged |
| Observability | DynamoDB + CloudWatch + Slack; CI logs split between Lambda and CodeBuild | CI logs in GitHub (public — §8.2); CD trail in DynamoDB + CloudWatch + Slack, linked by `requestId` |
| Vendor dependency | AWS only for CI; GitHub only for source | GitHub becomes the CI critical path (it already hosts the source). Mitigation: deploy-only path with an already-built digest (OD-A8) |
| Cost | CodeBuild per minute (main variable cost), Lambda, S3 | CI free on public repositories (P-A1); Executor infra cost drops |
| Scalability | Bounded by Executor clone concurrency (N=2) and CodeBuild quotas | CI scales with GitHub runner concurrency (plan-dependent, `UNVERIFIED`); Executor only serializes deploys |
| Maintainability | Executor evolves with every new CI pattern (warning signs §11) | Executor changes only when the deploy contract changes; CI patterns live in reusable workflows |
| Migration effort from Jenkins | No application repo changes; all logic in this repo | **Each application repo gains a workflow file** (formerly a non-goal, `proposal.md:762`) — reduced with reusable workflows from this repo (OD-A6) |
| 152 pipelines | P3/P5/P6 partial or uncovered (B1) | See §7: builds are covered; non-SSH deploys are an explicit open decision |
| Docker and non-Docker | Docker in PoC; non-Docker untested | Both built by GitHub Actions; deploy scripts differ per artifact type behind one contract |

---

## 7. The 152 pipelines under Model B

Pattern counts as recorded in `proposal.md:770-781`.

| Pattern | ≈# | Model B | Remaining gap |
|---|---:|---|---|
| P1 Docker → ECR → SSH | 57 | **Fully** (the PoC) | Password → key migration (unchanged) |
| P2 SSH + script on host | 18 | **Yes** | Script content (H2, unchanged); builds move to GitHub Actions where possible |
| P3 static → S3 → CloudFront | 8 (+~10) | Build **yes** (B1 solved) | Deploy is not SSH → **OD-A3** |
| P4 / P4b Lambda image | 6 (+2) / 9 | Build **yes** | Deploy is an AWS API call → **OD-A3** |
| P5 Lambda ZIP | 8 | Build **yes** (B1 solved) | **OD-A3** |
| P6 SAM / CFN / repo scripts | 15 | Build **yes** (toolchains available) | **OD-A3**; manual change sets stay manual |
| P7 Swarm | 4 | **Yes** via SSH | Host-scoped lock (unchanged) |
| P8 CI only | 22 | **Entirely GitHub Actions**; the Executor is not involved | None |
| P9 utilities | 3 | Outside the Executor (unchanged) | — |

Migrations with no target server (TANZANIA against RDS, H1) still need a network-attached runtime. They become the first **exception** use of CodeBuild in a VPC or a VPC Lambda (§9.3), as they already were in Model A (`proposal.md:796`).

---

## 8. Security review of the new trust boundary

### 8.1 Controls

| Threat | Control |
|---|---|
| Fork PR obtains AWS credentials | The OIDC trust policy accepts only `sub = repo:<GITHUB_ORG>/<REPO>:environment:<ENV>`, never `pull_request` or wildcard refs (P-A2). This does not rely on P-A3 |
| Workflow modified in a branch to deploy | The GitHub Environment has **deployment branch rules** (only protected branches). `main` is branch-protected (reviews, no force-push). Production environments add **required reviewers** |
| CI role over-privileged | One role per repository: `ecr:GetAuthorizationToken` plus push to **that repository's** ECR repos, and `sqs:SendMessage` on the deploy queue. No SSH, EC2, Secrets Manager, database or infrastructure rights |
| Request for a deployment the repo does not own | The Executor reads `SenderId` (P-A4) and requires the role ID to equal the definition's `allowedSender`. Repo X's role cannot deploy `deploymentId` Y. Unauthorized → `REJECTED` + alarm |
| Malicious or incorrect request content | Strict schema with no infrastructure fields (§4.1). Image repository from trusted config; digest format validated; unknown `deploymentId` → `REJECTED` |
| Mutable tag swapped after tests | Deploy by digest only. The target pulls `<trusted-repo>@sha256:…`. ECR tag immutability is recommended but not required (OD-A7) |
| Replayed / duplicate SQS message | Dedupe on `requestId` (DD-20 leased claim, kept). A re-run of the same CI run → new `runAttempt`, same digest → the script's idempotent no-op path (FR-13) |
| Older commit replaces newer | Supersede by `ordinal` per `lockKey` (DD-09 kept; ordering key changes, OD-A1) |
| Operator rollback to an older version | An explicit, separately authorized path (operator role, `rollback: true`, audited); never through the CI role (OD-A8) |
| Production approval | GitHub Environment required reviewers before the request is even sent. The Executor additionally enforces deploy windows. No approval step in the Executor (no "another Jenkins") |

### 8.2 Public repositories: what becomes visible

| Exposure | Mitigation |
|---|---|
| Workflow files and CI logs are public (P-A7) | Workflows reference the role ARN and registry through GitHub **secrets or masked variables**, so the AWS account ID (part of every ECR hostname and ARN) is masked in logs. This extends DD-23's publication policy to application repositories |
| Build-time secrets | Prefer none: images must not bake secrets (runtime secrets stay on the target, §10.10 unchanged). Unavoidable build secrets come from Environment-scoped secrets, never exposed to fork PRs |
| Test configuration (former OD-Q13) | Tests use fake, non-secret configuration committed or generated in CI. Real `.env` values never enter CI |
| The deploy request | It contains only public-safe identifiers (§4.1). Hosts never appear |

---

## 9. What changes

### 9.1 Removed from the normal path

LambdaStepHandler; CodeBuildStepHandler; source handler (clone, ZIP, S3 upload); the `/work` volume and its ownership rules (design §7.4); the git CLI client and the `git` package in the Executor image; the S3 artifacts bucket for source and quality; the reuse of `<QUALITY_WORKER_FUNCTION>` and its async/Destinations configuration; Lambda result correlation; CodeBuild project `prms-reporting-dev`, its buildspec, EventBridge rule and `BatchGetBuilds` reconciliation; the planner (DAG, fan-in, finally, cascade); step entities and step-level GSI usage; `RETRY_LATER` / `ORPHAN` event routing; the GitHub webhook ingress Lambda (GitHub triggers workflows natively); the Executor's GitHub credential.

### 9.2 Kept (justified by deployment coordination)

SQS Standard + DLQ, at-least-once; idempotency; request dedupe (DD-20); persisted execution state with conditional writes (DD-03); intent-then-act (DD-04); supersede; DynamoDB lock with lease and fencing (DD-09); lock-wait schedule (§7.6); target-side kernel mutex (DD-22); deploy windows (DD-21, §7.7); SSH semaphore and resource release (§7.5); pinned host key; trusted Target Registry; existence-only credential references (DD-23); `DefinitionSource` (DD-19); script delivered over SFTP (DD-10); migration before swap (DD-11); Slack (DD-12); reconciliation, limited to deploy state (DD-13); visibility heartbeat (DD-14); observability with redaction; failure classification (§7.2, reduced to deploy codes); stale-mutex runbook; Jenkins coexistence procedure (FR-18).

### 9.3 Exceptions (not in the normal path, not banned)

| Capability | When |
|---|---|
| CodeBuild (in a VPC) | A workload needing an AWS-internal network or environment, e.g. migrations with no target server (TANZANIA, H1) |
| Lambda | Small AWS event processing |
| Self-hosted runners | **Not recommended.** They recreate a build fleet |

Adding an exception to the Executor's vocabulary requires a spec change. It is not a default.

---

## 10. Specification impact

| Document | Impact |
|---|---|
| `proposal.md` | Revise §2, §4, §5, §6 (application repo workflows stop being a non-goal), §10.1–§10.7, §11 (option C becomes the selected CI, merged with A for CD), §14 resources/cost, §15 coverage, §17 acceptance (AC4, AC9 rewritten; AC2 adds "no git"), Q2/Q10/Q13/Q15 status |
| `requirements.md` | FR-01 → Deployment Definitions; FR-03/FR-04 → deploy request contract and sender authentication; FR-06 removed (step scheduling); FR-08, FR-09, FR-10, FR-20 removed; **new FR: CI contract** (what a workflow must provide) and **new FR: request authentication**; FR-05, FR-07, FR-11–FR-19 kept with edits; NFR-01 wording narrowed (no clone either) |
| `design.md` | §3 diagrams; §5.1 table (no steps), §5.2 removed; §6.1 envelope → request contract, §6.2/§6.3/§6.6 removed, §6.4 generalized; §7.3 new closed list (§4.4 above); §7.4 removed; DD-05 reduced (one handler), DD-06/DD-07/DD-08 removed; new DD: OIDC trust model, sender binding, immutable artifacts, ordering key; Premise Ledger gains P-A1–P-A7; budget §13 recomputed |
| `judgment.md` | Unchanged history. A new scoped round appends to it |
| `tasks.md` | Rewritten for Gate A (§13); Gates B–D re-derived |
| `execution.md` | Gains a PAUSE record now and, after approval, the mapping of completed tasks to the new plan |

**Workflow:** this document → owner approval → `proposal.md` v3 → `/akili-specify` revision of requirements, design and tasks → **scoped Judgment Day** → `/akili-execute` resumes with the new Gate A. Files are not patched one by one: the four documents are revised together so they stay consistent.

---

## 11. Tasks: obsolete, rewritten, kept

| Task | Status today | Under Model B |
|---|---|---|
| T-00 workspace, `.gitignore` | Done | **Kept** |
| T-01 skeleton, Dockerfile, ports | Done (local) | **Kept**, small rework: drop `git` from the image, drop unused ports (`ArtifactStore`, `GitClient`, Lambda/CodeBuild invokers) |
| T-02 schemas + PRMS definition | Done | **Rewritten**: deployment and request schemas; `targets.schema.json` kept |
| T-03 `DefinitionSource` + validation | Done | **Rewritten in part**: reference rules, allowlists and the bundled source are kept; step-graph validation is removed |
| T-04 state machine T1–T13 | Done | **Rewritten** (smaller, §4.4) |
| T-05 planner | Done | **Obsolete** (deleted) |
| T-06 lock policy | Done | **Kept**; supersede ordering key adapted |
| T-07 events and router | Done | **Rewritten** (smaller): request validation, sender check; no orphans |
| T-08 DynamoDB store | In progress (uncommitted) | **Reduced**: execution, dedupe, lock, sequence, window and target-state repos kept; step repos and step lookup dropped |
| T-09 identity and dedupe | Pending | **Kept** (`requestId` as dedupe key) |
| T-10 step dispatcher | Pending | **Replaced** by a deploy coordinator (intent-then-act around one SSH call) |
| T-11 reconciler | Pending | **Reduced** (deploy state, orphan locks, past deadline) |
| T-12 deploy windows | Pending | **Kept** |
| T-13 SSH handler | Pending | **Kept** |
| T-14 `deploy-container.sh` | In progress (attempt 3 unverified) | **Kept**; adapt `--image` to digest refs |
| T-15 source handler, `/work` | Pending | **Obsolete** |
| T-16 Slack | Pending | **Kept** |
| T-17 observability | Done | **Kept** |
| T-18 SQS consumer + bootstrap | Pending | **Kept**, simpler |
| T-19 Lambda / CodeBuild handlers | Pending | **Obsolete** |
| T-20 webhook ingress | Done | **Obsolete** (code removed; GitHub triggers workflows natively) |
| T-21 boundary guards | Done | **Kept**; guards 3 and 6 retargeted to the new schemas |
| T-22 infra inventory, runbooks | Done | **Rewritten in part**: remove S3, CodeBuild, Destinations, EventBridge, ingress; add OIDC provider, CI roles, queue policy |
| T-23–T-31 (Gate B) | Blocked | Re-derived: fewer resources; T-29 (CodeBuild) and the Lambda work drop; OD-N1 likely answered by GitHub Actions but **still an owner decision** |
| T-32–T-36 (Gate C) | Blocked | Re-derived around one CI workflow + one deploy |

**New tasks:** a reusable GitHub Actions workflow in this repo (build, push by digest, send request) and the PRMS Reporting DEV caller workflow. They are statically validated in Gate A; adding the caller to the application repo is an owner decision (OD-A6).

---

## 12. Implementation reuse (measured)

| Module (non-test LOC) | Verdict |
|---|---|
| `observability` 681 | Reuse as is |
| `domain/lock-policy` 186, `domain/errors` 76 | Reuse; adapt ordering key and error codes |
| `adapters/bundled-definition-source` 181, `ports` 205 | Reuse; prune unused ports |
| `application/definition-service` 894 | Reuse ~60% (references, allowlists, connection parsing); drop step-graph rules |
| `adapters/dynamodb-state-store` 1,308 (uncommitted) | Reuse ~60%; drop step repositories and step GSI usage |
| `domain/state-machine` 590 | Rewrite (~250 expected) |
| `domain/events` 391 + `application/event-router` 369 | Rewrite (~250 expected) |
| `domain/planner` 268 | Delete |
| `ingress/github-webhook` 613 (+ tests) | Delete |
| `deploy-scripts` 657 (uncommitted) | Reuse; adapt artifact args |
| `executor/scripts` 1,564 (guards, image inspection) | Reuse; retarget 2 guards |
| `schemas` 458 | Rewrite the pipeline and event schemas; keep targets |

**Executor complexity estimate:** production code goes from ~5,500–6,000 LOC planned to ~2,800–3,300, a reduction of about **45–50%**. Moving parts in the Executor go from 6 handler/adapter families (source, git, S3, Lambda, CodeBuild, SSH + notify) to 2 (SSH, notify). The state machine shrinks from 13 transitions to ~9. Three asynchronous result channels become one. New complexity outside the Executor: OIDC trust policies, CI roles and reusable workflows. That is configuration, not coordination code.

---

## 13. New Gate A scope (estimate)

About **18 tasks** (23 before):
- **6 already done and kept:** T-00, T-06, T-17, T-21 with a small retarget, and T-01 and T-22 with small reworks.
- **About 12 to write or rework:**
  - deployment and request schemas;
  - DefinitionService rework;
  - state machine;
  - request validation and sender binding;
  - DynamoDB store (reduced);
  - identity and dedupe;
  - deploy coordinator;
  - reconciler (reduced);
  - deploy windows;
  - SSH handler;
  - deploy script adaptation;
  - Slack, SQS consumer and bootstrap;
  - reusable workflow and PRMS caller workflow (static validation).

The budget is recomputed in the design revision. Expect about 60% of the original ~8,700 LOC and about 30 review rounds instead of about 50.

---

## 14. Open decisions

### 14.1 New (none resolved here)

| ID | Decision | Blocks |
|---|---|---|
| OD-A1 | Supersede ordering key: `github.run_number` (P-A6), commit time, or a GitHub ancestry check (which would bring a GitHub credential back into the Executor) | Design |
| OD-A2 | Confirm the request authentication model: `SenderId` role binding (recommended), payload signature, or one queue per repository | Design |
| OD-A3 | Who performs non-SSH deploys (P3–P6, ~55 pipelines): GitHub Actions directly with environment-protected roles, Executor SDK deploy adapters, or a deploy-runner exception | Gate D waves, **not the PoC** |
| OD-A4 | Store for non-Docker artifacts: versioned S3 with checksums, or GitHub releases | Non-Docker waves, not the PoC |
| OD-A5 | CI failure notifications: GitHub-native only, or a Slack step in the reusable workflow (needs a Slack secret in GitHub) | Design (AC9 rewrite) |
| OD-A6 | Application repo changes: who approves adding workflows to application repos; whether reusable workflows are pinned by tag or by SHA | Gate C |
| OD-A7 | ECR tag immutability on the shared `<ECR_REPOSITORY>` (Jenkins jobs may rely on mutable tags) | Not the PoC (deploy by digest) |
| OD-A8 | Operator redeploy / rollback path that bypasses supersede explicitly, and its authorization | Design |
| OD-A9 | Confirm P-A5 (public) per repository; the security model must also hold for private ones (it does: only cost changes) | Gate B |

### 14.2 Existing

| ID | Under Model B |
|---|---|
| OD-Q5 (target credentials), OD-Q7 (IaC), OD-Q11 (host), OD-Q12 (Executor credentials), OD-Q14 (Jenkins table) | **Still open**, unchanged. OD-Q12's blast radius shrinks (fewer Executor permissions) |
| OD-N1 (CI for this repo) | Still open. GitHub Actions becomes the natural candidate, but the owner decides |
| Q2 (worker format, previous buildspec), OD-Q13 (tests need `.env`), OD-Q15 (repo size, GitHub auth) | **Moved out of the Executor**: they become CI-workflow concerns or disappear. Each is still recorded until the owner closes it |

---

## 15. New security assumptions

1. GitHub's OIDC issuer and the AWS IAM OIDC provider are trusted. Compromising GitHub's issuer would allow CI-role impersonation, limited to ECR push and SQS send.
2. Branch protection and Environment rules are configured and kept by repository admins. A repository admin can weaken them, so admin rights become part of the deploy trust boundary.
3. A CI role compromise can at most push an image and request deployment of **its own** `deploymentId`. Supersede, windows, locks and the script still apply. It cannot choose a host or a command.
4. SQS `SenderId` is set by AWS and cannot be forged by the sender (P-A4).
5. Public CI logs are treated as public: no internal identifier may appear in them (§8.2).

---

## 16. Is another Judgment Day required?

**Yes.** Run a scoped two-judge round over the revised proposal, requirements and design. Attack first:
1. the OIDC → IAM → SQS trust boundary and the sender binding;
2. the new closed state machine (crash recovery, exit 50, `UNKNOWN_TARGET_STATE`);
3. the supersede ordering key under at-least-once delivery;
4. the request contract's "no infrastructure fields" rule;
5. the Premise Ledger rows P-A1–P-A7.

Implementation resumes only after `JUDGMENT: APPROVED`.

---

## 17. What the owner is asked to decide now

1. Approve or reject Model B (this document).
2. If approved: authorize revising `proposal.md` → requirements → design → tasks as one coherent change, followed by a scoped Judgment Day.
3. What to do with the frozen in-flight work. Recommendation: keep the T-14 script (reused); keep T-08 uncommitted until the reduced store is specified; remove the T-20 ingress and the T-05 planner only in the revised plan's first task, not before.

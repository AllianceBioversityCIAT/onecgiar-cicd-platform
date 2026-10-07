# Gate B Plan (revision 2): owner-executed integration kit

| Field | Value |
|---|---|
| Spec | `changes/cicd-executor-poc` |
| Status | **APPROVED by the owner (2026-10-06)** with clarifications (§11): option (b) for SAM validation; validation and deployment are separate checkpoints; GitHub values classified (§12). Scope: **B0 only** (K-1…K-9); B1 needs a separate approval |
| Date | 2026-10-06 |
| Supersedes | Gate B plan revision 1 (same file) |
| Operating boundary | **Claude prepares; the owner executes.** No AWS, GitHub, repository or server is created, modified, deleted or connected to by Claude |

---

## 1. Answer first

Gate B is split into two phases with different actors.

| Phase | Actor | What happens |
|---|---|---|
| **B0 — Integration kit** | Claude (triad, reviewed, committed) | Writes source code, SAM templates, example configuration, the example caller workflow, owner scripts and documentation. Runs only local, non-mutating validation: tests, static template checks, `npm run check:local`, and no `sam validate` (owner-executed, §11) |
| **B1–B5 — Integration run** | **Owner, manually** | Runs every external command from the kit: SAM deploy, secrets, GitHub, the local Executor under Node 22, SSH validation, the deployment, teardown. Claude only reads the evidence the owner shares back and checks it against the expected results |

**Hard boundary for Claude in Gate B:**
- No `sam deploy` or `sam delete`, and no `aws cloudformation deploy` or `delete-stack`.
- No SQS, DynamoDB, IAM, Secrets Manager or EventBridge mutation, and no AWS call that changes state.
- No GitHub repository, branch, workflow, Environment, secret or variable.
- No application-repository change.
- No SSH or SFTP, and no script execution, on any real server.

Every such command appears **only** in the kit documentation, for the owner to run.

---

## 2. Decisions recorded (owner, 2026-10-06)

| ID | Decision |
|---|---|
| D-1 (OD-Q7) | **RESOLVED: AWS SAM / CloudFormation** for the PoC infrastructure |
| D-2 | **RESOLVED: no application repository is touched.** Claude provides an example caller workflow and exact manual instructions; the owner picks the repository and branch |
| D-3 | **RESOLVED: the target stays parameterized.** No server is chosen or contacted; definitions use placeholders; the owner supplies values |
| D-4 | **RESOLVED: Node 22** for the local Executor, via a portable/local approach; no system-wide Node change |
| D-5 | **REFRAMED:** non-destructive SSH/`flock` validation is **owner-run probe tooling outside the production `deployScript` allowlist**. No new approved deploy script |

Still open, and **not** resolved by this plan: OD-Q5 (target credentials to pull from ECR), OD-Q11 and OD-Q12 (permanent host and its credentials; Gate C), OD-N1, OD-A6 (PRMS repo; Gate C), OD-A7, OD-A8, and spec gaps G-1 to G-6, plus G-8 and G-9 found in B0 — both **resolved by the owner on 2026-10-06** (minimal RECONCILE_TICK contract; fail-fast definition loading), together with G-10 (no GitHub secret) (`execution.md`, "Spec gaps found in B0").

---

## 3. Milestones

### B0 — Integration kit (Claude; nothing external)

Implementation tasks, each through Implementer → Leader evidence re-run → Reviewer → commit:

| Task | Deliverable | Local validation |
|---|---|---|
| **K-1 SAM template** | `infra/sam/template.yaml` + parameter examples + `samconfig.example.toml` | Contract test parsing the template (CloudFormation intrinsic tags supported): exact `StringEquals` trust (no `StringLike`/wildcards), explicit queue-policy `Deny`, Executor role without forbidden actions (ECR/S3/Lambda/CodeBuild/app secrets), tags `cicd-poc` on every taggable resource, DeletionPolicy explicit, no literal account IDs. `sam validate --lint` is owner-executed (§11) |
| **K-2 Secrets Manager `SecretProvider`** | Real adapter (`adapters/secrets-manager-provider`): `exists` = `DescribeSecret`, `getSecret` = `GetSecretValue` at point of use; logical ref → secret id by a documented, configurable convention (`CICD_SECRET_ID_PREFIX` + ref name); ARNs and values sanitized from errors | Unit tests with a mocked SDK client; publication guard; no network |
| **K-3 Offline definitions check** | `npm run definitions:check -- --root <dir>`: runs `validateForCi` on an owner's local definitions root (no AWS, no secrets) | Unit tests; falsifier with a broken example |
| **K-4 Example definitions** | `docs/gate-b/examples/definitions/` — a parameterized Deployment Definition and Target Registry entry with placeholders, to be copied by the owner into a **local, gitignored** definitions root | Passes `definitions:check` once placeholders are filled with sample logical refs |
| **K-5 Caller workflow example** | `docs/gate-b/github/caller-workflow.example.yml` (hardened from `docs/examples/caller-workflow.yml`), placeholders only | Existing reusable-workflow contract test extended to this file; guard 7 on the reusable workflow |
| **K-6 Local Executor run kit** | `docs/gate-b/executor/executor.env.example` (keys only), `tools/gate-b/run-executor.ps1` and `run-executor.sh` (load an env file, select the local Node 22 binary, run `node dist/src/main/index.js`; **no** code path in the Executor) | Script lint/dry-run mode that prints the resolved command without starting anything |
| **K-7 Owner probe tooling (D-5)** | `tools/gate-b/probe/`: (a) `ssh-preflight` — prints the commands the owner runs to fetch and compare the host-key fingerprint and to test a strict-host-key login; (b) `target-probe.sh` — a read-only script the owner runs **manually on the target**: bash version, `flock` presence, Docker CLI presence, `/tmp` permissions, and a `flock -n` contention check on a **probe-only** lock file; (c) `executor-ssh-probe` — an owner-run Node tool reusing the Executor's SSH adapter to verify host key, fresh 0700 SFTP delivery, checksum and `CICD_RESULT` parsing with the read-only probe script. Located under `tools/`, never in `deployment-definitions/` or the `deployScript` enum, never copied into the image | Unit tests for argument building and parsing; `bash -n`; no execution against a real host |
| **K-8 Gate B documentation** | `docs/gate-b/` (§6) | Publication scan; link check |
| **K-9 B0 closure** | Kit evidence recorded in `execution.md` | `check:local`, `validate --require-workflow`, contract tests |

### B1–B5 — Owner-executed integration run

| Milestone | Owner does | Expected evidence (owner shares back; Claude checks) |
|---|---|---|
| **B1** AWS foundation | Reviews the template; runs the documented `sam deploy`; creates the Secrets Manager entries; configures the local profile that assumes the Executor role; starts the Executor under Node 22 | Stack outputs; startup log "definitions validated"; heartbeat metric; a scheduler-originated `RECONCILE_TICK` consumed (G-8 resolved 2026-10-06; the schedule is created DISABLED and the owner enables it in B1 once the Executor runs); a negative: the Executor role cannot read an application secret |
| **B2** GitHub OIDC → SQS → local Executor | Creates the GitHub Environment and the five variables of §12 (no secret); adds the caller workflow to a chosen repo and branch; triggers `workflow_dispatch` | Workflow run log (public-safe), SQS receipt in the Executor log with `senderRef`, execution QUEUED, then `FAILED (DEPLOY_WINDOW_CLOSED)` with the window closed (no SSH). Premises pinned: P-A4 SenderId form, P-G11, P-G14, G-3 (repo-level decoy variable), G-4, P-A3. Negatives: `pull_request`, `pull_request_target`, `workflow_run` cannot assume the role |
| **B3** State, dedupe, locks | Re-runs the same workflow run; runs an older build after a newer one; lets the scheduler tick (after enabling it in B1); sends a poison message (documented command) | The re-run is a **new** execution (new `requestId` = `runId-runAttempt`, same `runNumber`, not superseded; FR-23, FR-13 idempotent path) — dedupe applies to SQS redelivery of the same message, which cannot be forced from outside (corrected in B0, K-8); `SUPERSEDED` for the older; reconciler activity (G-8 resolved); DLQ after 5 receives + alarm |
| **B4** SSH (non-destructive) | Runs `ssh-preflight`, then `target-probe.sh` on the target, then `executor-ssh-probe` | Host-key match (and a deliberate mismatch rejected), `flock` contention = busy, fresh 0700 directory, checksum, parsed `CICD_RESULT` |
| **B5** One controlled deployment (optional; needs OD-Q5) | Fills the real deployment definition for a unit of their choice, opens a window if required, triggers the workflow | `SUCCEEDED`, Slack thread, `lastDeployed` fenced; optional forced health failure → previous image restored |

Claude does **not** run any B1–B5 step. When the owner shares outputs, Claude compares them with the expected evidence and records the result in `execution.md`.

---

## 4. Files to be created or modified (B0)

| Path | Action |
|---|---|
| `infra/sam/template.yaml` | Create |
| `infra/sam/parameters.example.json`, `infra/sam/samconfig.example.toml` | Create (placeholders) |
| `executor/src/adapters/secrets-manager-provider/**` | Implement (replaces the skeleton) |
| `executor/src/tools/definitions-check/**` (or `executor/scripts/definitions-check.mjs`) + npm script `definitions:check` | Create |
| `executor/package.json` / lockfile | Add `@aws-sdk/client-secrets-manager` (runtime) |
| `executor/test/**` | Contract test for the SAM template; unit tests for K-2, K-3, K-6, K-7 |
| `docs/gate-b/**` | Create (§6) |
| `docs/gate-b/examples/definitions/**`, `docs/gate-b/github/caller-workflow.example.yml`, `docs/gate-b/executor/executor.env.example` | Create (placeholders only) |
| `tools/gate-b/run-executor.{ps1,sh}`, `tools/gate-b/probe/**` | Create |
| `.gitignore` | Add the local definitions root and env file patterns under `executor/.local/` (already ignored; verified) |
| `infra/RESOURCES.md`, `docs/runbook.md` | Align with the SAM template |
| `docs/specs/changes/cicd-executor-poc/{tasks,execution}.md` | Gate B section rewritten (K-1…K-9, B1–B5 owner checklist); log entries |

No file under `deployment-definitions/` (the bundled, committed definitions) and no application repository is changed.

---

## 5. SAM resources to be defined (`infra/sam/template.yaml`)

All tagged `Project=cicd-poc`; names derived from a `Stage` parameter (default `dev`).

| Logical resource | Type | Notes |
|---|---|---|
| `DeployQueue`, `DeployDlq` | `AWS::SQS::Queue` ×2 | Visibility 120 s; `maxReceiveCount` 5; retention 4 d / 14 d; SSE |
| `DeployQueuePolicy` | `AWS::SQS::QueuePolicy` | Allow `SendMessage` to the CI role, Executor role, Scheduler role, operator role; **explicit Deny** to every other principal (`aws:PrincipalArn` not in the list) |
| `ExecutionsTable` | `AWS::DynamoDB::Table` | On-demand, TTL `expiresAt`, sparse GSI2 (`activeStatus` + `deadlineAt`), PITR optional parameter |
| `GitHubOidcProvider` | `AWS::IAM::OIDCProvider` | **Conditional**: created only if parameter `ExistingGitHubOidcProviderArn` is empty (an account has one provider per URL; an existing one is referenced, never managed) |
| `CiRole` | `AWS::IAM::Role` | DD-24 trust: exact `StringEquals` on `aud`, `repository_id`, `repository_owner_id`, `environment`, `job_workflow_ref` (platform reusable workflow at a pinned SHA), the default `sub` and the bound `ref` (SR-4, parameter `GitHubBoundRef`); permissions: `ecr:GetAuthorizationToken`, push to the **parameterized** ECR repository ARN only, `sqs:SendMessage` to `DeployQueue` only; `MaxSessionDuration` 3600 |
| `ExecutorRole` | `AWS::IAM::Role` | Trust: the owner's principal (parameter) for the local assume-role in Gate B; later the server's principal (Gate C, OD-Q12). Permissions: consume/visibility/send on `DeployQueue`; DynamoDB on `ExecutionsTable` (+ index); `secretsmanager:DescribeSecret` on the parameterized secret prefix and `GetSecretValue` on the SSH, Slack and identifier secrets only; CloudWatch Logs and `PutMetricData` (namespace-conditioned). **No** ECR, S3, Lambda, CodeBuild or application secrets |
| `OperatorRole` | `AWS::IAM::Role` | `sqs:SendMessage` only |
| `SchedulerRole` + `ReconcileSchedule` | `AWS::IAM::Role` + `AWS::Scheduler::Schedule` | `RECONCILE_TICK` every 5 min to `DeployQueue`; created **disabled** by default (parameter) so the owner enables it deliberately |
| `ExecutorLogGroup` | `AWS::Logs::LogGroup` | 30-day retention |
| Alarms | `AWS::CloudWatch::Alarm` ×5 | DLQ > 0; oldest message > 10 min; heartbeat missing; `RejectedRequests{reason=UNAUTHORIZED_SENDER}` > 0; `ExecutionsPastDeadline` > 0. Optional SNS topic ARN parameter for notifications |
| ECR | Parameter `CiEcrRepositoryArn` points at an existing owner-chosen repository; when it is left empty the stack creates the immutable-tag probe repository `cicd-poc-<Stage>-probe` (lifecycle: keep the 100 most recent images, SR-5) and uses it. One parameter decides (B1 lint fix, 2026-10-07: the former `CreateProbeEcrRepository` flag let an empty ARN reach an ARN-typed policy resource, cfn-lint W1030) |
| Outputs | — | Queue URL, DLQ URL, table name, role ARNs, OIDC provider ARN — consumed by the documentation's configuration steps |

**Not in the template:** Secrets Manager secret values. The owner creates them with documented commands, so values never pass through CloudFormation.

---

## 6. Documentation to be generated (`docs/gate-b/`)

| Document | Content |
|---|---|
| `README.md` | The 11-step owner sequence, prerequisites, milestone map, what Claude did vs what the owner does, evidence checklist |
| `01-aws-sam.md` | Template review guide; `sam validate --lint`; `sam deploy` with the example config (`--guided` alternative); `aws cloudformation describe-stacks` / `describe-stack-resources` inspection; drift detection; outputs to note |
| `02-secrets.md` | Secret naming convention (`CICD_SECRET_ID_PREFIX` + ref); exact `aws secretsmanager create-secret` / `put-secret-value` commands with placeholder values; connection identity JSON shape `{host, port?, user}`; host key format; Slack token; how to verify existence with `describe-secret` |
| `03-github.md` | Where the caller workflow goes (`.github/workflows/<name>.yml` in the owner-chosen repo); values to change; GitHub Environment creation; deployment branch rules; admin-only `CICD_BOUND_REF`; the five Environment variables of §12 (no secret), and their sources (stack outputs); required branch protection; the platform repository/reusable workflow visibility requirement and the pinned SHA; `workflow_dispatch` trigger; how to verify OIDC (workflow log step) and SQS submission (`aws sqs get-queue-attributes` approximate count, Executor log) |
| `04-definitions-and-target.md` | Parameter table the owner fills (§7); copying the examples into the local definitions root; `npm run definitions:check`; mapping each logical ref to its secret |
| `05-run-executor-node22.md` | Portable Node 22 (download, checksum verification, unzip into `executor/.local/node22/`, no PATH change); `npm ci` + `npm run build`; `executor.env`; AWS profile with `role_arn` + `source_profile` (no static keys); start command; expected startup output; safe stop (Ctrl+C / SIGTERM → ordered shutdown); verifying consumption (log lines, queue attributes, heartbeat metric); troubleshooting (credentials, region, missing secrets, definitions refused, Node version, clock skew, proxy) |
| `06-target-validation.md` | Owner-run SSH preflight, `target-probe.sh`, `executor-ssh-probe`; expected outputs; what must be true before B5 |
| `07-verification.md` | How to read DynamoDB state (`get-item` / query commands), CloudWatch log queries, metrics, Slack thread, DLQ; expected evidence per milestone |
| `08-teardown.md` | Order: stop the Executor → disable schedule → empty queues (optional) → `sam delete` / `aws cloudformation delete-stack` → delete secrets (recovery window) → remove GitHub Environment/secrets/workflow → remove the target's probe files and the deploy user's key → delete local `executor/.local` files. Notes on the retained/pre-existing OIDC provider |

---

## 7. Target parameters the owner supplies

| Parameter | Where it goes | Notes |
|---|---|---|
| `deploymentId` | Deployment Definition | Semantic id (e.g. `<OWNER_DEPLOYMENT_ID>`); must be unique; one per `lockKey` |
| `targetRef` | Deployment Definition → Target Registry | Logical ref, e.g. `<OWNER_TARGET_REF>` |
| `lockKey` | Target Registry | One deployment per lockKey (DD-27) |
| Hostname | Secret (connection identity JSON) | Never in Git |
| SSH port | Secret (connection identity JSON, optional, default 22) | |
| SSH username | Secret (connection identity JSON) | A dedicated deploy user is recommended |
| Host-key fingerprint / public key | Secret (`hostKeyRef`) | Obtained out of band and compared with `ssh-keyscan` output (documented) |
| Credential reference | Secret (`credentialRef`) | Private key; password only if FR-12's temporary marker existed — it does not (G-1), so key only |
| Deployment script | Deployment Definition `deployScript` | `deploy-container.sh` (the only approved script) |
| Artifacts / units | Deployment Definition `artifacts[]` | `unit`, `container`, `imageRepositoryRef` (secret holds the repository URI) |
| Runtime secrets | `runtimeSecretRefs` | Passed through unresolved (OD-Q5 open) |
| Health | `health` per container | Command or URL ref |
| Source binding | `source.repositoryRef/workflowRef/environmentRef`, `allowedSenderRef` | Values in secrets; `allowedSender` = the CI role ID (stack output) |
| Deploy window policy | Target Registry | `none` or `required` + external deployers |

---

## 8. Local validation Claude may run

- `npm run check:local`, `npm run validate -- --require-workflow`, unit, contract and integration tests (DynamoDB Local / ElasticMQ are local emulators).
- Static SAM template tests (K-1).
- **SAM CLI and cfn-lint are not installed on this workstation.** Options for you:
  - **Owner decision: option (b).** No SAM CLI or cfn-lint is installed in B0. `sam validate --lint` is an **owner-executed checkpoint at the start of B1** and its status stays **NOT EXECUTED** until the owner provides the result. If it fails, Gate B pauses before any AWS deployment.
- No AWS CLI call of any kind is made by Claude, read-only included, unless you ask for a specific one.

---

## 9. Every step that requires manual owner execution

1. Review `infra/sam/template.yaml` and the parameter file.
2. Run `sam validate --lint` (checkpoint B), review its result (C), and only then `sam deploy` with the example configuration (D) — §11.
3. Inspect stack resources and record the outputs.
4. Create the Secrets Manager entries (connection identity, host key, SSH key, Slack token, identifier refs) with the documented commands.
5. Configure the local AWS profile that assumes the Executor role.
6. Download and verify the portable Node 22; `npm ci`, `npm run build`.
7. Fill `executor.env` and the local definitions root; run `npm run definitions:check`.
8. Start the Executor locally; verify startup, heartbeat and queue consumption.
9. In the chosen GitHub repository: create the Environment, deployment branch rules, admin-only `CICD_BOUND_REF`, the five Environment variables (no secret, §12); add the caller workflow to the chosen branch.
10. Trigger the workflow with `workflow_dispatch`; observe OIDC, SQS submission and the Executor log.
11. Run the documented negative checks (untrusted triggers, wrong sender, poison message).
12. Enable the reconcile schedule when ready.
13. Run the SSH preflight, `target-probe.sh` on the target and `executor-ssh-probe`.
14. Decide OD-Q5, then (optional) perform the controlled deployment (B5) in a window if required.
15. Verify state, logs, metrics, Slack and the outcome with the documented queries.
16. Share the outputs with Claude for evidence checking.
17. Tear down with the documented commands if desired.

---

## 10. Evidence to declare Gate B complete

- **B0:** kit committed; all local gates green; SAM template contract tests green; `sam validate --lint` recorded as NOT EXECUTED (owner-executed at B1, checkpoint B).
- **B1–B5:** owner-run outputs (sanitized) recorded per milestone against the expected evidence in §3; premises pinned or refuted; negatives observed. Milestones the owner chooses not to run are recorded as **not executed**, never as passed.

Gate C keeps permanent hosting and operational readiness (container image build and inspection, the Executor on the designated server under OD-Q11/OD-Q12, env-key parity, PRMS Reporting DEV end to end with Jenkins coexistence).

---

## 11. Owner clarifications (2026-10-06)

**SAM validation and deployment are separate checkpoints** (never one operation):

| Checkpoint | Who | Gate to the next |
|---|---|---|
| **A.** Review the generated SAM template and parameter file | Owner | Owner satisfied with resources, IAM and parameters |
| **B.** Run `sam validate --lint` | Owner | Command exits 0 with no lint errors |
| **C.** Review the validation result (share output with Claude if anything is reported) | Owner (+ Claude for corrections) | Clean result; any failure pauses Gate B and returns to B0 for correction |
| **D.** Only then, run the documented `sam deploy` | Owner | Stack `CREATE_COMPLETE`; outputs recorded |

Until the owner reports checkpoint B, its status is **NOT EXECUTED**.

## 12. GitHub values classification (no static AWS keys; OIDC only)

| Value | Class | Rationale |
|---|---|---|
| `CICD_ROLE_ARN` | Environment variable | **Not a secret (owner, 2026-10-06, G-10):** not a credential; access is controlled by the OIDC trust. It and the account ID may appear in public logs |
| `CICD_AWS_REGION` | Environment variable | Non-sensitive |
| `CICD_ECR_REPOSITORY` (repository name only) | Environment variable | Non-sensitive; no account ID |
| `CICD_DEPLOY_QUEUE_NAME` (queue name only) | Environment variable | Non-sensitive; the URL is derived |
| `CICD_BOUND_REF` | Environment variable (admin-only) | Trusted bound ref (E1, P-G13) |
| ECR registry host | **Derived** after OIDC (registry login output) | Not stored in GitHub |
| Queue URL | **Derived** after OIDC (`sqs:GetQueueUrl` on the deploy queue only) | Not stored in GitHub |
| AWS account ID | Part of the role ARN variable | Not a credential; may appear in logs |
| GitHub Environment name, deployment branch rules, branch protection, (prod) required reviewers | Repository/Environment configuration | Not values |
| `deploymentId`, `environment`, `units` | Caller workflow inputs | Non-sensitive, in the caller file |

**The GitHub configuration contains no secret and no AWS credential; AWS authentication is OIDC only (G-10, 2026-10-06).** This replaces the earlier "five Environment secrets" model (DD-24 text amended under owner direction; the reusable workflow, its contract test and the CI role's `sqs:GetQueueUrl` permission change accordingly in K-1/K-5).

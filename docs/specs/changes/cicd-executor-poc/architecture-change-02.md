# Architecture Change 02 — Runtime multi-project Target Registry (V1)

| Field | Value |
|---|---|
| Status | **Decision adopted by the owner (2026-10-07)** and **simplified for V1 the same day** (owner decisions: no Deployment Definitions in V1; the deploy script lives on the target server; one CI role shared by the authorized repositories; V1-R1 resolved by option A, a source binding through an IAM-enforced role session name, conditional on the real B2 validation of P-R1 and P-R2). Spec update recorded in design v5.0, requirements v4.0 and tasks §6.0.3; **pending owner validation of the spec text**. Implementation not started. No AWS or GitHub change |
| Owner intent | The Executor is agnostic to project and server. PRMS, STAR, MARLO, CLARISA and future projects (about 50) are target records. Adding or changing a server never modifies, rebuilds or redeploys the Executor |
| Scope | A functional, generic and small V1: locate the server, connect securely, run the authorized script. Future Jenkins-replacement capabilities are not designed here |

## 1. Decision (V1)

1. **No Deployment Definitions in V1.** The Executor does not model containers, application ports, migrations, migration compatibility, health checks, runtime configuration or any other internal detail of a deployment. `deploymentId` disappears from the request; the `targetId` is the deploy identity.
2. **Target Registry = where and how to connect.** A separate DynamoDB table `cicd-registry-<stage>`, one item per `targetId`, holding only what is needed to locate the server, connect securely and run the authorized script (§3). It is not bundled in the image.
3. **`DEPLOY_REQUESTED` carries a `targetId`** and the minimal execution and artifact data (commit, digests, CI audit and ordering metadata). It never carries a host, port, user, credential, key, script, script path or command.
4. **The Executor resolves the target with one `GetItem`.** Missing → `REJECTED (TARGET_UNKNOWN)`; schema-invalid → `REJECTED (TARGET_INVALID)`; request from a repository other than the target's `sourceRepositoryId` → `REJECTED (TARGET_NOT_AUTHORIZED)` (decision 6).
5. **The deploy script lives on the target server.** The record's `deployScript` is the absolute path of a script installed by the target's administrator; it is trusted registry configuration, never request data. The script owns all application-specific logic (pull by digest from its own repositories, runtime configuration, migrations, container swap, health check, cleanup). The Executor delivers no file (no SFTP upload, no checksum) and runs the script with a fixed, escaped argument vector.
6. **One CI role shared by the authorized repositories** (owner decision 2026-10-07: about 50 projects; no IAM role per repository). Its trust policy keeps the OIDC restrictions of DD-24 for the authorized repositories and the pinned reusable workflow. The Executor accepts `DEPLOY_REQUESTED` only from that role (SQS `SenderId`, DD-25). **Source binding, option A (owner decision 2026-10-07, conditional on B2):** the trust policy additionally requires `sts:RoleSessionName` = `${token.actions.githubusercontent.com:repository_id}`, and the reusable workflow sets `role-session-name` to the run's `repository_id`. SQS reports `SenderId` = `<CI role ID>:<repository_id>`. The Executor authorizes the role ID (DD-25) and then requires the session suffix to equal the target record's `sourceRepositoryId`, **before** dedupe, sequence, `highestAccepted`, `highestDispatched`, locks or any other target state change (§3, V1-R1).
7. **Secrets Manager stores only sensitive material:** the SSH credential referenced by `credentialRef` (and the platform Slack token). Host, port, user and host key are inline registry values, never secrets. The credential is read only when connecting, kept in memory only, never in the request, DynamoDB, logs or artifacts. Strict host-key checking; never `StrictHostKeyChecking=no`.
8. **The Executor has read-only access to the registry (`dynamodb:GetItem` only).** Registry writes use a different, administrative principal — never the Executor role, never the CI role.
9. **GitHub Actions stays CI-only** and is configured by the repository owners. The platform provides the reusable workflow and exact instructions; it never creates or modifies workflows in application repositories. OIDC only, no static AWS keys.

## 2. Unchanged

SQS and sender authorization by `SenderId` (DD-25 rule), closed state machine, dedupe, supersede ordering (DD-27), distributed lock with fencing, target mutex taken by the script, deploy windows, digest-only artifacts, SSH with strict host-key pinning, Secrets Manager for credentials, Scheduler, the existing state table (`cicd-executions-<stage>`), the exit-code and `CICD_RESULT` contract of the script.

## 3. V1 model

**Target record** (`TARGET#{targetId}` / `META`; normative list in design §6.3):

| Field | Purpose |
|---|---|
| `targetId`, `project`, `environment` | Identity (`project` and `environment` are descriptive) |
| `host`, `port`, `user` | SSH destination (port default 22) |
| `hostKey` | Pinned host key (OpenSSH public-key lines), strict |
| `credentialRef` | Secrets Manager reference of the SSH credential, under the Executor's secret prefix |
| `deployScript` | Absolute path of the deploy script on the target |
| `deployWindowPolicy` | `required` or `not-required`; mandatory, no default (FR-24) |
| `sourceRepositoryId` | GitHub `repository_id` (immutable numeric ID) of the single repository allowed to deploy this target (option A) |
| `schemaVersion`, `version`, `updatedAt`, `updatedBy` | Audit and conditional writes by the onboarding tool |

**Identity mapping.** The `targetId` replaces `deploymentId` (dedupe scope, sequence, `executionId`) and `lockKey` (distributed lock, target mutex, supersede ordering, deploy windows, target state). `allowedDeploymentIds`, `lockKey`, `containers`, `externalDeployers`, `migrationCompatibility` and `attestedBy` are **not** part of the V1 record.

**Request:** `specVersion, eventType, requestId, targetId, commitSha, artifacts{unit: sha256 digest}, ci{repository, workflowRef, runId, runAttempt, runNumber}`.

**Snapshot.** At acceptance (X1) the record's non-secret fields and `version` are written on the Execution item; retries, reconciliation and dispatch use the snapshot, so editing or deleting a record never changes an in-flight execution.

**Flow:** authorized GitHub Actions run → shared CI role (OIDC; session name = `repository_id`, enforced by IAM) → SQS (`SenderId` = role ID + `repository_id`) → Executor (sender = CI role, schema, `GetItem TARGET#{targetId}`, validate, session `repository_id` = `sourceRepositoryId`, then dedupe, order, window, lock) → Secrets Manager (`credentialRef`, at connect) → SSH (pinned host key) → `deployScript` on the target.

## 4. Residual risks and open points (not resolved by assumption)

| ID | Point |
|---|---|
| V1-R1 | **Shared CI role: cross-project deploy — resolved by option A (owner decision 2026-10-07), conditional on B2.** Without a source binding, every authorized repository presents the same role ID and `ci.*` is self-asserted, so any of them could deploy an image (pushed with the shared ECR permission) on another project's target, block that target's ordering with a higher `runNumber` (no reset in the PoC, OD-A8) or pre-claim its `requestId`. **Option A:** the IAM-enforced role session name carries the GitHub `repository_id` into `SenderId`, and the Executor requires it to equal the record's `sourceRepositoryId` before any target state change; a mismatch is `REJECTED (TARGET_NOT_AUTHORIZED)`, recorded under the message identity (`REJECT#MSG#{sqsMessageId}`), with no dedupe item, sequence, `highestAccepted`, `highestDispatched`, lock or window effect. Cross-project image injection is closed for Executor deploys: another repository can still push into a project's ECR repository (shared role) but cannot request its deploy, and a target deploys only digests from its own source. Residual: that push can also create or overwrite mutable tags in another project's repository, which Jenkins deploys use during coexistence (tag immutability is OD-A7). **Premises, pending real validation in B2 (`UNVERIFIED`):** **P-R1** — `sts:RoleSessionName` is evaluated in the trust policy for `AssumeRoleWithWebIdentity`; **P-R2** — `${token.actions.githubusercontent.com:repository_id}` resolves as a policy variable in that trust policy. Both fail closed (an absent key or variable makes `StringEquals` not match, so the assumption is denied). **Gate:** no second repository is added to the CI role trust until both the positive test (session name = `repository_id` assumes the role, and the real SQS `SenderId` shows that suffix) and the negative test (any other session name is denied by STS) pass on the real workflow. **If either premise fails, option A is discarded and option B (a GitHub OIDC token with a dedicated audience in the message, verified by the Executor; SR-2 proposal) is evaluated;** no other mechanism is designed now |
| V1-R2 | **Single source per target.** With option A the repository level is enforced by `sourceRepositoryId`. Within that repository, supersede ordering compares `ci.runNumber`, which is only meaningful for one caller workflow; using a single caller workflow per target remains a configuration rule |
| V1-R3 | **Script integrity and conformance are the server's responsibility.** The Executor does not deliver or checksum the script. The script, its parent directories and every file it sources or reads as configuration (image repositories, runtime configuration) must be owned by an administrator and not writable by the deploy user; an attacker who can modify any of them controls the deploy. If the deploy user can run `docker` directly it is root-equivalent and this restriction is moot. The script must implement the §6.5 interface, **including the target mutex** (second lock layer, DD-22), derived from the reference script and verified at onboarding (task R-7). Restricting the deploy key to the script path (`command=` / `ForceCommand`) is an owner option, not adopted |
| V1-R4 | **Trust policy scale.** Listing about 50 repositories by exact `StringEquals` values may exceed the default IAM trust-policy size quota. Not needed for the PoC (one repository); to be designed before onboarding many repositories |
| V1-R5 | **Deploy windows without modeled external deployers.** The window's `externalJobsDisabled[]` is recorded for audit; that it covers every external deployer is attested by the operator (runbook), not checked by the Executor |
| AC2-1 | Table name: the owner text said `cicd-state-<stage>` for the state table; the deployed table is `cicd-executions-<stage>`. Renaming would replace the table (data loss, new resource). The spec keeps the deployed name |
| AC2-4 | Registry write access is equivalent to redirecting a target's deploys to another host or script and, with option A, to choosing which repository may deploy it (`sourceRepositoryId`). Restricted to the administrative principal; PITR on; CloudTrail data events optional |
| AC2-6 | Startup still checks that the platform Slack token secret exists. Without a real Slack bot the Executor cannot start; unchanged by AC-02 and an owner decision |
| AC2-7 | **Narrowed.** No definition references remain. The platform configuration still uses non-secret identifier references (the CI, Executor, Scheduler and Operator role IDs and the Slack channel), resolved through Secrets Manager as today until the owner decides otherwise |

AC2-2, AC2-3 and AC2-5 of the first AC-02 draft are obsolete in V1 (no `allowedDeploymentIds`, no cross-target `lockKey` or port invariants, no health URLs in the platform).

# Architecture Change 02 — Runtime multi-project Target Registry (V1)

| Field | Value |
|---|---|
| Status | **Decision adopted by the owner (2026-10-07)** and **simplified for V1 the same day** (owner decisions: no Deployment Definitions in V1; the deploy script lives on the target server; one CI role shared by the authorized repositories). Spec update recorded in design v5.0, requirements v4.0 and tasks §6.0.3; **pending owner validation of the spec text**. Implementation not started. No AWS or GitHub change |
| Owner intent | The Executor is agnostic to project and server. PRMS, STAR, MARLO, CLARISA and future projects (about 50) are target records. Adding or changing a server never modifies, rebuilds or redeploys the Executor |
| Scope | A functional, generic and small V1: locate the server, connect securely, run the authorized script. Future Jenkins-replacement capabilities are not designed here |

## 1. Decision (V1)

1. **No Deployment Definitions in V1.** The Executor does not model containers, application ports, migrations, migration compatibility, health checks, runtime configuration or any other internal detail of a deployment. `deploymentId` disappears from the request; the `targetId` is the deploy identity.
2. **Target Registry = where and how to connect.** A separate DynamoDB table `cicd-registry-<stage>`, one item per `targetId`, holding only what is needed to locate the server, connect securely and run the authorized script (§3). It is not bundled in the image.
3. **`DEPLOY_REQUESTED` carries a `targetId`** and the minimal execution and artifact data (commit, digests, CI audit and ordering metadata). It never carries a host, port, user, credential, key, script, script path or command.
4. **The Executor resolves the target with one `GetItem`.** Missing → `REJECTED (TARGET_UNKNOWN)`; schema-invalid → `REJECTED (TARGET_INVALID)`.
5. **The deploy script lives on the target server.** The record's `deployScript` is the absolute path of a script installed by the target's administrator; it is trusted registry configuration, never request data. The script owns all application-specific logic (pull by digest from its own repositories, runtime configuration, migrations, container swap, health check, cleanup). The Executor delivers no file (no SFTP upload, no checksum) and runs the script with a fixed, escaped argument vector.
6. **One CI role shared by the authorized repositories** (owner decision 2026-10-07: about 50 projects; no IAM role per repository). Its trust policy keeps the OIDC restrictions of DD-24 for the authorized repositories and the pinned reusable workflow. The Executor accepts `DEPLOY_REQUESTED` only from that role (SQS `SenderId`, DD-25). This amendment adds **no per-target sender list and no repo→target authorization**; whether one is strictly necessary is escalated to the owner as V1-R1 (§4), not decided here.
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
| `schemaVersion`, `version`, `updatedAt`, `updatedBy` | Audit and conditional writes by the onboarding tool |

**Identity mapping.** The `targetId` replaces `deploymentId` (dedupe scope, sequence, `executionId`) and `lockKey` (distributed lock, target mutex, supersede ordering, deploy windows, target state). `allowedDeploymentIds`, `lockKey`, `containers`, `externalDeployers`, `migrationCompatibility` and `attestedBy` are **not** part of the V1 record.

**Request:** `specVersion, eventType, requestId, targetId, commitSha, artifacts{unit: sha256 digest}, ci{repository, workflowRef, runId, runAttempt, runNumber}`.

**Snapshot.** At acceptance (X1) the record's non-secret fields and `version` are written on the Execution item; retries, reconciliation and dispatch use the snapshot, so editing or deleting a record never changes an in-flight execution.

**Flow:** authorized GitHub Actions run → shared CI role (OIDC) → SQS → Executor (sender = CI role, schema, `GetItem TARGET#{targetId}`, validate, dedupe, order, window, lock) → Secrets Manager (`credentialRef`, at connect) → SSH (pinned host key) → `deployScript` on the target.

## 4. Residual risks and open points (not resolved by assumption)

| ID | Point |
|---|---|
| V1-R1 | **Shared CI role: cross-project deploy (OPEN — escalated to the owner; not accepted by assumption).** Every authorized repository presents the same role ID and the request body (`ci.*`) is self-asserted, so the Executor cannot tell which repository sent a request. **Consequences:** (a) any authorized repository — anyone who can push to its bound branch or alter its workflow inputs — can push an image into **another project's** ECR repository (the shared role's push covers every application repository) and send `DEPLOY_REQUESTED` naming that project's `targetId` with that digest; the target's script then pulls and runs that image with the target's runtime configuration: compromising one repository means code execution on every target. The script pulling "only from its own repositories" does **not** mitigate this, because the shared role can write those repositories. (b) A request naming another target with a higher `runNumber` that reaches X9 raises that target's `highestDispatched` even if it then fails, so the target's legitimate source is superseded permanently; there is no reset in the PoC (OD-A8 open); a caller typo in the `targetId` is enough. (c) It can pre-claim another target's `requestId`. **What still holds:** only the authorized repositories, the pinned reusable workflow and the bound ref can assume the role (DD-24); `ci.repository` is recorded for audit. **Exposure is zero while the trust policy admits a single repository (the PoC); onboarding a second repository is gated on the owner's decision.** Candidate remedies for the owner (none adopted): per-repository ECR push scoping inside the one role through OIDC session tags or policy variables (premise `UNVERIFIED`); GitHub-signed provenance (SR-2 proposal); an expected-source field in the target record (catches honest misconfiguration only, not a compromise); per-repository roles (declined by the owner for V1) |
| V1-R2 | **Single source per target is a configuration rule.** Supersede ordering compares `ci.runNumber` per `targetId` and is only meaningful when exactly one repository and workflow deploys a target. With the shared role the Executor cannot verify it; the onboarding procedure and the caller configuration must keep it |
| V1-R3 | **Script integrity and conformance are the server's responsibility.** The Executor does not deliver or checksum the script. The script, its parent directories and every file it sources or reads as configuration (image repositories, runtime configuration) must be owned by an administrator and not writable by the deploy user; an attacker who can modify any of them controls the deploy. If the deploy user can run `docker` directly it is root-equivalent and this restriction is moot. The script must implement the §6.5 interface, **including the target mutex** (second lock layer, DD-22), derived from the reference script and verified at onboarding (task R-7). Restricting the deploy key to the script path (`command=` / `ForceCommand`) is an owner option, not adopted |
| V1-R4 | **Trust policy scale.** Listing about 50 repositories by exact `StringEquals` values may exceed the default IAM trust-policy size quota. Not needed for the PoC (one repository); to be designed before onboarding many repositories |
| V1-R5 | **Deploy windows without modeled external deployers.** The window's `externalJobsDisabled[]` is recorded for audit; that it covers every external deployer is attested by the operator (runbook), not checked by the Executor |
| AC2-1 | Table name: the owner text said `cicd-state-<stage>` for the state table; the deployed table is `cicd-executions-<stage>`. Renaming would replace the table (data loss, new resource). The spec keeps the deployed name |
| AC2-4 | Registry write access is equivalent to redirecting a target's deploys to another host or script. Restricted to the administrative principal; PITR on; CloudTrail data events optional |
| AC2-6 | Startup still checks that the platform Slack token secret exists. Without a real Slack bot the Executor cannot start; unchanged by AC-02 and an owner decision |
| AC2-7 | **Narrowed.** No definition references remain. The platform configuration still uses non-secret identifier references (the CI, Executor, Scheduler and Operator role IDs and the Slack channel), resolved through Secrets Manager as today until the owner decides otherwise |

AC2-2, AC2-3 and AC2-5 of the first AC-02 draft are obsolete in V1 (no `allowedDeploymentIds`, no cross-target `lockKey` or port invariants, no health URLs in the platform).

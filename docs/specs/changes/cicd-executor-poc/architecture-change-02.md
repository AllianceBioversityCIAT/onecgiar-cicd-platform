# Architecture Change 02 — Runtime multi-project Target Registry

| Field | Value |
|---|---|
| Status | **Decision adopted by the owner (2026-10-07).** Spec update recorded in design v4.9, requirements v3.8 and tasks; **pending owner validation of the spec text**. Implementation not started. No AWS or GitHub change |
| Owner intent | The Executor is agnostic to project and server. PRMS, STAR, MARLO, CLARISA and future projects are target records. Adding or changing a server never modifies, rebuilds or redeploys the Executor |
| Scope | Decouple the Target Registry from the Executor image and make targets dynamic. Nothing else is redesigned |

## 1. Decision

1. **Deployment Definition = what and how to deploy.** Versioned, Git-reviewed, bundled in the image (DD-19 unchanged for definitions). It no longer contains a `targetRef`.
2. **Target Registry = where to deploy.** A separate DynamoDB table `cicd-registry-<stage>`, one item per `targetId`, with the non-sensitive connection metadata **inline**. It is no longer a YAML file in the image.
3. **`DEPLOY_REQUESTED` carries a `targetId`.** It never carries a host, port, user, credential, key, script or command.
4. **The Executor resolves the target with one `GetItem`** and authorizes it: the target exists, its `allowedDeploymentIds` contains the request's `deploymentId`, the environments match, and the existing CI sender authorization (DD-25) passes. Any failure → `REJECTED`.
5. **Secrets Manager stores only sensitive material** for targets: the SSH credential referenced by `credentialRef` (the Slack bot token is also a credential). Host, port, user, host key and the other target values are inline in the registry, never secrets.
6. **The Executor has read-only access to the registry (`dynamodb:GetItem` only).** Registry writes use a different, administrative principal — never the Executor role, never the CI role.
7. **GitHub Actions stays CI-only** and is configured by the repository owners. The platform provides the reusable workflow, templates and exact instructions; it never creates or modifies workflows in application repositories. OIDC only, no static AWS keys.

## 2. Unchanged

SQS and sender authorization (DD-25 rule), state machine, dedupe, ordering (DD-27, per `lockKey`), distributed lock and fencing, target mutex, deploy windows, ECR by digest (DD-26), SSH/SFTP transport with strict host-key pinning and checksum, `deploy-container.sh`, Secrets Manager for credentials, bundled Deployment Definitions and schemas, Scheduler, the existing state table (`cicd-executions-<stage>`).

## 3. Target record

See design §6.3 for the normative field list and rules. The record is **snapshotted on the Execution item at acceptance (X1)**; retries, reconciliation and dispatch use the snapshot, so editing or deleting a record never changes an in-flight execution. `DEPLOY_WINDOW_OPEN_REQUESTED` names the `targetId`. Credential secrets live under the Executor's existing secret prefix, so a new target needs no IAM change.

## 4. Open points recorded for the owner (not resolved by assumption)

| ID | Point |
|---|---|
| AC2-1 | Table name: the owner text says `cicd-state-<stage>` for the state table; the deployed table is `cicd-executions-<stage>`. Renaming would replace the table (data loss, new resource). The spec keeps the deployed name |
| AC2-2 | `allowedDeploymentIds` is a list, but DD-27 allows exactly one `deploymentId` per `lockKey` and a target has one `lockKey`. For the PoC the list holds exactly one entry; several deployments per target require revisiting DD-27 |
| AC2-3 | Cross-target invariants (one deployment per `lockKey`, no port or container-name conflict per host) were checked at startup over the bundled registry. With `GetItem`-only access, they are enforced by the administrative onboarding tool at write time |
| AC2-4 | Registry write access is equivalent to redirecting the authorized deployments to another host. Restricted to the administrative principal; PITR on; CloudTrail data events optional |
| AC2-5 | Health URLs are host-specific but stay in the definition (resolved as decided in AC2-7). Correct while each deployment has one target; a deployment served by several targets would need per-target health URLs |
| AC2-7 | **Owner decision pending:** the bundled definitions and the platform configuration still use non-secret references (source binding, CI role ID, image repository URI, Slack channel, health URL, Executor/Scheduler/Operator role IDs). Today they resolve from Secrets Manager. Options: keep them there; move them to registry `CONFIG#<NAME>` items (note: whoever writes the registry would then also control `allowedSender` and the principal IDs, widening AC2-4); or another store. Not adopted by this change |
| AC2-6 | Startup still checks that the Slack token secret exists (platform and definition `tokenRef`). Without a real Slack bot the Executor cannot start; this is unchanged by AC-02 and remains an owner decision |

<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §3, §6, §9, §11, §12 -->
# Gate B owner runbook (integration run B1 to B5)

**Answer first.** This folder is the sequence you, the owner, follow to deploy the DEV foundation
with SAM, create the secrets, run the Executor on your workstation under Node 22, connect one
GitHub repository through OIDC, and validate the target over SSH. Claude prepared the kit and
ran **none** of it. Every command here is for you to run, one step at a time, stopping at each
"Stop if" line.

> Placeholders in angle brackets (`<AWS_ACCOUNT_ID>`, `<AWS_REGION>`, `<AWS_PROFILE_ADMIN>`,
> `<TARGET_HOST>`, `<GITHUB_ORG>/<APP_REPO>`, ...) are values only you hold. Never commit them
> and never paste them into a public issue, log or chat (publication policy, design DD-23).

## Who does what

| Claude (B0, done, committed after review) | You (B1 to B5, now) |
|---|---|
| Wrote the SAM template, example parameters, secrets provider, offline definitions check, example definitions, caller workflow example, run scripts, probe tools and this runbook | Run every external command: AWS, SAM, GitHub, SSH, the Executor |
| Ran only local, non-mutating checks (tests, static template tests, guards) | Decide each owner decision and each checkpoint |
| Will compare the evidence you share back with the expected evidence and record it in `execution.md` | Share sanitized outputs (see "Evidence to share back") |

## Milestone map

| Milestone | What you prove | Documents |
|---|---|---|
| **B1** AWS foundation | Stack deployed, secrets created, Executor starts under Node 22 with a role it assumes | [01](01-aws-sam.md), [02](02-secrets.md), [04](04-definitions-and-target.md), [05](05-run-executor-node22.md), [07](07-verification.md) |
| **B2** GitHub OIDC to SQS to local Executor | A `workflow_dispatch` run assumes the CI role, enqueues one request, the Executor accepts it and ends `FAILED (DEPLOY_WINDOW_CLOSED)` with the window closed (no SSH); untrusted triggers fail | [03](03-github.md), [07](07-verification.md) |
| **B3** State, dedupe, locks | Re-run behavior, `SUPERSEDED` for an older build, poison message to the DLQ with the alarm | [07](07-verification.md) |
| **B4** SSH (non-destructive) | Host key pinned and a mismatch rejected, `flock` busy detection, fresh 0700 directory, checksum, parsed `CICD_RESULT` | [06](06-target-validation.md) |
| **B5** One controlled deployment (optional; needs OD-Q5) | `SUCCEEDED`, Slack thread, `lastDeployed` fenced | [07](07-verification.md) |
| Teardown (optional) | Everything removed in a safe order | [08](08-teardown.md) |

Milestones you choose not to run are recorded as **not executed**, never as passed.

## Prerequisites

1. An AWS account you may deploy IAM roles into, a profile `<AWS_PROFILE_ADMIN>` for it (prefer SSO), and a region `<AWS_REGION>`.
2. AWS CLI v2 and AWS SAM CLI installed on your workstation. (Neither is installed by this kit; Claude's workstation has neither.)
3. A GitHub repository `<GITHUB_ORG>/<APP_REPO>` and a branch `<BOUND_BRANCH>` you may configure (no application repository is changed by Claude), and admin rights to create an Environment `<GITHUB_ENVIRONMENT>`.
4. The platform repository `<GITHUB_ORG>/<PLATFORM_REPO>` containing the reusable workflow `.github/workflows/deploy-request.reusable.yml`, **pushed**, and its full 40-hex commit SHA `<PINNED_COMMIT_SHA>` (needed by the stack before you deploy).
5. The immutable numeric repository id and owner id (read-only lookups are in [03](03-github.md)).
6. A target host and a dedicated deploy user for B4/B5 (parameters in [04](04-definitions-and-target.md)); a Slack bot token and channel id.
7. Windows PowerShell 5.1 or later; Git Bash is optional. The portable Node 22 is installed at sequence step 5 (no prerequisite install).

## The owner sequence

| # | Step | Document | Checkpoint or evidence |
|---|---|---|---|
| 1 | Review the template and parameters (checkpoint **A**) | [01](01-aws-sam.md) | Your own approval |
| 2 | `sam validate --lint` (checkpoint **B**) and review the result (**C**) | [01](01-aws-sam.md) | Exit 0, no lint output. Anything else pauses Gate B |
| 3 | `sam deploy` (checkpoint **D**), record the stack outputs, check drift | [01](01-aws-sam.md) | `CREATE_COMPLETE`, outputs |
| 4 | Create the Secrets Manager secrets | [02](02-secrets.md) | `describe-secret` per ref |
| 5 | Install portable Node 22, `npm ci`, `npm run build` | [05](05-run-executor-node22.md) (sections 1 and 2) | Node `v22.x`, `dist/` built |
| 6 | Fill the local definitions root, run `definitions:check`; then the AWS profile, env file and `-DryRun` | [04](04-definitions-and-target.md), [05](05-run-executor-node22.md) (sections 3 to 5) | `OK` per deployment, `-DryRun` output |
| 7 | Start the Executor (**B1**). Keep `deployWindowPolicy: required` with **no window open** for B1 to B4 | [05](05-run-executor-node22.md), [07](07-verification.md) | `executor started` log line |
| 8 | Configure the GitHub Environment, variables, secret and caller workflow | [03](03-github.md) | Environment checklist |
| 9 | Trigger `workflow_dispatch`, run the untrusted-trigger negatives (**B2**) | [03](03-github.md), [07](07-verification.md) | Run log, execution `FAILED (DEPLOY_WINDOW_CLOSED)` |
| 10 | Dedupe, supersede and poison-message checks (**B3**) | [07](07-verification.md) | One execution per request, `SUPERSEDED`, DLQ alarm |
| 11 | Target validation (**B4**), optional deployment (**B5**), optional teardown | [06](06-target-validation.md), [07](07-verification.md), [08](08-teardown.md) | Probe outputs |

## NOT EXECUTED (status at the end of B0)

Nothing below has been run by anyone. Each stays **NOT EXECUTED** until you report the result.

| Item | Why it matters |
|---|---|
| `sam validate --lint` | Checkpoint B (plan section 11). If it fails, Gate B pauses before any deploy |
| `sam deploy`, drift detection | The template was never deployed |
| Every Secrets Manager call | Secret shapes are documented, not exercised |
| The Executor under Node 22 | Local evidence in B0 was collected on Node 20.19.5 |
| Real `flock` contention | Git Bash has no `flock`; first observation is B4 |
| Any real GitHub run, OIDC claim, SQS submission | Premises P-A3, P-A4, P-G10, P-G11, P-G14 and gaps G-3, G-4 are pinned only at B2 |
| Any SSH connection to a target | B4 |

## Evidence to share back

Share sanitized outputs (replace account ids, hosts, ARNs, queue URLs with the placeholders) so Claude can check them against the plan:

| Milestone | Share |
|---|---|
| Checkpoint B | The full `sam validate --lint` output and exit code |
| B1 | `describe-stacks` outputs table (with account id masked), `describe-secret` existence list (names only), Executor startup lines, `Get-ChildItem Env:AWS_*` result (names only) |
| B2 | Run URL or run id, public-safe job log (no credential-like value; the role ARN and account id are expected to appear, G-10), the real `job_workflow_ref` and `sub` claim values, Executor log lines for the request, `get-item` of the execution, the untrusted-trigger results |
| B3 | `get-item` results, the `SUPERSEDED` execution, the DLQ attributes and alarm state after the poison message |
| B4 | The three probe outputs, including the deliberate host-key mismatch result |
| B5 | Final execution item, Slack thread text (sanitized), forced-failure rollback result if run |

## Known limitations and open decisions

Do not work around these; they are recorded decisions or findings, not mistakes in the kit.

| ID | Limitation | Effect on your run |
|---|---|---|
| G-1 | No temporary-password marker in the target registry | SSH is key-only; no password path exists |
| G-2 | No `QUEUED -> FAILED` transition exists for configuration errors (the state machine is closed) | Startup refuses such definitions; a runtime backstop would leave the execution `QUEUED` and the tick in the DLQ. Fix definitions before starting |
| G-3 | Precedence of `CICD_BOUND_REF` across Environment, repository and organization levels is unverified (P-G13) | You check that no repository- or organization-level variable has that name ([03](03-github.md)); owner decision pending |
| G-4 | `ci.workflowRef` form (caller `workflow_ref` vs SHA-pinned `job_workflow_ref`) and what `source.workflowRef` must resolve to is unverified | Exact equality, fail closed (`CONSISTENCY_MISMATCH`); you pin it at B2 ([03](03-github.md), section 7) |
| G-6 | Metrics `ExecutionsSuperseded` and `DeployDurationMs` are not implemented, and `LockWaitMs` / `DispatchLatencyMs` are never emitted | Do not expect them in any evidence; NFR-05 evidence is due in Gate C |
| G-8 | **Resolved (owner, 2026-10-06):** `RECONCILE_TICK` has a minimal internal contract without `eventId`; the Executor generates the correlation id | The schedule is created **DISABLED**; enable it deliberately in B1 after the Executor runs ([01](01-aws-sam.md), [07](07-verification.md)) |
| G-9 | **Resolved (owner, 2026-10-06):** the Executor parses and validates every definition file at startup and refuses to start (exit 1, file and reason logged) on any problem | Run `definitions:check` first as a preflight; startup still enforces it |
| P-G11 | The `job_workflow_ref` claim form for a SHA-pinned reusable workflow call is unverified | You record the real claim at B2. If the trust does not match, the role assumption fails **closed and silently** ([03](03-github.md)) |
| P-G14 | Visibility of Environment values inside a called workflow is unverified | Observe at B2: the Environment variables reach the called job (the OIDC step uses `CICD_ROLE_ARN`); the role ARN and account id may appear (G-10) |
| K-3 | `definitions:check` does not refuse literal migration commands with line breaks or NUL bytes | The Executor refuses them at startup instead; a green check does not guarantee startup |
| ECR | One ECR repository parameter (`CiEcrRepositoryArn` or the probe repository) | Two units in two repositories need a second parameter (B5 follow-up) |
| EMF | The workstation run writes EMF metrics to stdout, which is not shipped to CloudWatch | The heartbeat, rejected-sender and past-deadline alarms have no data ([05](05-run-executor-node22.md)) |
| flock | Real `flock` contention between two sessions is unverified | First observed at B4 |
| Node 22 | Not yet observed | First observed at step 6 |
| OD-Q5, OD-Q11, OD-Q12, OD-N1, OD-A6 to OD-A8 | Open owner decisions | Not resolved by this kit; B5 needs OD-Q5 |

Related: the operator procedures in [`../runbook.md`](../runbook.md), the resource contract in
[`../../infra/RESOURCES.md`](../../infra/RESOURCES.md), the SAM template in
[`../../infra/sam/template.yaml`](../../infra/sam/template.yaml) and the plan in
[`../specs/changes/cicd-executor-poc/gate-b-plan.md`](../specs/changes/cicd-executor-poc/gate-b-plan.md).

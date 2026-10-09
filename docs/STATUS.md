# Project status and continuity (read this first)

**Answer first.** As of 2026-10-08 the Executor is a **generic remote-script CD** (AC-03): GitHub Actions does
CI per platform and environment, the common reusable workflow sends one `DEPLOY_REQUESTED`, and the Executor
safely runs the deploy script installed on the target. Everything is implemented and validated **locally**; the
AWS DEV foundation and the GitHub OIDC path are validated **for real** up to `TARGET_UNKNOWN`; **no real
deployment has run yet**. The next activity is **E2**: generate the first platform's deploy script from its
current Jenkins stages. A new conversation resumes from this file without any chat history.

## 1. Approved architecture

| Layer | Owns | Never does |
|---|---|---|
| CI (GitHub Actions, one per platform and environment) | Build, tests, quality gates, packaging, artifact publication; calls the reusable workflow | Deploy logic, SSH, choosing a host or script |
| Common CD request (`.github/workflows/deploy-request.reusable.yml`) | OIDC with the shared CI role (session name = `repository_id`), optional image build and push (`units`), optional `artifacts`, exactly one `DEPLOY_REQUESTED` to SQS | Platform build steps |
| Executor (generic, `executor/`) | Sender and source-repository authorization, Target Registry read (`GetItem`), deploy windows, dedupe, supersede ordering, DynamoDB lock with fencing, closed state machine, SSH with pinned host key and a Secrets Manager credential, running the registered script, interpreting the exit code and `CICD_RESULT`, version check, audit, Slack | Docker, PM2, Tomcat or any platform command, builds, migrations, rollback, artifact download, Jenkins logic, expressions |
| Deploy script (one per platform and environment, on the target, admin-owned) | Its application procedure, obtaining or receiving the version, checks, rollback when supported, shared-resource locks, the common result | Trusting anything but its own configuration and the contract arguments |

Full rationale: [architecture-change-03.md](specs/changes/cicd-executor-poc/architecture-change-03.md) (G-D1…G-D9),
on top of [architecture-change-02.md](specs/changes/cicd-executor-poc/architecture-change-02.md) (V1: Target
Registry, no definitions in the core).

## 2. AC-03 contract summary

| Item | Rule |
|---|---|
| `scriptArguments` (target record) | `standard` (default when absent) or `none`. No templates, no interpolation; the script path always comes from the registry |
| Standard vector | `--target-id <id> --execution-id <id> --fencing-token <n> --commit-sha <40-hex>` then `--artifact <name>=sha256:<64-hex>` per artifact, sorted |
| `none` mode | The script runs with no argument and decides what it deploys |
| Artifacts | Optional, 0–8 immutable `sha256:` digests of anything (image, archive, WAR…). Workflow: units + artifacts ≤ 8, disjoint names, pushed digests win |
| Exit codes | 0 deployed · 10 failed before any change · 20 failed in a pre-switch step · 30 switch failed, restore confirmed · 40 verification failed, restore confirmed · 50 target busy, nothing done (lock retry) · anything else, timeout or lost session → `UNKNOWN_TARGET_STATE` |
| `CICD_RESULT` | Last stdout line, JSON; only `status` required; optional `deployedImages`, `previousImages`, `deployedCommit` (40-hex), `migrations`, `healthy`, `mutexHolder`. Missing never fails a run but is flagged |
| `versionCheck` (exit 0 only) | `VERIFIED`, `MISMATCH` or `NOT_REPORTED`; a `MISMATCH` never changes the state machine, it is recorded and notified |
| `versionGuaranteed` | `false` in `none` mode, always |
| Mutex | Every script takes the target mutex before any effect and returns 50 when held; shared resources need an extra script-side lock |
| Template | [`deploy-scripts/templates/deploy-script-template.sh`](../deploy-scripts/templates/deploy-script-template.sh): phases under `set -e` + `inherit_errexit`, failures mapped to 10/20/30/40 or an unknown code (70 when the restore fails). Requires bash ≥ 4.4 |
| Docker specialization | [`deploy-scripts/deploy-container.sh`](../deploy-scripts/deploy-container.sh): standard mode, artifacts = image digests, config `/etc/cicd/targets/<target-id>.conf`; a Docker target needs at least one artifact per request |

## 3. Current state

| Area | Implemented | Validated locally | Validated for real |
|---|---|---|---|
| Executor core (V1 + AC-03) | Yes | `npm run check:local` exit 0: 1522 tests passed, 90 skipped, 1 todo, guards 8/8, 0 vulnerabilities; integration 84/84 | Startup and request processing on the workstation (L9) |
| Reusable workflow (AC-03 commit) | Yes | Contract tests | **No**: the deployed trust still pins the R-8 commit `7f148ceb90e494edd4b87a161524936c4f7ded94` |
| Reusable workflow (R-8 commit) | Yes | Yes | Yes: run L9 reached the Executor and ended `TARGET_UNKNOWN` (expected; no target registered) |
| AWS DEV stack `cicd-poc-dev` | Yes | Static template tests | Deployed, `UPDATE_COMPLETE`; OIDC premises P-R1, P-R2, P-G10, P-G11 verified |
| Deploy scripts and template | Yes | Script suite: 29 run, 0 failed, 1 environment-limited assertion skipped (shellcheck not installed) | **No** |
| Real target, real deployment (E2–E5) | — | — | **No** |

Evidence and exact steps: [execution.md](specs/changes/cicd-executor-poc/execution.md) (L1–L9, R-9a, AC-03 records).
R-9b (definition cleanup) is **postponed** until after the first real deployment ([tasks.md](specs/changes/cicd-executor-poc/tasks.md)).

## 4. Known risks

| # | Risk | Mitigation or condition |
|---|---|---|
| 1 | `none` mode: the deployed version is **not guaranteed** | Use only when the source is fixed outside the request; `deployWindowPolicy: required` while Jenkins still deploys; never present a version as confirmed unless `VERIFIED` |
| 2 | `lastDeployed` is the ordering record, not the verified version | Read `versionCheck` on the execution; `currentImages` holds only what the script reported |
| 3 | `deploy-container.sh` image pruning is unsafe when two Docker targets share a server and an ECR repository | Fix before two Docker targets share a server (G-D9) |
| 4 | The template needs bash ≥ 4.4 (`inherit_errexit`) | Check `bash --version` on the server before installing |
| 5 | The non-Docker flow (`units: []`, `artifacts` input) needs the AC-03 workflow commit, which is published but **not trusted** yet | Owner authorization for the `PinnedWorkflowSha` stack update and the caller re-pin |
| 6 | No real deployment validated | E2–E5 |

## 5. Decision for the next session

The first real deployment uses a **new script generated from the current Jenkins stages** of the selected application:

1. The owner selects the platform and its DEV environment.
2. The owner provides the Jenkins stages.
3. Akili analyzes them.
4. Akili generates an autonomous script that respects the generic contract (from the template).
5. The script is reviewed before installation.
6. The server is prepared.
7. Real tests run only with express authorization.

The server already deploys through Jenkins: do not reinstall or reconfigure Docker or ECR by default; analyze the application and its existing procedure first.

## 6. Next activities

| Step | Content |
|---|---|
| **E2 (next)** | Select the first DEV platform, review its Jenkins stages, generate and review its remote script (template, standard or none mode, exit-code mapping, mutex, shared-resource locks, `CICD_RESULT`) |
| E3 | Prepare the server (deploy user, script and config owned by root, SSH key with the private half as secret `cicd-poc/dev/<target>/ssh`, host key compared out of band); register the target with `deployWindowPolicy: required`; minimal checks: closed window → `FAILED (DEPLOY_WINDOW_CLOSED)`, wrong source → `TARGET_NOT_AUTHORIZED`, non-destructive SSH probe |
| E4 | First deployment: open the window (or `not-required` if Jenkins does not deploy there), trigger the caller, expect `SUCCEEDED` |
| E5 | End-to-end evidence (execution, `CICD_RESULT`, version check, service health, Slack) recorded in `execution.md` |

**First questions to ask the owner:** which platform? which DEV environment (and is Jenkins still deploying it)?
please share the Jenkins stages (sanitized: no hosts, IPs, account IDs, credential IDs or job names).

**Pending owner decisions:** AC-03 workflow pin (`PinnedWorkflowSha` + caller re-pin); the platform and server for E2;
`scriptArguments` mode for that target; open decisions OD-Q5, OD-Q7, OD-Q11–Q15 and OD-N1 (never resolved by assumption).

## 7. Operational restrictions (in force until the owner lifts them explicitly)

- No change to AWS infrastructure or deployed IAM, no server access, no real deployment, no real workflow run,
  no real SQS message, no real target registration and no change to existing applications **without express authorization**.
- No `git reset --hard`, `git clean -fd`, force push, rebase or other destructive operation; pushes are fast-forward only and authorized per batch.
- Never commit account IDs, hosts, IPs, credential IDs, revealing secret names, Jenkins job names or sensitive values (DD-23).
- `JENKINS_REPLACEMENT_*.md` stay local and untracked; never print local credentials; never read secret values.
- Everything committed is in English; commit format per [CLAUDE.md](../CLAUDE.md) rule 9.

## 8. Read next

1. [CLAUDE.md](../CLAUDE.md) — rules and commands.
2. This file.
3. [architecture-change-03.md](specs/changes/cicd-executor-poc/architecture-change-03.md) — the generic contract.
4. [deploy-scripts/README.md](../deploy-scripts/README.md) and the template — what E2 produces.
5. [docs/gate-b/09-target-registry.md](gate-b/09-target-registry.md) — target onboarding checklist (E3).
6. [execution.md](specs/changes/cicd-executor-poc/execution.md) (latest records) and [tasks.md](specs/changes/cicd-executor-poc/tasks.md) §6.0.

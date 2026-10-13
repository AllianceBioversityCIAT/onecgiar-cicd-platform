# Project status and continuity (read this first)

**Answer first.** As of 2026-10-10 the platform runs the full request path **for real** with two repositories:
GitHub Actions (OIDC, a CI role per repository) → ECR → SQS → central Executor → DynamoDB. The pilot
application's target is registered with fictitious SSH data and `deployWindowPolicy: required`, so every request
ends `FAILED (DEPLOY_WINDOW_CLOSED)` by design: **no real deployment has run yet**. The next architecture,
**AC-04 (`SQS_AGENT`: asynchronous Executor, one agent per server)**, is **approved (revision 2)**; **E1** (contracts), **E2** (the asynchronous Executor path)
and **E3** (the server agent, a plain Node.js process) are committed and pushed to `feature/multi-repository-ci`; **E4**
(infrastructure as code) is in progress, uncommitted, and is never deployed without the owner's authorization. A new conversation resumes from this
file without any chat history.

## 1. Approved architecture

| Layer | Owns | Never does |
|---|---|---|
| CI (GitHub Actions, one per platform and environment) | Build, tests, quality gates, packaging, artifact publication; calls the reusable workflow | Deploy logic, SSH, choosing a host or script |
| Common CD request (`.github/workflows/deploy-request.reusable.yml`) | OIDC with **the caller repository's own CI role** (session name = `repository_id`), optional image build and push (`units`), optional `artifacts`, exactly one `DEPLOY_REQUESTED` to SQS | Platform build steps |
| Executor (generic, `executor/`) | Sender and source-repository authorization (shared CI role or `CICD_CI_REPOSITORY_BINDINGS`), Target Registry read (`GetItem`), deploy windows, dedupe, supersede ordering, DynamoDB lock with fencing, closed state machine, running the registered script through the target's transport, interpreting the exit code and `CICD_RESULT`, version check, audit, notifications | Docker, PM2, Tomcat or any platform command, builds, migrations, rollback, artifact download, Jenkins logic, expressions |
| Transport `ssh` (current) | Synchronous SSH with a pinned host key and a Secrets Manager credential | — |
| Transport `sqs-agent` (AC-04: Executor side done in E2, agent in E3) | Asynchronous command to the server's agent (one per server and platform stage), events back on a shared results queue, logs in S3 | — |
| Deploy script (one per platform and environment, on the target, admin-owned) | Its application procedure, the AC-03 contract, shared-resource locks | Trusting anything but its own configuration and the contract arguments |

Rationale: [architecture-change-04.md](specs/changes/cicd-executor-poc/architecture-change-04.md) (agent, approved),
[architecture-change-03.md](specs/changes/cicd-executor-poc/architecture-change-03.md) (generic script contract),
[architecture-change-02.md](specs/changes/cicd-executor-poc/architecture-change-02.md) (Target Registry),
[docs/gate-b/10-multi-repository-ci.md](gate-b/10-multi-repository-ci.md) (one CI role per repository).

## 2. AC-03 contract summary (unchanged by AC-04)

| Item | Rule |
|---|---|
| `scriptArguments` (target record) | `standard` (default when absent) or `none`. No templates, no interpolation |
| Standard vector | `--target-id <id> --execution-id <id> --fencing-token <n> --commit-sha <40-hex>` then `--artifact <name>=sha256:<64-hex>` per artifact, sorted |
| Exit codes | 0 deployed · 10 failed before any change · 20 failed in a pre-switch step · 30 switch failed, restore confirmed · 40 verification failed, restore confirmed · 50 target busy (lock retry) · anything else, timeout or lost session → `UNKNOWN_TARGET_STATE` |
| `CICD_RESULT` | Last stdout line, JSON; only `status` required; optional `deployedImages`, `previousImages`, `deployedCommit`, `migrations`, `healthy`, `mutexHolder` |
| `versionCheck` / `versionGuaranteed` | `VERIFIED`, `MISMATCH` or `NOT_REPORTED` on exit 0; `versionGuaranteed` is `false` in `none` mode |
| Mutex and template | Target mutex before any effect (busy → 50); template [`deploy-scripts/templates/deploy-script-template.sh`](../deploy-scripts/templates/deploy-script-template.sh) (bash ≥ 4.4) |

## 3. Current state

| Area | Implemented | Validated locally | Validated for real |
|---|---|---|---|
| Executor core (V1 + AC-03) | Yes | Yes | Yes, on the owner's workstation |
| Multi-repository CI (D2) | Yes: per-repository CI role template, `AdditionalCiRoleArns`, Executor bindings | Yes | Yes: the pilot repository's role, queue allowance, binding secret and CD Environment are deployed |
| Notifications switch `CICD_NOTIFICATIONS_DISABLED` | Yes | Yes | Yes: Slack is **disabled** in the running Executor (owner decision, weekend tests) |
| GitHub Actions → OIDC → ECR → SQS → Executor → DynamoDB | Yes | Yes | **Yes, twice**: both requests ended `FAILED (DEPLOY_WINDOW_CLOSED)`, no lock, no SSH, nothing deployed (pilot target with fictitious SSH data, `required`, no window) |
| AC-04 E1: agent contracts (`target-record` transport fields, `agent-record`, `agent-command`, `agent-event`, `agent-query`, `agent-heartbeat`, `domain/agent-protocol`, admin tool `agent-put`/`agent-get`) | Yes, commit `8528231` (pushed to `feature/multi-repository-ci`) | `check:local` exit 0: 1705 tests passed, 95 skipped, 29 todo (the E2/E3 acceptance cases); guards 8/8; integration 14/14 files | No (no AWS change in E1). The Executor **refuses** `sqs-agent` targets (`TARGET_INVALID`) until E2 |
| AC-04 E2: asynchronous Executor path (outbox dispatch to a FIFO command queue, results consumer, pinned and held locks without TTL, fresh fencing token per dispatch, reconciler re-send/query/hard deadline, hold release by evidence or `TARGET_RESOLUTION_RECORDED`, SSH X16 hold) | Yes, commit `8a520ce` (pushed to `feature/multi-repository-ci`) | `check:local` exit 0: 1729 passed, 110 skipped, 13 todo (E3 cases); guards 8/8; integration 15/15 files, 102 tests (13 agent scenarios on DynamoDB Local); ElasticMQ FIFO dispatcher test | No (no AWS change). Off unless `CICD_AGENT_RESULTS_QUEUE_URL` and `CICD_AGENT_LOG_BUCKET` are set |
| AC-04 E3: server agent (`executor/src/agent/`): a plain Node.js process, systemd optional (owner decision 2026-10-13), run directly or under an existing PM2 daemon. Includes the journal, fencing, scheduler, outbox, S3 logs, drain on stop, recovery of scripts left by an abruptly ended agent, `runAs` deploy user or `self`, and the `infra/agent/` packaging | Yes, approved by the owner (2026-10-13), committed and pushed to `feature/multi-repository-ci` | `check:local` exit 0: 1770 passed, 117 skipped, 12 todo (E5 cases); `agent.test.ts` 41 passed + 1 POSIX-only; ElasticMQ 11/11 + 1 POSIX-only (real `node main.js` process); guards 8/8; integration 15/15 files, 102 tests; footprint measured locally (idle about 48 MB RSS, CPU < 0.01 %) | No: not installed anywhere |
| AC-04 E4–E7 (templates, real agent, first real deploy, notifications with log links) | No | — | — |

Evidence: [execution.md](specs/changes/cicd-executor-poc/execution.md). Branch `feature/multi-repository-ci` is pushed
and **not merged** to `main`; the DEV stack was updated from that branch's template, so `main` must not be deployed
before the merge.

## 4. Known risks

| # | Risk | Mitigation or condition |
|---|---|---|
| 1 | `main` lags behind the deployed stack template | Merge `feature/multi-repository-ci` (owner authorization) before any deploy from `main` |
| 2 | The Executor runs on the owner's workstation with the role that can send agent commands | Hosting decision before STAGING (AC-04 AP-9) |
| 3 | `none` mode does not guarantee the deployed version | Use only when the source is fixed outside the request |
| 4 | Unknown outcomes block a target until evidence or an operator resolves them (AC-04 AP-3) | Operator tooling in E2 (reuse `TARGET_RESOLUTION_RECORDED`) |
| 5 | No real deployment validated | AC-04 E5–E6 |
| 6 | Application isolation also depends on the deploy scripts (no self-started daemons, no host-wide operations, exit on `SIGTERM`) | Script rules in `infra/agent/README.md`; leftovers are logged; verified on Linux in E5 |
| 7 | A script running as another user that ignores `SIGTERM` cannot be killed by the unprivileged agent | Script requirement; the run ends unknown and the target stays held; E5 check |

## 5. Next activities (AC-04 plan, §19)

| Stage | Content | State |
|---|---|---|
| E0 | AC-04 approved | **Done** (revision 2, 2026-10-10) |
| E1 | Schemas, registry records, admin tool, contract tests | **Done**, local commit `8528231` |
| E2 | Executor async path (see §3) | **Done**, commit `8a520ce`, pushed to `feature/multi-repository-ci` |
| E3 | Server agent and packaging (see §3) | **Done**, approved 2026-10-13, pushed to `feature/multi-repository-ci` |
| **E4 (next, needs authorization)** | Templates: platform additions, `agent-stack.yaml`, `target-script-role.yaml` | — |
| E5–E7 | One real agent with a no-op script; Reporting Tool DEV on `sqs-agent`; notifications with log links | — |

**Owner decisions applied:** OP-1 (a late `FINISHED` never releases a hold automatically) and OP-2 (reuse
`TARGET_RESOLUTION_RECORDED`). **Pending:** CA and server inventory for IAM Roles Anywhere (AP-5); Executor hosting (AP-9); merge of the branch;
restoring Slack. Open decisions OD-Q5, OD-Q7, OD-Q11–Q15 and OD-N1 are never resolved by assumption.

## 6. Operational restrictions (in force until the owner lifts them explicitly)

- No change to AWS infrastructure or deployed IAM, no server access, no real deployment, no real workflow run,
  no real SQS message, no real target registration and no change to existing applications **without express authorization**.
- Keep `CICD_NOTIFICATIONS_DISABLED=true` and do not restart the running Executor unless the owner says so.
- No `git reset --hard`, `git clean -fd`, force push, rebase or other destructive operation; pushes are fast-forward only and authorized per batch.
- Never commit account IDs, hosts, IPs, credential IDs, revealing secret names, Jenkins job names or sensitive values (DD-23).
- `JENKINS_REPLACEMENT_*.md` stay local and untracked; never print local credentials; read a secret value only when the owner authorizes it.
- Everything committed is in English; commit format per [CLAUDE.md](../CLAUDE.md) rule 9.

## 7. Read next

1. [CLAUDE.md](../CLAUDE.md) — rules and commands.
2. This file.
3. [architecture-change-04.md](specs/changes/cicd-executor-poc/architecture-change-04.md) — the agent design and the E0–E7 plan.
4. `executor/src/domain/agent-protocol/`, `executor/src/agent/` and `executor/test/unit/agent*.test.ts` — the protocol rules, the agent and the pending E5 cases.
5. [execution.md](specs/changes/cicd-executor-poc/execution.md) (latest records).

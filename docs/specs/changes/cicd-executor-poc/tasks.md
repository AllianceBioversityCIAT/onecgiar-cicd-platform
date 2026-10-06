# Tasks — CI/CD Executor PoC (PRMS Reporting DEV)

> **In one line:** 35 new tasks (prefix **`N-`**) in three PoC gates: **22 in Gate A** run locally with no AWS or GitHub runs; **7 in Gate B** and **6 in Gate C** are blocked by open decisions or `UNVERIFIED` premises. Gate D (retire Jenkins) is tracked only. Three completed v2 tasks are kept as done and are **not** re-done; the rest of the old plan is mapped in §3.

---

## 1. Document Control

| Field | Value |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Phase | Phase 3: Tasks |
| Version | **v4.4** (Model B; owner approval 2026-10-06) |
| Status | **APPROVED by the owner (2026-10-06)** after the scoped Judgment Day returned `APPROVED`. Execution may resume with Gate A (N-01…N-22) under `/akili-execute` |
| Sources of truth | `architecture-change-01.md` (AC-01, APPROVED), `proposal.md` v3, `requirements.md` v3 (+ RL-1…RL-7), `design.md` v4, `judgment.md` |
| Repository | `onecgiar-cicd-platform` (design §4.1). Commits only in `/akili-execute`, with owner approval |
| Publication policy | No internal identifiers in Git (DD-23), extended to workflow files and CI logs |
| Local-only files | The two local analysis files stay ignored; `git status` + `git ls-files` before **every** commit |
| Approval Mode | `gated` |
| Task ID prefix | **`N-nn`** for this plan. `T-nn` refers only to the v2 plan and the execution log; `D-n` stays the Gate D tracking prefix |

### 1.1 Change history

| Version | Change |
|---|---|
| v3.x | 37 tasks (T-00…T-36) for the v2 model (Lambda + CodeBuild + SSH). Gate A paused at 12/23 under AC-01 |
| **v4** | Rewritten for AC-01 / proposal v3 / requirements v3 / design v4. New `N-` plan; OLD → NEW mapping (§3); obsolescence driven by design §15; DD-25 and DD-27 tasks required owner confirmation before execution (granted in v4.4) |
| **v4.1** | JD round-1 correction (CS-1, CS-2, CC-1, CC-2, SU-1, CW-1…CW-6): scopes of N-01, N-03–N-05, N-07–N-12, N-14, N-19–N-21, N-24, N-29, N-32 extended; T-06 reworked (CW-4); budget total equals components (CW-6) |
| **v4.4** | **owner approval 2026-10-06:** DD-25 and DD-27 approved; [confirm] markers removed from N-06, N-07, N-09; new guard 7 "action-pinning" in N-19; N-21 depends on it; N-22 closure checks it |
| **v4.3** | Editorial E1–E5 after JD APPROVED (2026-10-06): N-21 bound-ref source, N-29 stale P-A6 text. No new decision |
| **v4.2** | JD round-2 correction (R2-A1…R2-A6, R2-1…R2-8): N-24/N-32 trust checks on direct IAM keys, guard bound-ref for both events (N-21), equality rule (N-09), resolution CLI (N-11, N-20), misplaced cell text moved to the verification column (R2-2) |

**Boundary rule (NFR-01), applied to every task:** the Executor coordinates deployments. It does not clone, build, test, orchestrate CI, run migrations itself, connect to databases, read application secrets, contain per-project logic or interpret expressions. If a task would require it: stop and escalate (Pivot Protocol).

---

## 2. Summary by gate

| Gate | Tasks | State |
|---|---|---|
| **A**: local, no AWS, no GitHub runs | N-01…N-22 (22) | Executable after JD `APPROVED` + plan approval. DD-25 and DD-27 approved by the owner (2026-10-06); no task waits on a confirmation |
| **B**: DEV infra and Executor deployment | N-23…N-29 (7) | Blocked by OD-Q7, OD-Q11, OD-Q12, OD-N1, OD-A9 and premises P-7, P-8, P-11, P-16, P-19, P-22, P-A3, P-A4, P-G4, P-G7 (organization plan) |
| **C**: end to end on `<PRMS_REPORTING_DEV_TARGET>` | N-30…N-35 (6) | Blocked by OD-Q5, OD-A6, P-3–P-6, P-13, P-14, P-23, P-24, AC17 real re-run (P-A6 verified at source; rename reset P-G12 UNVERIFIED) |
| **D**: retire Jenkins | D-1…D-8 (tracking) | Outside the PoC |

### 2.1 Budget (consistent with design §14.1)

| Metric | Estimate |
|---|---|
| Tasks | 35 new (22 A / 7 B / 6 C) + 3 v2 tasks kept as done |
| LOC | ~5,580 = Executor production ~3,000 + tests ~1,600 + schemas and definitions ~350 + script delta ~80 + workflows ~150 + operator CLI ~150 + infra inventory ~250 (CW-6: total equals the sum; identical to design §14.1) |
| Review rounds | ~40 (≈1.3 per code task, 1 per document or operational task) |

Tripwire: `/akili-execute` stops and escalates if these figures are exceeded.

### 2.2 Order and PR strategy

```text
N-01 ─┬─> N-02 ─> N-03 ─────────────────────────────┐
      ├─> N-04 ─┬─> N-05 ─> N-06* ──────────────────┤
      │         └─> N-08 ─> N-09* (needs N-07*)     ├─> N-10 ─> N-11 ─> N-12 ─> N-14 ─> N-17 ─> N-22
      ├─> N-07* (lock-policy ordering)              │            N-13 ─┘   N-16 ─┘
      ├─> N-15 (script; parallel)   N-18, N-19, N-20, N-21 (parallel, after N-01/N-02)
      DD-25 (N-06) and DD-27 (N-07, N-09) approved by the owner on 2026-10-06
```

| PR | Tasks | Review first |
|---|---|---|
| PR-1 | N-01 | The obsolescence guard and the pending-deletion list |
| PR-2 | N-02, N-03 | Request schema (`additionalProperties: false`, digest pattern) |
| PR-3 | N-04, N-05, N-06, N-07 | X1–X16 table; per-type sender rule |
| PR-4 | N-08, N-09, N-10 | Conditional writes; T-08 files land here |
| PR-5 | N-11, N-12, N-13, N-14 | DD-28 two-phase intent; §7.5 release table |
| PR-6 | N-15, N-16, N-17 | Script `--artifact`; ack rules |
| PR-7 | N-18…N-22 | Guards, workflow contract, Gate A closure |

---

## 3. OLD → NEW mapping (v2 T-00…T-36)

Completed-and-kept work is **not** re-done. "Reworked" states exactly what changes; design §15 is the obsolescence authority.

| Old | v2 status | v4 | What changes |
|---|---|---|---|
| T-00 | done | **Kept as done** | — |
| T-01 | done (local; Docker inspection DEFERRED) | Reworked → N-01, N-18 | Prune obsolete ports and stubs (N-01); drop `git` from the image, assert it in `inspect:image` (N-18). Docker run still DEFERRED |
| T-02 | done | Reworked → N-02 | `deployment`, `deploy-request`, internal `event` schemas; PRMS definition flattened and moved |
| T-03 | done | Reworked → N-03 | Step-graph rules removed; new references and one-`deploymentId`-per-`lockKey` rule; reference resolution kept |
| T-04 | done | Reworked → N-04 | T1–T13 step machine → X1–X16 execution machine |
| T-05 | done | **Obsolete** (deleted in N-04) | Planner removed (design §15.1) |
| T-06 | done | Reworked (partial) → N-07 | Lease, fencing, schedule unchanged; `evaluateSupersede` (Executor-sequence ordering, rejected by DD-27) and its tests deleted in N-07 (CW-4) |
| T-07 | done | Reworked → N-05 | Request contract + internal events; normalizers and orphan handling deleted |
| T-08 | in progress, **uncommitted** | Reworked → N-08, N-09 | The uncommitted files stay uncommitted until N-08 lands them reduced (design §15.2) |
| T-09 | pending | Reworked → N-10 | Dedupe key `requestId`; X1/X2 creation |
| T-10 | pending | Replaced → N-12 | Step dispatcher → deploy coordinator |
| T-11 | pending | Reworked → N-14 | Deploy state and windows only |
| T-12 | pending | Reworked → N-11 | Fail-fast window semantics (RL-1) |
| T-13 | pending | Reworked → N-13 | SSH as a `DeployTransport` adapter; lock/semaphore orchestration moves to N-12 |
| T-14 | in progress (attempt 3 not verified) | Reworked → N-15 | `--artifact` by digest; Leader re-verifies attempt-3 evidence first |
| T-15 | pending | **Obsolete** | No source handler, no `/work` |
| T-16 | pending | Reworked → N-16 | Deploy lifecycle only |
| T-17 | done | **Kept as done** | — |
| T-18 | pending | Reworked → N-17 | `SenderId` attributes; no `/work`, no instance lease |
| T-19 | pending | **Obsolete** | No Lambda/CodeBuild handlers |
| T-20 | done | **Obsolete** (deleted in N-01) | Webhook ingress removed |
| T-21 | done | **Kept as done** + retarget in N-18, N-19 | Guard 1 forbids `git`; guards 3 and 6 retargeted; publication guard scans workflows |
| T-22 | done | Reworked → N-20 | Inventory: remove S3, CodeBuild, Destinations, CodeBuild EventBridge rule, ingress; add OIDC provider, CI roles, queue policy |
| T-23 | blocked | Reworked → N-23 | No GitHub egress needed |
| T-24 | blocked | Reworked → N-24 | New resource set |
| T-25 | blocked | Reworked → N-25 | No `/work`, no instance lease |
| T-26 | blocked | Reworked → N-26 | Adds real `SenderId` format (P-A4) and queue policy |
| T-27 | blocked | **Obsolete** | No Lambda |
| T-28 | blocked | **Obsolete** | No CodeBuild |
| T-29 | blocked | **Obsolete** | No clone |
| T-30 | blocked | **Obsolete** | No webhook |
| T-31 | blocked | Reworked → N-28 | Still OD-N1 |
| T-32 | blocked | Reworked → N-30 | + `allowedSenderRef`, principal refs |
| T-33 | blocked | Reworked → N-31 | Unchanged intent |
| T-34 | blocked | Reworked → N-33 | Fail-fast window check |
| T-35 | blocked | Reworked → N-34 | AC1–AC18 |
| T-36 | blocked | Reworked → N-35 | GitHub minutes instead of Lambda/CodeBuild |

**Counts:** kept as done 3 · reworked or replaced 26 · obsolete 8 (total 37).

---

## 4. Task conventions

- **Verification:** each task names its *Falsifier*; its *Red run* is **observed and cited** during execution, never predicted.
- **First step:** a task owning an `UNVERIFIED` premise resolves it before building; if refuted, Pivot Protocol.
- **Owner approval (2026-10-06):** DD-25 and DD-27 are approved; N-06, N-07 and N-09 implement them as recorded (no confirmation markers remain).
- **Deferred environment validations (carried):** real `inspect:image` needs a Docker daemon (DEFERRED, exit 3, never PASS); script tests run with shims, real `flock`/Linux behavior is proven in Gate C; local runs observed on **Node 20.19.5** while the target is **Node 22** (N-22 re-runs `check:local` on Node 22 or records DEFERRED); `shellcheck` absent = SKIPPED, not PASS.
- **Sensitive data:** no fixture, test or document contains real internal identifiers.

---

## 5. Gate A: local implementation

### N-01 — Obsolescence cleanup and guard
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** |
| Goal | Delete the design §15 DELETE rows that have no surviving importer, and add a guard that fails if any DELETE path exists or is imported |
| Depends on | Gate A entry (JD `APPROVED`, plan approved) |
| Requirements / Design | NFR-01 · design §15 (all DELETE rows), AC-01 §17 |
| Files | `ingress/github-webhook/**`; `adapters/{git-cli-client, s3-artifact-store, zip-packager, handlers/lambda, handlers/codebuild, handlers/notify}`; `ports/{artifact-store, git-client}` + barrel exports; `application/step-dispatcher` stub; `executor/scripts/guards/obsolescence.mjs` (new) |
| Scope | Includes: the guard's list = every §15 DELETE path, each with an **owner task** for paths that still have importers (`domain/planner` → N-04, `schemas/pipeline.schema.json` and `pipeline-definitions/` → N-03, event normalizers → N-05, `ports/step-handler` → N-12, T-08 `step-repository`/`step-attempt-lookup`/`instance-lease-repository` → N-08, old unit tests → their owners). Excludes: any REWORK; touching the uncommitted T-08 files Also owned (CW-5): `test/contract/pipeline-schema.contract.test.ts` → N-03; `test/fixtures/aws/*.json` → N-05; `evaluateSupersede` in `lock-policy` → N-07. |
| Tests / verification | Guard run: deleted paths absent; no `import` of them in `executor/src`, `executor/test`; pending entries listed with owners; `check:local` green |
| Falsifier | Re-add an import of `git-cli-client` → guard red |
| Red run | Guard on the current tree before deleting: every DELETE path reported |
| Disqualifier | A guard that only checks file existence (not imports) proves nothing about dead references |
| Consumers | `bundled-definition-source.test.ts`, `boundary-guards.test.ts` (barrel changes) |
| Review | full |
| Done | Leaf deletions done; guard wired into `npm run validate`; pending list owned |
| Skills | — |

### N-02 — Schemas: deployment, deploy request, internal events
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** |
| Goal | Add `deployment.schema.json`, `deploy-request.schema.json`; reduce `event.schema.json` to internal types; move and flatten the PRMS definition |
| Depends on | N-01 |
| Requirements / Design | FR-01, FR-03, FR-04 · design §6.1, §6.2, §6.4 |
| Files | `schemas/*.schema.json`, `deployment-definitions/prms/reporting-dev.yaml`, `deployment-definitions/targets/dev.yaml` (moved) |
| Scope | Exact fields of §6.1/§6.2; `additionalProperties: false` everywhere; digest pattern; no steps, `needs`, `when`, interpolation. The old pipeline schema is deleted in N-03 |
| Tests / verification | Contract tests: valid fixtures pass; negative fixtures (tag, extra field, host, missing unit, uppercase digest, `requestId` shape) fail with the field named |
| Falsifier | Remove `additionalProperties: false` from `artifacts` → the "extra field" fixture passes |
| Red run | Run the negative suite against a permissive draft and cite the passes |
| Disqualifier | Fixtures that never exercise nested objects do not prove the nested rule |
| Consumers | Reusable workflow (N-21), definition-service (N-03) |
| Review | full |
| Done | All §6 fields enforced; PRMS definition validates |
| Skills | `api-design-principles` |

### N-03 — DefinitionService rework
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** |
| Goal | Validate flat Deployment Definitions and the registry; resolve the new references; delete the pipeline schema and step-graph rules |
| Depends on | N-02 |
| Requirements / Design | FR-01, FR-02, NFR-08 · design §6.2, §6.3, §7 (`definition-service`), DD-19, DD-23 |
| Files | `application/definition-service/*`, `adapters/bundled-definition-source`, unit tests; delete `test/contract/pipeline-schema.contract.test.ts` (CW-5), `schemas/pipeline.schema.json`, `pipeline-definitions/`, `definition-service.substitution.test.ts` |
| Scope | Keep `reference-resolution`, `registry-rules`, `schema-validation`; rework `index`, `semantic-rules`; add `allowedSenderRef`, `source.*Ref`, principal refs (identifier refs, resolved); credential refs existence-only; new rule: one `deploymentId` per `lockKey` |
| Tests / verification | Unit: invalid definitions rejected naming the field; unresolvable `allowedSenderRef` blocks startup; two definitions on one `lockKey` rejected; startup and registry tests kept green |
| Falsifier | Drop the one-per-`lockKey` rule → the duplicate test passes |
| Red run | Cite the duplicate-lockKey fixture accepted before the rule |
| Disqualifier | Testing resolution with real secret names violates DD-23: fakes only |
| Consumers | Guards 3 and 6 (N-19), Dockerfile copy paths (N-18) |
| Review | full |
| Done | Guard pending entries for N-03 cleared |
| Skills | `tdd` |

### N-04 — State machine X1–X16 and errors
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** |
| Goal | Rewrite the pure state machine as design §7.3's closed list; rework error codes; delete the planner |
| Depends on | N-01 |
| Requirements / Design | FR-05, FR-16 · design §7.2, §7.3 |
| Files | `domain/state-machine`, `domain/errors`, `state-machine.test.ts`; delete `domain/planner`, `planner.test.ts` |
| Scope | Guards per row; terminals immutable; X14 the only backward edge; `INVALID_TRANSITION` for anything else; codes incl. `DISPATCH_INTERRUPTED`, rejection reasons; any exit outside 0/10/20/30/40/50 → X16 (RL-4, RL-7) X9 and X14 clear `execStartedAt` and per-attempt fields; X10/X11/X16 guards read `execStartedAt` of the current `dispatchToken` (CW-1); no `RECEIVED` state (CW-3). |
| Tests / verification | Table-driven: every listed transition accepted with its guard; every unlisted pair rejected (exhaustive state × state); exit 2 → `UNKNOWN_TARGET_STATE` Exit 50 → X14 → next attempt with V4 failing → X10 reachable (CW-1). |
| Falsifier | Allow `DEPLOYING → QUEUED` → exhaustive test red |
| Red run | Exhaustive matrix against a permissive stub |
| Disqualifier | Sampling pairs instead of the full matrix leaves gaps |
| Consumers | N-10, N-12, N-14 |
| Review | full |
| Done | 16 transitions, exhaustive negatives green; planner gone |
| Skills | `tdd` |

### N-05 — Request contract, internal events and message router
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** |
| Goal | Domain validation of `DEPLOY_REQUESTED` and internal events; router by `eventType`; unparseable → no ack |
| Depends on | N-02, N-04 |
| Requirements / Design | FR-03, FR-04 · design §6.1, §6.4, §7 (`message-router`), RL-3 |
| Files | `domain/request-contract` (from `domain/events`), `application/message-router` (from `event-router`), tests; delete normalizers, `event-normalizers.test.ts` and `test/fixtures/aws/*.json` (CW-5); rework `test/contract/event-schema.contract.test.ts` (CW-5) |
| Scope | Schema-invalid parseable request → rejection outcome (X2) + ack; unparseable → no ack; consistency checks (`ci.repository`, `ci.workflowRef` vs resolved source); no orphan logic `requestId` must equal `<ci.runId>-<ci.runAttempt>`, else X2 `REQUEST_ID_MISMATCH` (CC-2). |
| Tests / verification | Unit per outcome; size limit 8 KB Mismatched `requestId` → rejected. |
| Falsifier | Ack unparseable messages → DLQ test (N-17) cannot pass; here: router test for "no ack" red |
| Red run | Cite router acking garbage before the fix |
| Disqualifier | Testing only valid messages proves nothing about rejection paths |
| Consumers | N-06, N-10, N-17 |
| Review | full |
| Done | Guard pending entries for N-05 cleared |
| Skills | `tdd`, `api-design-principles` |

### N-06 — Sender authorizer (DD-25, approved)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · S · **A** (OD-A2 resolved by the owner, 2026-10-06) |
| Goal | Map the `SenderId` role ID to a principal class and enforce the per-type rule |
| Depends on | N-03, N-05 |
| Requirements / Design | FR-21, RL-2 · DD-25 |
| Files | `application/sender-authorizer`, tests |
| Scope | `DEPLOY_REQUESTED` ← definition's `allowedSender`; `LOCK_RETRY_REQUESTED` ← Executor; `RECONCILE_TICK` ← scheduler; `DEPLOY_WINDOW_*` ← operator; body identity ignored; fail-closed |
| Tests / verification | Foreign role, right role wrong type, forged `ci.repository`, missing `SenderId` → rejected; metric emitted |
| Falsifier | Authorize from `ci.repository` → forged-body test passes wrongly |
| Red run | Cite the forged-body request accepted by a naive stub |
| Disqualifier | Fake `SenderId` values must use the real documented shape (`ROLEID:session`, P-A4); the real format is re-checked in N-26 |
| Consumers | N-17 |
| Review | full |
| Done | All four types bound; negatives green |
| Skills | `tdd` |

### N-07 — Supersede policy (DD-27, approved)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · S · **A** (OD-A1 resolved by the owner, 2026-10-06) |
| Goal | Pure `SupersedePolicy`: bound source + in-source `runNumber`; S1 and S2 decisions |
| Depends on | N-01 |
| Requirements / Design | FR-23 · DD-27, design §7.3 |
| Files | `domain/supersede-policy`, tests ; `domain/lock-policy`: delete `evaluateSupersede` and its tests (CW-4) |
| Scope | Newer ⇔ higher `runNumber` in the same source; equal ⇒ not older; different source on one `lockKey` ⇒ impossible by validation, defensive reject S2 compares against `max(lastDeployed, highestDispatched)` (CS-2). |
| Tests / verification | Late older build, re-run of an older run (same number), newer accepted then older, equal re-run allowed Newer dispatched then `UNKNOWN_TARGET_STATE` → older superseded; newer lost lease with rejected write → older superseded (CS-2). |
| Falsifier | Use `>=` instead of `>` for "older" → the equal re-run is wrongly superseded |
| Red run | Cite the equal-run case failing under `>=` |
| Disqualifier | Tests that never mix arrival order with run order do not exercise the goal |
| Consumers | N-09, N-10, N-12 |
| Review | full |
| Done | All FR-23 scenarios covered at domain level |
| Skills | `tdd` |

### N-08 — DynamoDB store reduction (lands T-08)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** |
| Goal | Land the uncommitted T-08 store, reduced per design §15.2 |
| Depends on | N-04 |
| Requirements / Design | FR-05, FR-07, FR-11 · design §5.1, DD-03, DD-09 |
| Files | `adapters/dynamodb-state-store/*`, integration tests |
| Scope | First step: delete `step-repository`, `step-attempt-lookup`, `instance-lease-repository` and `step-repository.transition.int.test.ts`. Rework `keys`, `types`, `index`, `state-store`, `execution-repository` (`dispatchToken`, `execStartedAt`, GSI2 attribute removal), `table-schema` (drop GSI1), add rejection record; keep dedupe, lock, window, event-mark, sequence (`DEPLOYMENT#`). Target-state ordering fields are N-09 Dedupe key `DEDUPE#{deploymentId}#{requestId}`; rejection key per design §5.1 (CC-2). |
| Tests / verification | DynamoDB Local: two concurrent writers on one transition (barrier, ≥ 50 repetitions, one winner); foreign lock release no effect; expired lease acquirable; GSI2 queries with the scan-forbidding client; `activeStatus` removed at terminal |
| Falsifier | Remove the `version` condition → both concurrent writers succeed |
| Red run | Cite the double success |
| Disqualifier | Sequential "concurrent" writes do not exercise the race |
| Consumers | N-10, N-11, N-12, N-14 |
| Review | full |
| Done | T-08 files committed in reduced form; guard pending entries for N-08 cleared |
| Skills | `tdd`, `aws-serverless` |

### N-09 — Target state with ordering and fencing (DD-27, approved)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · S · **A** |
| Goal | `lastDeployed` (fenced, monotonic `token ≥ stored`) and `highestAccepted` (conditional max) |
| Depends on | N-07, N-08 |
| Requirements / Design | FR-11, FR-23 · design §5.1, DD-09, DD-27; T-06 forward pointer |
| Files | `target-state-repository.ts`, its integration test |
| Scope | Stale fencing rejected; `highestDispatched` and `highestAccepted` are written in the same `TransactWriteItems` as X9 / X1 with condition `stored <= new` (equal accepted for the same execution after exit 50 and same-run re-runs), never fenced (CS-2, R2-1); the `unresolved[]` append shares the X16 transaction (R2-8); `unresolved[]`; replaces `lastDeployedSequence` |
| Tests / verification | DynamoDB Local race: two `highestAccepted` and two `highestDispatched` updates in parallel → max wins (≥ 50 reps); a stale-fence holder can still raise `highestDispatched`; an equal value is accepted, a lower one rejected (R2-1) |
| Falsifier | Unconditional put → lower value overwrites higher |
| Red run | Cite the regression |
| Disqualifier | — |
| Consumers | N-12 |
| Review | full |
| Done | Both fields race-safe |
| Skills | `tdd` |

### N-10 — Identity, dedupe and execution creation
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** |
| Goal | `execution-service`: validation → dedupe claim (DD-20) → sequence → X1, or X2; S1 via the supersede port |
| Depends on | N-05, N-08 (N-06/N-07 via ports; fakes until confirmed) |
| Requirements / Design | FR-03, FR-07, FR-23 · DD-20, design §7.3 |
| Files | `application/execution-service`, tests |
| Scope | No sequence for rejections; duplicate `deploymentId` + `requestId` → no-op; X1 and `highestAccepted` in one transaction; concurrent duplicates → one execution |
| Tests / verification | Integration with DynamoDB Local: parallel duplicates (≥ 50 reps) → 1 execution, 0 extra sequence numbers Foreign deployment pre-claiming the victim's `requestId` → victim still created (CC-2). |
| Falsifier | Increment the sequence before the claim → extra numbers consumed |
| Red run | Cite the gap |
| Disqualifier | A single-threaded duplicate test proves only idempotent replay, not the race |
| Consumers | N-12, N-17 |
| Review | full |
| Done | FR-03 and FR-07 scenarios green |
| Skills | `tdd` |

### N-11 — Deploy windows: service and operator CLI
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** |
| Goal | `deploy-window-service`, `domain/window-policy`, `tools/` CLI for open/close events |
| Depends on | N-04, N-08 |
| Requirements / Design | FR-18, FR-24, RL-1 · design §7.7, DD-21 |
| Files | `application/deploy-window-service`, `domain/window-policy`, `tools/` |
| Scope | Coverage of all external deployers; ≤ 8 h; `none` ⇔ `not-required`; `isDeployAllowed(lockKey, needUntil)`; no Jenkins logic CLI also emits `TARGET_RESOLUTION_RECORDED` from the operator principal only; preconditions (execution `UNKNOWN_TARGET_STATE` and listed in `unresolved[]`, no live lock owner) checked by the Executor; never edits ordering fields (runbook §12.2, R2-A5). |
| Tests / verification | Partial coverage rejected; expired window not allowed; CLI produces schema-valid events |
| Falsifier | Accept a window missing one deployer → coverage test passes |
| Red run | Cite the accepted partial window |
| Disqualifier | — |
| Consumers | N-12, N-14 |
| Review | full |
| Done | FR-24 scenarios green at service level |
| Skills | `tdd` |

### N-12 — Deploy coordinator (DD-28)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M (flag: could grow to L; split at the §7.5 table if it does) · **A** |
| Goal | V1–V4, lock (DD-09), S2, two-phase intent, semaphore, transport call, exit mapping, fenced target write, release on every exit |
| Depends on | N-04, N-09, N-10, N-11 (transport via fake; N-13 real) |
| Requirements / Design | FR-11, FR-12, FR-16, FR-24 · design §7.2, §7.3, §7.5, §7.6, DD-22, DD-28 |
| Files | `application/deploy-coordinator`, `ports/deploy-transport`; delete `ports/step-handler` |
| Scope | X4–X16; lock wait schedule; X14 only on exit 50 with V3 OK; never re-run after `execStartedAt` X9 writes `highestDispatched` atomically with the intent and clears `execStartedAt` (CS-2, CW-1); persist `nextAttemptAt`, then send, then ack (CW-2); X16 appends to `unresolved[]`. |
| Tests / verification | Fake transport per §7.5 row; crash points before/after `execStartedAt` → X11 / X16; resources released in every exit (assert lock, slot, session) CS-2 paths (a) unknown state and (b) lost lease with exit 50 in between; CW-1 path exit 50 → V4 fails → X10. |
| Falsifier | Write `execStartedAt` after exec → crash test misclassifies as `DISPATCH_INTERRUPTED` |
| Red run | Cite the misclassification |
| Disqualifier | Asserting only the final state, not resource release, misses leaks |
| Consumers | N-14, N-17 |
| Review | full |
| Done | Every §7.5 row and X-transition exercised |
| Skills | `tdd`, `error-handling-patterns` |

### N-13 — SSH deployer adapter
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** |
| Goal | `DeployTransport` over `ssh2`: pinned host key, memory-only credential, SFTP delivery + checksum, escaped args, `CICD_RESULT` parse, ≤ 2 connect retries before exec |
| Depends on | N-12 (port) |
| Requirements / Design | FR-12 · DD-10, design §7.5 |
| Files | `adapters/ssh-deployer` (from `handlers/ssh`), tests with a local test SSH server |
| Scope | No retry after exec; temp dir per `executionId` |
| Tests / verification | Host-key mismatch → `HOST_KEY_MISMATCH`, no retry; injected arg with `;` reaches the script literally |
| Falsifier | Accept unknown host keys → mismatch test passes |
| Red run | Cite the accepted wrong key |
| Disqualifier | Mocking `ssh2` entirely does not test host-key verification |
| Consumers | N-17 |
| Review | full |
| Done | FR-12 scenarios green locally |
| Skills | `tdd` |

### N-14 — Reconciler (reduced)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · S · **A** |
| Goal | Two GSI2 queries per tick: executions past deadline, expired windows |
| Depends on | N-08, N-11, N-12 |
| Requirements / Design | FR-15 · design §7.1, §7.3, DD-13 |
| Files | `application/reconciler`, tests |
| Scope | Re-drive (CW-2): overdue `QUEUED` re-evaluated, overdue `WAITING_LOCK` with budget gets a fresh `LOCK_RETRY_REQUESTED`; `QUEUED` re-evaluation; X7 canonical; X11 vs X16 by `execStartedAt`; window closure; no scans; no re-run |
| Tests / verification | Handler and reconciler racing on X7 → one write, same result; scan-forbidding client Crash after X5 with no retry message → resumed, not `LOCK_TIMEOUT` (CW-2). |
| Falsifier | Reconciler writes `TIMED_OUT` instead of `LOCK_TIMEOUT` → canonical test red |
| Red run | Cite the divergent outcome |
| Disqualifier | — |
| Consumers | N-17 |
| Review | full |
| Done | FR-15 scenarios green |
| Skills | `tdd` |

### N-15 — `deploy-container.sh` adaptation (preserves T-14)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** (real validation in Gate C) |
| Goal | Replace `--image` with `--artifact <container>=<repo>@sha256:<64-hex>`; tag rejection; "already running" exit 0 |
| Depends on | N-01 |
| Requirements / Design | FR-13 · design §6.5, DD-11, DD-22, DD-26 |
| Files | `deploy-scripts/deploy-container.sh`, `deploy-scripts/test/**`, `deploy-scripts/README.md` |
| Scope | **First step: the Leader re-runs and records the T-14 attempt-3 evidence** (`bash deploy-scripts/test/run-tests.sh`); only then adapt. Keep accepted deviations (`--migration-mode`, `runtime-<container>.env`, usage exit 2, charset validation) |
| Tests / verification | New shim cases: tag rejected (exit 2, no effect), digest pull argument, already-running skip without migration effects; all existing cases green |
| Falsifier | Accept `repo:tag` → tag-rejection case red |
| Red run | Cite the tag accepted |
| Disqualifier | Exit-code-only assertions do not prove "no effect": the case checks shim call logs |
| Consumers | N-12 (CLI shape), runbook (N-20) |
| Review | full |
| Done | Attempt-3 evidence recorded; all cases green; `shellcheck` SKIPPED if absent |
| Skills | `tdd` |

### N-16 — Notifications (Slack)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · S · **A** |
| Goal | Deploy-lifecycle notifications per design §6.6 with `EVT#` dedupe |
| Depends on | N-08 |
| Requirements / Design | FR-14 · DD-12 |
| Files | `application/notification-service`, `adapters/notify/slack-provider`, tests |
| Scope | No secrets or real identifiers; provider failure never changes state; no CI notifications (OD-A5) |
| Tests / verification | Duplicate event → one message; Slack error → state unchanged |
| Falsifier | Remove the `EVT#` check → duplicate test red |
| Red run | Cite two messages |
| Disqualifier | — |
| Consumers | — |
| Review | checklist |
| Done | FR-14 scenarios green |
| Skills | — |

### N-17 — SQS consumer and bootstrap
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** (local emulator) |
| Goal | Long-poll with `SenderId` and `ApproximateReceiveCount`; heartbeat; ack rules; wiring in `main` |
| Depends on | N-05, N-06*, N-10, N-12, N-13, N-14, N-16 (*fake authorizer until confirmed) |
| Requirements / Design | FR-04, FR-05, NFR-03, NFR-04 · DD-14, DD-16 |
| Files | `inbound/sqs-consumer`, `main` |
| Scope | No `/work`, no instance lease; ordered shutdown |
| Tests / verification | Local queue emulator: poison → DLQ after 5; heartbeat extends visibility; restart resumes from state |
| Falsifier | Ack before the handler finishes → kill test loses the request |
| Red run | Cite the lost request |
| Disqualifier | The emulator may not populate `SenderId`; that part is DEFERRED to N-26, not PASS |
| Consumers | N-25 |
| Review | full |
| Done | Executor runs end-to-end locally with a fake transport |
| Skills | `aws-serverless` |

### N-18 — Dockerfile and image inspection (no git)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · S · **A** |
| Goal | Remove `git` from the image; copy `deployment-definitions/`; static guard and `inspect:image` forbid `git` |
| Depends on | N-03 |
| Requirements / Design | NFR-01, AC2 · design §15.3 |
| Files | `executor/Dockerfile`, `scripts/inspect-image.mjs`, `scripts/guards/dockerfile-boundary.mjs`, tests |
| Scope | Real inspection stays DEFERRED without Docker (exit 3) |
| Tests / verification | Fixture Dockerfile installing `git` → guard red |
| Falsifier | Re-add `git` → guard red |
| Red run | Guard on the current Dockerfile (has `git`) |
| Disqualifier | Static scan alone is not the gate; `inspect:image` is |
| Consumers | — |
| Review | checklist |
| Done | Static guard green; inspection DEFERRED recorded |
| Skills | — |

### N-19 — Guards retarget (T-21 guards 3 and 6) and guard 7 "action-pinning"
| Field | Value |
|---|---|
| Status / Size / Gate | pending · S · **A** |
| Goal | Guard 3 → `deployment.schema.json` expressions corpus; guard 6 → mock deployment definition (NFR-08); publication guard also scans `.github/workflows/`; **new guard 7 "action-pinning"** (owner rule, 2026-10-06) |
| Depends on | N-03 |
| Requirements / Design | NFR-01, NFR-02, NFR-08, FR-22, FR-25 · DD-23, DD-29 |
| Files | `scripts/guards/{pipeline-schema-expressions→deployment-schema-expressions, extensibility-fixture, publication-policy, action-pinning (new)}.mjs`, `run-all.mjs`, `boundary-guards.test.ts` |
| Scope | No new denylist entries without provenance. Guard 7 scans `.github/workflows/*.reusable.yml`: every `uses: owner/repo[/path]@ref` must be a full 40-hex SHA (trailing version comment), `docker://` must be `@sha256:<64-hex>`, `./` exempt; any other ref fails. Rework `test/fixtures/nfr08-second-definition/pipeline.yaml` into a deployment definition (CW-5). |
| Tests / verification | Each guard with its negative case; guard 7 negatives: `@v4`, `@main`, `@master`, a branch name, a 7-char short SHA, `docker://image:tag`; positives: full SHA, `docker://…@sha256:…`, `./local` |
| Falsifier | Account-ID-shaped literal in a workflow file → publication guard red |
| Red run | Cite it |
| Disqualifier | — |
| Consumers | N-21 |
| Review | full |
| Done | Seven guards green clean, red mutated; guard 7 wired into `npm run validate` |
| Skills | — |

### N-20 — Infrastructure inventory and runbooks
| Field | Value |
|---|---|
| Status / Size / Gate | pending · S · **A** |
| Goal | `infra/RESOURCES.md`, `docs/runbook.md`, `docs/resources.md` for Model B |
| Depends on | N-02 |
| Requirements / Design | FR-17, FR-18, FR-25, NFR-06, NFR-09 · design §5, §11, §12, DD-17, DD-24 |
| Files | `infra/RESOURCES.md`, `docs/*.md` |
| Scope | Remove S3, CodeBuild, Destinations, CodeBuild EventBridge rule, ingress, `/work`; add OIDC provider, CI role (trust shape with placeholders, exact `sub`), queue policy, Scheduler target role; keep runbook §12.1 Trust shape uses direct IAM keys (`job_workflow_ref` at an immutable SHA, repository and owner IDs, Environment) per DD-24; runbook §12.2 incl. the resolution CLI and the OD-A8 boundary (CS-2, R2-A5). |
| Tests / verification | Cross-check against design §5/§11 and proposal §14.1; publication scan = 0 |
| Falsifier | A `StringLike` or wildcard `sub` in the trust shape → checklist fails |
| Red run | Cite the first-pass missing items |
| Disqualifier | A checklist not derived from design §11 proves nothing |
| Consumers | N-24 |
| Review | checklist |
| Done | Inventory complete and sanitized |
| Skills | `cognitive-doc-design`, `aws-serverless` |

### N-21 — Reusable workflow and PRMS caller (static only)
| Field | Value |
|---|---|
| Status / Size / Gate | pending · M · **A** (no GitHub run in Gate A) |
| Goal | `.github/workflows/deploy-request.reusable.yml` and `docs/examples/caller-workflow.yml` implementing FR-22 |
| Depends on | N-02, N-19 (guard 7 must exist so the real reusable workflow is checked) |
| Requirements / Design | FR-22, FR-25 · DD-24, DD-26, DD-29 |
| Files | the two workflow files; a contract test that parses them |
| Scope | Environment-bound job; `id-token: write`; OIDC role; build + push; digest capture; one schema-valid send after all steps; `guard` job enforcing the event allowlist (`push` or `workflow_dispatch`) before the Environment job, and an Environment-job first step enforcing **the bound ref for both events** from the administrator-only `CICD_BOUND_REF` Environment variable, never a caller input (R2-3, E1); identifiers only from secrets, account ID masked explicitly (SU-1); `requestId = run_id-run_attempt`; no host/script/SSH. Adding the caller to the application repo is **Gate C (N-32, OD-A6)** |
| Tests / verification | Contract test asserts each property; the produced body validates against `deploy-request.schema.json`; a workflow linter if available, else SKIPPED (not PASS) Assert no identifier comes from `vars.*` (SU-1); assert the Environment job `needs` the guard (CS-1). |
| Falsifier | Move the send step before tests → ordering assertion red |
| Red run | Cite the misordered fixture |
| Disqualifier | A YAML parse without property assertions proves nothing |
| Consumers | N-32 |
| Review | full |
| Done | Static contract green |
| Skills | `api-design-principles` |

### N-22 — Gate A closure
| Field | Value |
|---|---|
| Status / Size / Gate | pending · S · **A** |
| Goal | Prove Gate A complete: obsolescence guard with an empty pending list; `check:local` and `validate` green, **including guard 7 "action-pinning" on the real reusable workflow**; coverage matrix (§9) re-checked |
| Depends on | N-01…N-21 |
| Requirements / Design | NFR-01, NFR-08 · design §15 |
| Files | `docs/specs/changes/cicd-executor-poc/execution.md` (record only) |
| Scope | Re-run on Node 22 if available, else record DEFERRED; `inspect:image` DEFERRED without Docker |
| Tests / verification | Leader evidence re-run of every gate command |
| Falsifier | Leave one DELETE path → guard red |
| Red run | — |
| Disqualifier | Results observed only on Node 20 are labelled as such |
| Consumers | — |
| Review | checklist |
| Done | Gate A evidence recorded |
| Skills | — |

---

## 6. Gate B: DEV infrastructure (blocked)

| ID | Task | Depends on | Requirements / Design | Blocked by (not assumed) | Verification and falsifier | Review |
|---|---|---|---|---|---|---|
| **N-23** | Network spike from the Executor host: 443 to AWS and Slack, 22 to the target, proxy | — | NFR-04, NFR-09 · DD-18 | **OD-Q11**, P-11, P-19 | Documented probes; a blocked destination must show as failure, not a silent timeout | checklist |
| **N-24** | IaC for DEV: queue + DLQ + policy, table + GSI2, Scheduler, OIDC provider, CI role, Executor role | N-20, N-23 | FR-25, NFR-02, NFR-09 · DD-17, DD-24, DD-25 | **OD-Q7**, P-7, P-8 | Scoped ECR/SQS, no wildcard. Falsifier: `StringLike` `sub` fails the check Static check of the trust policy: exact `StringEquals` on `aud`, `repository_id`, `repository_owner_id`, `environment`, `job_workflow_ref` (SHA-pinned) and the environment-form `sub`; no custom subject template; record the repo's observed `sub` format (P-G10) and the SHA-pinned claim form (P-G11) (R2-A1, R2-4). | full |
| **N-25** | Deploy the Executor container on the host | N-17, N-24 | NFR-02, NFR-04 · DD-16, DD-18 | **OD-Q11**, **OD-Q12** | Synthetic valid request → Slack; credentials not reachable from another container (negative) | full |
| **N-26** | Real AWS integration | N-25 | FR-04, FR-21, NFR-03 · DD-14, DD-25 | **P-A4** (real `SenderId` format), **P-22**, owner-created secret entries | Poison → DLQ; wrong role → `REJECTED` + alarm; `DelaySeconds` > 900 rejected. Falsifier: wrong `maxReceiveCount` | full |
| **N-27** | ECR consumers review | N-24 | FR-22 · DD-26 | **P-8b**, **P-16** | Lifecycle policy cannot delete PoC digests; CI tag convention does not collide with Jenkins tags | checklist |
| **N-28** | CI for this platform repo | N-22 | NFR-01, NFR-08 | **OD-N1** | Guards fail a PR with their mutation | checklist |
| **N-29** | Pin premises at primary source | — | FR-23, FR-25 · DD-24, DD-27 | **P-A3** (pin statement), **P-G12** (`run_number` reset on rename/recreate; P-A6 itself is VERIFIED), **OD-A9** incl. the organization plan (P-A5, P-G7, CC-1), P-G10 format check for the repo (with N-24) | Citations recorded in design §13; P-A6 is VERIFIED at source; the real re-run in N-34 remains an end-to-end check | checklist |

---

## 7. Gate C: end to end on the target (blocked)

| ID | Task | Depends on | Requirements / Design | Blocked by | Verification | Review |
|---|---|---|---|---|---|---|
| **N-30** | Target preparation: secret entries (connection, host key), deploy user, target AWS permissions **without** deleting existing keys, `externalDeployersRef`, principal and `allowedSender` refs | N-25 | FR-02, FR-12, FR-13, FR-18, FR-21, NFR-10 | **OD-Q5**, P-3, P-4, P-13, P-14 | Executor starts and resolves all refs; leftover-key jobs still work | full |
| **N-31** | Migration preparation: ephemeral mode, target → DB path, compatibility attestation, DEV DB snapshot | N-15, N-30 | FR-13 · DD-11 | **P-5**, **P-6**, **P-23**, **P-24** | Read-only `migration:check:ci` from the target; **no attestation → no migrations** | full |
| **N-32** | Caller workflow in `<PRMS_REPORTING_REPO>` + GitHub Environment (branch rules) + first real CI run held by a **closed** window | N-21, N-26 | FR-22, FR-25, AC15, AC16 | **OD-A6**, repo admin, OD-A9 | Real request → `FAILED (DEPLOY_WINDOW_CLOSED)`, no SSH; a `pull_request` run cannot assume the CI role (negative); public log scan clean Negatives (CS-1): `pull_request`, `pull_request_target`, `workflow_run` runs and a job outside the pinned workflow cannot assume or send; the real token's `job_workflow_ref`, `repository_id`, `repository_owner_id` and `environment` match the trust policy (P-G11); P-G7 re-checked; no identifier from variables in the log (SU-1). | full |
| **N-33** | SSH and window validation without deploy | N-30, N-11 | FR-12, FR-24 | Window approved by the Jenkins admin | Deploy without window → fails fast, no SSH (real negative) | checklist |
| **N-34** | Acceptance E2E in a window: AC1–AC18 incl. duplicates, concurrency, broken migration, broken health, Executor kill, poison, code 50, wrong sender, **late older build and real re-run (AC17)** | N-31, N-32, N-33 | All FRs of requirements v3 (FR-01–FR-05, FR-07, FR-11–FR-18, FR-21–FR-25), NFR-03, NFR-05, NFR-06 | Window, snapshot, P-23, **P-A6 proven** | Each AC with cited evidence; NFR-05 over ≥ 10 runs with spread reported | full |
| **N-35** | Measurement report and coexistence close-out: GitHub minutes, Executor resources, cost vs proposal §14.2, windows log, jobs re-enabled (AC14) | N-34 | NFR-05, NFR-07, FR-18 | — | Jenkins jobs re-enabled and working | checklist |

---

## 8. Gate D: retire Jenkins (outside the PoC; tracking only)

| ID | Prerequisite | Initiative |
|---|---|---|
| D-1 | Jenkins configuration inventory (B2); resolves P-12 | `jenkins-config-inventory` |
| D-2 | Non-Docker builds proven in GitHub Actions per wave (B1) | Waves |
| D-3 | Server-less migrations relocated through an exception mechanism (H1) | Waves |
| D-4 | Host and Secrets Manager scripts inventoried and versioned (H2) | `jenkins-config-inventory` |
| D-5 | IAM remediation (H3) | `cicd-security-remediation` |
| D-6 | Non-SSH deploys (**OD-A3**) and non-Docker artifact store (**OD-A4**); Jira Builds API | Future specs |
| D-7 | Remaining patterns validated with Jenkins in parallel; CI for this repo (OD-N1) | Waves |
| D-8 | Consumers of `<JENKINS_EXECUTIONS_TABLE>` (OD-Q14) | `jenkins-config-inventory` |

**The PoC completes at N-35.** No Gate D item is a PoC completion criterion.

---

## 9. Coverage (requirement → tasks)

| Requirement | Tasks |
|---|---|
| FR-01, FR-02 | N-02, N-03, N-19, N-30 |
| FR-03 | N-02, N-05, N-10, N-21 |
| FR-04 | N-05, N-17, N-26 |
| FR-05 | N-04, N-08, N-17 |
| FR-07 | N-08, N-10, N-12, N-34 |
| FR-11 | N-07 (reworks T-06), N-08, N-09, N-12 |
| FR-12 | N-12, N-13, N-33 |
| FR-13 | N-15, N-30, N-31 |
| FR-14 | N-16 |
| FR-15 | N-14 |
| FR-16 | N-04, N-12, N-14, N-34 |
| FR-17 | N-20, N-34 (T-17 kept) |
| FR-18, FR-24 | N-11, N-12, N-33, N-35 |
| FR-21 | N-06, N-26, N-32 |
| FR-22 | N-21, N-32 |
| FR-23 | N-07, N-09, N-10, N-12, N-34 |
| FR-25 | N-20, N-24, N-29, N-32 |
| NFR-01 | N-01, N-18, N-19, N-22 · NFR-02: N-13, N-19, N-25 · NFR-03: N-08, N-17, N-26 · NFR-04: N-17, N-25 · NFR-05: N-34 · NFR-06: N-20, N-34 · NFR-07: N-35 · NFR-08: N-03, N-19 · NFR-09: N-23, N-24 · NFR-10: N-30 |

No clause is covered by citing another requirement.

---

## 10. Boundary risks per task

| Task | Risk | Control |
|---|---|---|
| N-12 | Coordinator grows retry graphs or per-target logic | Closed X1–X16 list; one remote call; review against proposal §11 warning signs |
| N-15 | Script accumulates application logic | Generic; arguments only; project-identifier guard |
| N-21 | Workflow gains deploy logic (host, SSH) | Contract test forbids it; option C rejected (proposal §11) |
| N-11 / N-30 | Jenkins logic in the core | Opaque lists only; `grep -i jenkins executor/src` |
| N-06 / N-07 / N-09 | Drifting from the approved DD-25 / DD-27 (e.g. comparing `runNumber` across sources, authorizing on session names) | Review against the owner statements recorded in DD-25 and DD-27 |
| N-28 | Choosing a CI without a decision | Blocked by OD-N1 |

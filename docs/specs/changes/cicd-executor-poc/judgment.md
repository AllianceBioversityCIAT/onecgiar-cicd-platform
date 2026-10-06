# Judgment Day — `design.md` (cicd-executor-poc)

| Field | Value |
|---|---|
| Target | `design.md` (draft v1 from 2026-10-05) checked against `requirements.md` and `proposal.md` (approved) |
| Mode | Two blind judges, read-only and in parallel. Model `sonnet` (the design's author was `opus`) |
| Round | 1 of 2 |
| Status | **Open**: awaiting the owner's decision before the round 1 fix |
| Skill references | `references/` is not packaged; the `SKILL.md` contract was applied |

Legend: **A** = judge A; **B** = judge B.

## Frozen ledger — round 1

### Confirmed by both judges (SEVERE → eligible for auto-fix)

| ID | Finding | A | B | Architect verification |
|---|---|---|---|---|
| C-1 | DD-09: lock wait "with `DelaySeconds` increasing up to 30 min". SQS limits `DelaySeconds` to 900 s, so the mechanism does not reach the 30-minute `LOCK_TIMEOUT` of FR-11 | J-02 | J1 | Correct: documented SQS limit |
| C-2 | P-21 "verified" (`grep -rni "akilia" .` → 0 hits) is false: `design.md` itself contains the string (Document Control and the P-21 row) | J-01 | J2 | Correct: the row refutes itself |

### Suspected (SEVERE per a single judge → no auto-fix; owner decides)

| ID | Finding | Judge | Architect verification |
|---|---|---|---|
| S-1 | DD-20: the two-phase dedupe has no lease. Two concurrent redeliveries of the same `requestId` in `CLAIMED` state could both complete steps 2–4, consume two sequences and create two executions (violates FR-03 and FR-07) | A (J-03) | **Agreed**: real race condition |
| S-2 | Lease expired with the SSH session still alive: if the lock renewal fails (partition with DynamoDB) while the script keeps running, another execution can acquire the lock and launch a second deployment or migration. The `fencingToken` protects only the write to DynamoDB, not the physical effect | B (J5) | **Agreed**: requires a target-side mutex or an explicit accepted risk |
| S-3 | The premise "migrations are backward compatible" is missing. It was in proposal §10.11 and disappears in requirements and design; the code 40 rollback depends on it | B (J3) | **Agreed** |
| S-4 | FR-18 (coexistence with Jenkins) has no design backing: there is no mechanism that prevents a real deployment without a confirmed window | B (J6) | **Agreed**: can be backed with a configuration gate |

### Found by both with different severity → owner decides

| ID | Finding | A | B | Architect verification |
|---|---|---|---|---|
| D-1 | Risk R9 from the proposal (DEV DB shared with Jenkins variants from other branches) does not appear in the Premise Ledger (shared-state) nor in the design's risks | SUGGESTION (J-09) | SEVERE (J4) | `shared-state` class trigger without a row → per the skill's rule, **severe** |

### WARNING (info, no auto-fix)

| ID | Finding | Judge |
|---|---|---|
| W-1 | `handlers/ssh` has no global session semaphore (NFR-04; the proposal set a default of 4) | A (J-06), B (J11) |
| W-2 | FR-20 (webhook) has no module or contract (signature, branch) | A (J-07), B (J7) |
| W-3 | FR-04 "orphan event" has no explicit handling in `event-router` | A (J-04) |
| W-4 | `/work` sweep at startup (FR-08) has no assigned module | A (J-05) |
| W-5 | DD-19 (redeploy for every new definition) is in tension with the wording of NFR-08 and QAS-5 | B (J8) |
| W-6 | P-15: the quote does not establish that current invocations are synchronous (it is an inference) | B (J9) |

### SUGGESTION (info)

| ID | Finding | Judge |
|---|---|---|
| I-1 | Temp path renamed (`/tmp/deploy-{id}.env` → `/tmp/cicd-{id}/runtime.env`) without explanation | A (J-08) |
| I-2 | P-14 should cite FA §9.3.5 instead of L1123 | A (J-10) |
| I-3 | P-8: "non-numeric tags" has no trace in the FA | A (J-11) |
| I-4 | P-10: its High impact is conditional | B (J10) |

### Checks that passed (both judges)

Premise Ledger count consistent. `shared-state` and `consumer` rows present. No open decision (OD-Q5, Q7, Q11–Q15) assumed. Numbers (retention, deadlines, exit codes, F1–F17) consistent. NFR-01 boundary with no deviations.

## Verdicts

| Judge | Verdict |
|---|---|
| A | FAIL |
| B | FAIL |

## Fixes — round 1 (approved by the owner on 2026-10-05: "Fix and Re-judge" option)

Owner's instructions: apply C-1, C-2, S-1 through S-4, D-1 and the informational items. S-2 with two layers (DynamoDB remains the lock; the local mutex is a second barrier, not a replacement). S-4 transient and per-target, with no Jenkins logic in the core. C-1 with bounded requeues and accumulated wait. S-3 as an explicit precondition. DD-19 as a PoC simplification behind an abstraction.

| ID | Fix (delta) | Where |
|---|---|---|
| C-1 | Lock wait with a chain of `LOCK_RETRY_REQUESTED` of at most 900 s each, `lockWaitStartedAt` and `lockWaitAttempts` on the step, a budget of 30 accumulated minutes, a cap of 10 attempts and a reconciler safety net. New premise P-22 | design DD-09, §5.1, §7, §7.1, §7.2, §11 |
| C-2 | P-21 reworded and re-run (2 files within the spec, 0 outside) | design §11, Document Control |
| S-1 | Dedupe with `claimToken` + `claimLeaseExpiresAt` + stored `sequence`. Redelivery table by state | design DD-20, §5.1 |
| S-2 | DD-22: non-blocking local mutex by `lockKey` on the target, code 50 `TARGET_BUSY` (returns to waiting), `lockLostDuringRun`, rollback from the image that is actually running. FR-13 adds code 50 and its scenario | design DD-22, DD-11, §5.3, §6.4, §7, §7.2; requirements FR-13, FR-16 F18 |
| S-3 | Attested precondition `migrationCompatibility: backward-compatible` in the registry; validation; premise P-23 (High, Gate C) | design DD-11, §7 `definition-service`, §11, §12; requirements FR-13, FR-02 |
| S-4 | DD-21: generic, transient per-target deploy windows (`requiresDeployWindow`), `DEPLOY_WINDOW_*` events, `deploy-window-service`, CLI in `tools/`, `WINDOW#` item, coexistence log format, `DEPLOY_WINDOW_CLOSED` | design DD-21, §2, §3.3, §4, §5.1, §6.1, §7, §7.2; requirements FR-18, FR-16 F19 |
| D-1 | `shared-state` premise P-24 (shared DEV DB) and risk row with mitigations | design §11, §12 |
| W-1 | Global SSH session semaphore (default 4) | design §7 `handlers/ssh` |
| W-2 | Webhook contract §6.6 | design §6.6, §4 |
| W-3 | Orphan events (`ORPHAN_EVENT`) | design §6.1, §7 `event-router` |
| W-4 | `/work` sweep assigned to `main` (volume exclusive per instance) | design §4, §7 |
| W-5 | `DefinitionSource` port and packaging as a PoC simplification; QAS-5 and NFR-08 clarified | design DD-19, §2, §4, §7, QAS-5; requirements NFR-08 |
| W-6 | P-15 without asserting the invocation mode | design §11 |
| I-1…I-4 | Temp path explained; P-14 cites §9.3.5; P-8 split into P-8 and P-8b; P-10 marked as conditional High | design §5.3, §11 |

Closing sweep of fixes executed (grep of `0/10/20/30/40`, `up to 30 min`, `DelaySeconds`, `no changes to the Executor`, `/tmp/deploy-`): no remnants of replaced values in design or requirements. `proposal.md` (approved) is not rewritten: it keeps its historical text.

## Round 2 — bounded re-judgment (frozen ledger + delta)

| Judge | Verdict | Round 1 items |
|---|---|---|
| A | **PASS** (conditioned on closing R2-1, R2-W2 and R2-W3 before Gate C) | All RESOLVED |
| B | **PASS** (recommends a bounded amendment for R2-1) | All RESOLVED |

Both judges re-ran the P-21 grep (2 files within the spec, 0 outside) and manually recounted the Premise Ledger: 25 rows, 2 verified and 23 `UNVERIFIED` (10 High and 13 Low). It matches. Neither found a **critical architectural issue**. The NFR-01 boundary holds and no OD was silently resolved.

### New findings caused by the fixes

| ID | Severity | Finding | A | B |
|---|---|---|---|---|
| R2-1 | **SEVERE (confirmed by both)** | Code 50 (DD-22) requires the backward transition `DISPATCHING/RUNNING → WAITING_LOCK` of the `ssh` step, which is not in the transition table (FR-05 / `state-machine`). A literal implementation would reject it | J-01 | R2-1 |
| R2-W1 | WARNING | It does not say that the window check repeats on every lock retry and after code 50; a window closed during the wait might go undetected | — | R2-2 |
| R2-W2 | WARNING | `requiresDeployWindow` is opt-in. If it is missing on a known shared target (P-13), S-4's protection is silently nullified | J-02 | — |
| R2-W3 | WARNING | The reconciler's closing of expired windows has no indexed query path (the `WINDOW#` items are not in GSI2) | J-03 | — |
| R2-W4 | WARNING | The `/work` sweep is safe only if the volume is exclusive to each instance; that is asserted, but not enforced in DD-18 | J-04 | — |
| R2-I1 | SUGGESTION | DD-09 says "about 7 requeues": with the schedule given, it is 6 | J-06 | R2-3 |
| R2-I2 | SUGGESTION | SSH semaphore release also on code 50 (avoid slot leakage) | — | R2-4 |
| R2-I3 | SUGGESTION | A row is missing in DD-20's redelivery table: the same `claimToken` with a valid lease | J-05 | — |
| R2-I4 | SUGGESTION | Runbook to release a stuck local mutex after `UNKNOWN_TARGET_STATE` | J-07 | — |

### Cycle status

- Fix rounds used: **1 of 2**. Re-judgments used: **1 of 2**.
- R2-1 is confirmed by both judges → eligible for the **final fix round** (with owner approval), followed by the last bounded re-judgment.
- Transaction status: **open**, awaiting the owner's decision (it is neither `approved` nor `escalated`).

## Fixes — round 2 (final; approved by the owner on 2026-10-05)

Owner's instructions: fix R2-1, R2-W1 through R2-W4 and R2-I1 through R2-I4. T9 only for code 50 (not a generic backward transition). Revalidate the window at every point. Configuration safe by construction and with no Jenkins logic in the core. Window reconciliation without scans. `/work` with explicit ownership. Preserve the two layers, the migration precondition, `DefinitionSource`, the runtime on the existing server, CodeBuild per app and environment, and NFR-01. Add the canonical repository and the exclusion of the two analysis files.

| ID | Fix (delta) | Where |
|---|---|---|
| R2-1 | New §7.3: closed list T1–T12. **T9 `RUNNING → WAITING_LOCK` only `ssh` and only with code 50.** Detail: states that receive it (only `RUNNING`; explains why not `DISPATCHING`), released resources, preserved identity, retry, V3 revalidation, idempotency. Any other transition is rejected (`INVALID_TRANSITION`). Retries of `source`/`lambda`/`codebuild` are formalized as T10 (never `ssh`) | design §7.3, §7 (`state-machine`, `step-dispatcher`), §2; requirements FR-05 (new scenario) |
| R2-W1 | Revalidation at V1 (first attempt), V2 (every lock retry), V3 (after the 50) and V4 (right before exec, with everything acquired). The window must cover `now + step timeout`. Reasons `NO_WINDOW`/`EXPIRED`/`INSUFFICIENT_REMAINING`. Window expired during a script in progress: it is not aborted; `windowClosedDuringRun` | design §7.7, DD-09, DD-21, §7.2; requirements FR-18 (new scenario) |
| R2-W2 | `externalDeployers` and `deployWindowPolicy` **mandatory and without a default**. Non-empty external deployers ⇒ `required` only. The window opening must cover all `externalDeployers`. Validation in CI and at startup | design §7.7, DD-21, §7 (`definition-service`, `deploy-window-service`), P-13; requirements FR-02 (new scenario) |
| R2-W3 | `OPEN` windows with `activeStatus = WINDOW` and `deadlineAt = closesAt` in sparse GSI2. One `Query` per partition. Conditional `EXPIRED` closure. Interaction with steps documented | design §5.1, §7 (`reconciler`), §7.7 |
| R2-W4 | Stable and unique `instanceId` with `INSTANCE#` lease (does not start if duplicated). `/work/{instanceId}/{executionId}/{stepId}-{attempt}/`. Cleanup per execution, at startup (only its own subtree) and of stragglers. Safe with multiple instances | design §7.4, §5.1, DD-18, §7 (`main`) |
| R2-I1 | Exact schedule in §7.6: 7 attempts and 6 requeues at most with no contention, last delay capped at 870 s; decision based on persisted actual wait | design §7.6, DD-09 |
| R2-I2 | Acquisition and release table for the SSH handler for each exit; with the 50, both the semaphore and the lock are released | design §7.5, DD-22 |
| R2-I3 | DD-20: rows "same `claimToken` with a valid lease" and "failed conditional take". Idempotency guarantees reaffirmed | design DD-20 |
| R2-I4 | Runbook §12.1: the mutex is the kernel lock, not the file; step-by-step evidence; distinguishes an active deployment from a stalled one; never delete the file; escalate if a migration is in progress | design §12.1, §5.3 |
| Repo | §4.1: canonical repository; the repo root replaces `cicd-platform/`; `.gitignore` first with the two analysis files; verification with `git status`/`git ls-files` before every commit; no push during specification; owner review of internal details in specs before the first commit. P-25 verified (`git ls-remote`), P-26 `UNVERIFIED` | design §4.1, §4.2, §11, Document Control |
| Gates | New §14: blocks per gate A/B/C/D | design §14 |

Closing sweep: no remnants of `requiresDeployWindow` as a mechanism, `cicd-platform/` as the root, "about 7 requeues" nor "removing the tag". P-21 re-run after v3: `grep -rnil "akilia" .` → 2 files within the spec and 0 outside (exit 1).

## Round 3 — final re-judgment

| Judge | Verdict | Round 2 items |
|---|---|---|
| A | **PASS** | R2-1, R2-W1 through R2-W4 and R2-I1 through R2-I4: all RESOLVED |
| B | **PASS** | R2-1, R2-W1 through R2-W4 and R2-I1 through R2-I4: all RESOLVED |

Both judges re-ran `git ls-remote` (P-25: exact hash `41f4c3e…`) and the P-21 grep (2 files within the spec, 0 outside), and recounted the Premise Ledger (27 rows: 3 verified and 24 `UNVERIFIED`, 10 High and 14 Low). It matches. Both validated that code 50 **cannot** arrive in `DISPATCHING` (T6 occurs right before exec) and that T10 does not reopen a generic backward transition nor apply to `ssh`.

**No CRITICAL or SEVERE findings. Nothing blocks Gate A.**

### Informational findings (no auto-fix: the fix rounds were exhausted)

| ID | Severity | Finding | A | B |
|---|---|---|---|---|
| R3-1 | WARNING | In `design.md`, §14 "Gates" is physically before §13 "Budget" (order 12 → 14 → 13). Structural only | J-01 | R3-1 |
| R3-2 | WARNING | The closed list in §7.3 does not make explicit how recovery of a build lost by the reconciler (`BatchGetBuilds`, DD-04) decomposes into transitions: `RUNNING` with `externalRef` → T8 is clear; `DISPATCHING` without `externalRef` (re-dispatch with the **same** token, DD-04) has no row of its own. It should be made explicit before the reconciler is written | J-02 | — |
| R3-3 | SUGGESTION | The "Review" row of `requirements.md` mentions only round 1, although the body already contains the round 2 scenarios (FR-02, FR-05, FR-18) | — | R3-2 |
| R3-4 | SUGGESTION | Near the 30-minute limit, T5 (`LOCK_TIMEOUT`, in the handler) and T12 (`TIMED_OUT`, in the reconciler) compete. Optimistic concurrency guarantees a single terminal state, but the final code is not deterministic. Document this as harmless | — | R3-3 |

## Terminal receipt

| Field | Value |
|---|---|
| Target | `design.md` v3 (+ adjusted `requirements.md`) from `changes/cicd-executor-poc` |
| Rounds | 3 judgments (1 initial + 2 bounded re-judgments) · 2 fix rounds (the maximum) |
| Confirmed SEVERE | Round 1: 2 (C-1, C-2) + 5 approved by the owner (S-1 through S-4, D-1) · Round 2: 1 (R2-1) · Round 3: 0 |
| Pending | 0 SEVERE · 4 informational (R3-1 through R3-4), whose application as an editorial adjustment is decided by the owner |
| Status | **approved** |

**JUDGMENT: APPROVED ✅**

## After APPROVED — editorial adjustments authorized by the owner (2026-10-05)

These do not reopen the judgment: they apply the informational items R3-1 through R3-4 and the publication policy.

| ID | Change |
|---|---|
| R3-1 | In `design.md`, §13 "Budget" now precedes §14 "Gates" |
| R3-2 | §7.3: new **T13**, idempotent re-dispatch with the **same** `attempt` and `dispatchToken` (only `codebuild` and `lambda`, once, controlled by `reconcileRedispatchCount`), plus a reconciler recovery table (T8/T13/T12). T12 and DD-04 adjusted |
| R3-3 | The "Review" row of `requirements.md` reflects the full Judgment Day (3 rounds, APPROVED) |
| R3-4 | **Canonical rule:** exhausting the lock wait **always** ends in `FAILED (LOCK_TIMEOUT)` via T5, whether detected by the handler or the reconciler. T12 no longer applies to `WAITING_LOCK`. New `AND IT MUST` in FR-11 |
| Publication | Specs sanitized: account ID, region, hosts, credential IDs, secret names, containers, ports, ECR repos, the previous PoC's function and bucket, Jenkins table, Slack channel, Jenkins job names and paths, resident scripts and vulnerability details of other systems → logical references (`<…>`). New DD-23: real values are resolved outside Git |
| Budget | Re-estimated in Phase 3: 37 tasks (previously 25) and ~50 rounds; LOC unchanged (~8,700) |

---

## Scoped Judgment Day — AC-01 revision (proposal v3, requirements v3, design v4, tasks v4) — Round 1

| Field | Value |
|---|---|
| Date | 2026-10-06 |
| Target | Frozen snapshot, SHA-256 verified by both judges: `proposal.md` 233947c9…, `requirements.md` 9b74fa90…, `design.md` ee96dfbf…, `tasks.md` 9dd292c8… |
| Judges | Two blind, read-only `opus` judges, identical scope and criteria (Premise Ledger first; trust boundary priority) |
| Raw counts | Judge A: 3 severe, 14 warnings, 7 suggestions. Judge B: 4 severe, 14 warnings, 7 suggestions |

### Confirmed severe (both judges)

| ID | Finding | Judges |
|---|---|---|
| CS-1 | The CI role is reachable from `pull_request_target` and `workflow_run` runs. When a job references an environment, the OIDC `sub` takes the environment form regardless of the triggering event, and these triggers run with the default branch as `GITHUB_REF`, so deployment branch rules do not stop them. P-A2 is marked VERIFIED for a claim false in this configuration; FR-25, AC15 and N-32 only test `pull_request` | A-1, B-1 |
| CS-2 | Supersede regression: S2 compares only the fenced `lastDeployed`, written only after a recorded success. A newer execution ending `UNKNOWN_TARGET_STATE` (script actually finished) or losing its lease mid-script never records its success, so an older waiting execution passes S2 and deploys over it. Violates FR-23 / AC17 | A-3, B-3 |

### Severity contested (one judge severe, the other warning) — owner decision

| ID | Finding | Judges |
|---|---|---|
| CC-1 | P-A5 consequence "if repos are private: cost only, security model holds" is contradicted by GitHub's plan documentation (environment protection features depend on the plan; protection rules are ignored after converting to private). No ledger row for the organization's plan | A-2 (severe), B-5 (warning) |
| CC-2 | Dedupe key `DEDUPE#{requestId}` is global and `requestId` comes from the body; `run_id` is unique only within a repository. A bound role of repo X can pre-claim repo Y's request; collisions across repos drop legitimate requests | B-2 (severe), A-7 (warning) |

### Suspect (one judge only)

| ID | Finding | Judge |
|---|---|---|
| SU-1 | GitHub variables are not masked in logs; the specs say "masked secrets/variables". Role ARN, registry host or queue URL would appear in public CI logs. No ledger row | B-4 (severe) |

### Confirmed warnings (both judges; recorded as info)

| ID | Finding | Judges |
|---|---|---|
| CW-1 | `execStartedAt` is never cleared after exit 50, so X10/X11 cannot fire on the next attempt | A-5, B-8 |
| CW-2 | A crash after entering `QUEUED`/`WAITING_LOCK` leaves no retry message; the execution stalls until a spurious `LOCK_TIMEOUT` | A-6, B-7 |
| CW-3 | FR-05 lists a `RECEIVED` state the design never creates; FR-15's outcome contradicts X11 | A-11, B-10, B-11 |
| CW-4 | `lock-policy` (KEEP) still orders supersede by the Executor sequence, the option DD-27 rejects | A-14, B-13 |
| CW-5 | Design §15 omits obsolete contract tests and Lambda/CodeBuild fixtures | A-15, B-14 |
| CW-6 | Budget components sum to ~5,580 LOC, not the stated ~5,300 | A-16, B-15 |

Other single-judge warnings and suggestions remain in the raw judge files and are carried as info (notably B-17: P-A4 claims more than its source; B-19: P-A6 now confirmable at its primary source; B-12: FR-17 past-deadline alarm missing from the design).

**Status:** Round 1 complete. Awaiting the owner's authorization for the round-one correction.

### Round 1 correction → scoped re-judgment (round 2)

All 11 round-1 IDs RESOLVED by both judges. One fix-caused severe (R2-A1, Judge A): P-G6 was marked VERIFIED but did not reproduce — the AWS IAM page's GitHub tab maps `job_workflow_ref`, `repository_id`, `repository_owner_id`, `environment` (and others; not `event_name`) to condition keys. Settled by the architect with a single re-run of the source (confirmed). Fix-caused warnings confirmed by both: dispatched-value condition unspecified (`<=` needed), `workflow_dispatch` branch not checked, rollback contradiction, FR-03 dedupe wording.

### Round 2 correction (final bounded round) → final verification

| Field | Value |
|---|---|
| Changes | DD-24 simplified: trust policy matches `aud`, `repository_id`, `repository_owner_id`, `environment` and a SHA-pinned `job_workflow_ref` directly (custom subject template dropped; P-G4 moot); P-G6 corrected; P-G10 (immutable subject format) added; `highestDispatched` condition `stored <= new`; guard checks the bound ref for `push` and `workflow_dispatch`; rollback in scope = the script's automatic restore only (operator redeploy of an older digest = OD-A8); runbook §12.2 resolution CLI; FR-03 wording; ledger table repaired; P-A6 VERIFIED |
| Final verification | Judge A: **APPROVE** (no fix-caused severe). Judge B: **APPROVE** (no fix-caused severe; corrected its own round-2 reading of P-G6) |
| Residual info (not fixed; the fix lineage is exhausted) | R3-A1 (warning): the source of the guard job's "bound ref" is not specified — it must not come from a caller input. R2-1 residual (warning): the `highestAccepted` write at X1 has no stated condition; a strict condition would send a late older build to the DLQ instead of `SUPERSEDED` (safe, but breaks an FR-23 scenario). R2-A7: `targetWriteRejected` missing from the §5.1 attribute list. R2-A8: FR-04 omits `TARGET_RESOLUTION_RECORDED`. R3-A2: stale text (N-29 still says P-A6 UNVERIFIED; DD-29 still says "tag or SHA") |
| Leader direction recorded | Pinning the reusable workflow to a commit SHA in the trust binding was a Leader direction in round 2; it narrows OD-A6 ("tag or SHA") for the trust binding only. Owner confirmation pending |

JUDGMENT: APPROVED ✅ (with residual info items requiring an owner-approved editorial pass before implementation resumes)

### Post-approval editorial pass E1–E5 (owner-requested, 2026-10-06)

| ID | Residual closed | Change (editorial; no new decision) |
|---|---|---|
| E1 | R3-A1 | The bound ref comes from the Environment-scoped variable `CICD_BOUND_REF` (admin-only, P-G13 VERIFIED), checked in the Environment job's first step before any OIDC request; never a workflow input, the request or a repository variable (`write`-only, rejected). Fails closed if missing. P-G14 (availability in a called workflow) UNVERIFIED, fails closed |
| E2 | R2-1 residual | `highestAccepted` is not a condition of X1: a separate conditional update (`stored <= new`) after X1, so a late older build ends `SUPERSEDED` via S1/X3, as FR-23 requires; S2 stays authoritative |
| E3 | R2-A7 | `targetWriteRejected` added to the §5.1 execution attributes |
| E4 | R2-A8 | FR-04 lists `TARGET_RESOLUTION_RECORDED` among the known message types |
| E5 | R3-A2 | N-29 stale P-A6 text removed; DD-29 and the OD-A6 rows say the reusable workflow is pinned by commit SHA wherever the trust depends on it (owner direction) |

Checks after E1–E5: stale-text grep clean; Premise Ledger 15 VERIFIED / 25 UNVERIFIED (consistent with the count line); sanitization grep clean on all spec files; `npm run validate` 6/6 PASS.

# Execution Log — changes/cicd-executor-poc

## Document Control

| Field | Value |
|---|---|
| Spec Path | `changes/cicd-executor-poc` |
| Authorized scope | **Gate A only (T-00 to T-22)**. Approved by the owner (CI/CD Platform Team) on 2026-10-05. Stop after T-22 |
| Repository | `https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform.git`. Commits and push authorized for Gate A |
| Approval Mode | `gated` |
| Triad | Leader `opus` (T1) · Implementer `sonnet` (T2) · Reviewer `opus` (T3) in an independent context (author ≠ auditor) |
| Personas | `.agents/` created by the **minimal constitution** approved by the owner (2026-10-05): `CLAUDE.md`, `AGENTS.md`, `.agents/{leader,implementer,reviewer}.md`. No Step 8E wrappers: subagents are launched with the persona by reference |
| Environment | Node 20.19.5, npm 10.8.2, Java 17 (DynamoDB Local and ElasticMQ). **The Docker daemon was not available** at the start; the owner decided to start it himself. T-01 and T-14 complete their verifications with Docker once the daemon responds |
| Budget (design §13) | 37 tasks · ~8,700 LOC · ~50 review rounds. Gate A: 23 tasks, ~7,900 LOC |

## Task Execution History

### T-00 — Link the workspace to the canonical repository and exclude the local analysis · **PASS**

| Field | Value |
|---|---|
| Date | 2026-10-05 |
| Attempts | 1 |
| Files | `.gitignore` (new), `.git/` (init + `origin` + `main` tracking `origin/main`), `LICENSE` (fetched from the remote, unedited) |
| Verification (Implementer) | `git status --porcelain` without the `JENKINS_REPLACEMENT_*` files; `git ls-files \| grep -c JENKINS_REPLACEMENT_` = 0; `git check-ignore` → `.gitignore:2` and `:3`; both files still on disk; HEAD `41f4c3e` |
| Red run | Before the `.gitignore`: both `JENKINS_REPLACEMENT_*` files appeared as `??` |
| Falsifier | Removing the `..._AKILI_CONTEXT.md` line → `?? JENKINS_REPLACEMENT_AKILI_CONTEXT.md` reappears; reverted |
| Evidence re-run | **VERIFIED** (Leader inline): same outputs |
| Reviewer | **PASS** (`opus`, independent context). Override (f), security surface, applied |
| ADVISORY | (1) Record P-26 → done; (2) global `safe.directory` → reported to the owner; (3) `.env.*` ignores `.env.example`: add `!.env.example` if a task creates it; (4) `.local/` and `.codegraph/` ignored, no task may version anything there |
| Requirements | NFR-02, NFR-10 · design §4.1, §4.2 |
| Decisions | **Spec edit during execution:** design §11, row P-26 → verified (`git ls-tree -r --name-only origin/main` → `LICENSE`, `41f4c3e`) and count line → 4 verified / 23 `UNVERIFIED` (Low 13). Does not change the meaning of any requirement |
| Leader decision | `.gitattributes` added (`* text=auto eol=lf`, `*.sh eol=lf`) because the global configuration uses `autocrlf` and the deploy script must have LF to run on Linux. It is repository hygiene and does not widen the functional scope |
| Deviation | The Implementer added `git config --global --add safe.directory D:/executor_component` because Git would not operate due to an ownership mismatch on Windows. It is a machine configuration, outside the repo. Reversible with `git config --global --unset safe.directory D:/executor_component` |
| spawns | implementer 23 calls, 64577 tokens, ended complete; reviewer 8 calls, 51233 tokens, ended complete |

### T-01 — Executor project skeleton and ports · in progress

| Field | Value |
|---|---|
| Attempt 1 | Files: `executor/` (package.json, tsconfig, eslint, vitest, Dockerfile, .dockerignore, ports ×9, stubs per §4.2, `test/unit/dockerfile-boundary.test.ts`). Implementer verification: typecheck, lint and tests green (3/3). Falsifier: `apt-get install docker.io` → red. Evidence re-run: **VERIFIED** (Leader inline). Image build and inspection: **DEFERRED** (no Docker daemon) |
| Reviewer attempt 1 | **FAIL** (`opus`). (1) The static guard has blind spots: `FROM docker:27-cli`, `COPY --from=docker`, `apk add docker`, `get.docker.com`, JDKs other than openjdk, `python3-pip`, npm/pnpm/yarn/corepack and `USER 0`. The task's Red run does not turn red. (2) The runtime image keeps npm/npx/corepack and runs `npm ci` → violates NFR-01. (3) Node 20 reached end of support on 2026-04-30 → not LTS (DD-15). Full report copied into attempt 2 |
| ADVISORY attempt 1 | `WriteCondition` with `expectedVersion` only (consider `expectedStatus` before T-08); `StepHandler` will need a two-phase shape for `ssh` T6 (T-13); `tsconfig.build.json` with `skipLibCheck: false` for src; `validate` is a TODO that exits 0 (false-green risk before T-21); the socket mounted at run time is checked on the host (DD-18); development-only vulnerabilities in vitest 2.x |
| Attempt 2 | In progress: high effort; Node 22 LTS; scanner with negative fixtures; runtime without npm |
| spawns | implementer 65 calls, 136483 tokens, ended partial (image deferred); reviewer 7 calls, 73126 tokens, ended complete |
| Attempt 2 | Files: `executor/Dockerfile` (3 stages, `node:22-slim`, runtime without npm/npx/corepack, non-root), `package.json` (engines `>=22`, `@types/node ^22`), `test/support/dockerfile-boundary-scanner.ts`, `test/unit/dockerfile-boundary{,-scanner}.test.ts`. 27/27 tests. Falsifier `FROM docker:27-cli AS runtime` → red. Evidence re-run: **VERIFIED** (27/27) |
| Reviewer attempt 2 | **FAIL** (`opus`). Findings 2 and 3 resolved. Scanner bypasses remain: (1) stage alias (`FROM docker AS tools` + `COPY --from=tools`), `--platform`, `${ARG}`; (2) `FROM builder` as the final stage evades the npm-removal rule; (3) the first `USER` is evaluated, not the last; (4) `NODE_ENV=… npm`, absolute paths, exec form, `npx`, lax removal; (5) yarn remains in `/opt/yarn-*` |
| Leader adjudication (before attempt 3) | Per the T-01 text, the **gate is the inspection of the built image**. The static scanner is a best-effort pre-check, not the gate. A complete static analyzer against an adversarial reviewer is outside the task's scope (narrow-never-widen). Attempt 3 fixes the 5 findings with fixtures and adds `scripts/inspect-image.mjs` (the real gate). Without a daemon, that script returns `DEFERRED` with a distinct code and never PASS |
| spawns (attempt 2) | implementer 34 calls, 99064 tokens, ended partial (image deferred); reviewer 10 calls, 67069 tokens, ended complete |
| Attempt 3 | Files: `test/support/dockerfile-boundary-scanner.ts` (5 findings fixed), `Dockerfile` (+ `rm -rf /opt/yarn-*`), `scripts/inspect-image.mjs` (real gate; `DEFERRED` with exit 3 without a daemon), `package.json` (`inspect:image`), `test/fixtures/dockerfiles/Dockerfile.falsifier-docker-cli`, tests (44/44). Falsifier: 13 new tests red against the attempt-2 logic and green after the fix. Evidence re-run: **VERIFIED** (44/44; `inspect:image` → `DEFERRED`, exit 3) |
| Reviewer attempt 3 | **FAIL** (`opus`). The 5 attempt-2 findings and the Dockerfile are conformant. The real gate has (1) a symlink blind spot: `find` uses only `-type f`/`-type d`, and on Debian mvn, java, gradle and apt's npm/yarn are symlinks into `/usr/share` or `/usr/lib/jvm`, outside `SCAN_DIRS` → false PASS; (2) it does not check the mounted socket (`Config.Volumes`, `/var/run/docker.sock`), which the task's verification requires |
| ADVISORY attempt 3 | `process.exit()` inside `try` skips the `finally` (the test image is not cleaned up); `find` errors hidden → a positive control is missing (`/usr/local/bin/node` must be found); more specific `DEFERRED` message; static-scanner gaps out of scope; digest pin pending |
| spawns (attempt 3) | implementer 49 calls, 159899 tokens, ended partial (image deferred); reviewer ended complete |

## HALT: T-01

| Field | Value |
|---|---|
| Cause | 3 attempts with Reviewer FAIL (rework limit) |
| FAIL 1 | Narrow regex guard; runtime with npm; Node 20 out of support |
| FAIL 2 | Static scanner bypasses (stage alias, `FROM builder`, last `USER`, npm normalization, yarn in `/opt`) |
| FAIL 3 | The real gate `inspect-image.mjs` does not follow symlinks or widen its search paths (mvn, java, gradle, apt's npm); does not check the mounted socket |
| Final verification | typecheck and lint clean; 44/44 tests; `inspect:image` → `DEFERRED` (exit 3) |
| Leader hypothesis | **Not a spec ambiguity nor an unviable approach.** The cause is the combination of (a) a gate that cannot run (no Docker daemon), which forces approximating it with static logic that the Reviewer attacks adversarially, and (b) real but bounded gaps in each iteration. The remaining defects are concrete and small (symlinks and search paths, socket check) |
| Tree state | Only the uncommitted T-01 changes (`executor/`). T-00 was already committed. **No rollback applied:** the Leader suspended the protocol's `git restore`/`git clean` until the owner's decision, so as not to destroy mostly conformant work (skeleton, ports and Dockerfile approved by the Reviewer) |
| Owner decision after the HALT | Authorizes an **exceptional 4th attempt** limited to the image-inspection gate: symlinks and search paths, socket check and the three robustness advisories (cleanup in `finally`, positive control and `find` status, specific `DEFERRED` message). If it passes, T-01 stays `[~]` only for the real run deferred until Docker is available, and work continues with T-02 |
| Attempt 4 (exceptional) | Files: `scripts/inspect-image.mjs` (rewritten with pure functions), `scripts/inspect-image.d.mts`, `test/unit/inspect-image.test.ts` (20), `test/fixtures/dockerfiles/Dockerfile.falsifier-maven`, `dockerfile-boundary.test.ts`. 65/65. Falsifiers: the `-type l` filter and the volume check turn red when reverted. `inspect:image` → specific `DEFERRED`, exit 3. Evidence re-run: **VERIFIED** |
| Reviewer attempt 4 | **FAIL** (`opus`). Resolved: symlinks, volumes and the three advisories. New false-PASS gaps in the gate: (1) `/app` is excluded entirely → npm/pnpm/yarn as a production dependency (or binaries copied into `/app`) are invisible; (2) the sweep runs as a non-root user and filters "permission denied" → it does not see toolchains under `/root`; (3) the positive control (`command -v node`) does not prove that `find` ran; `find`'s exit status is not read; a failure of `/tmp` or `grep` leaves the sweep empty and "clean" |
| ADVISORY attempt 4 | `VOLUME /run` (on Debian `/var/run` → `/run`); the socket check inside the container cannot trigger, because the mount is decided at deploy time: the message must not overstate it; the PASS message should mention the volume and socket checks |
| spawns (attempt 4) | implementer 48 calls, 122459 tokens, ended partial (image deferred); reviewer ended complete |
| Owner decision (environment validation) | The owner cannot run Docker on his Windows machine because of permission and environment restrictions. **Instruction:** validate locally everything that does not require Docker. `docker build`, runtime image inspection, runtime NFR-01 verification and container start and health become **environment-dependent deferred validation**, mandatory before deploying to the microservices server. NFR-01 is not weakened, the architecture is not changed, no Docker alternatives are installed and the machine configuration is not changed. **Spec edit:** `tasks.md` T-01, new row "Environment validation". Does not change the meaning of any requirement |
| Attempt 5 (flow continues under the owner's decision) | Fix the 3 attempt-4 findings in the deferred gate (sweep of `/app`; sweep as root with a separate non-root check; the positive control proves that `find` ran and its exit status is read) and the advisories (`/run`, messages without overstatement). Add a dependency check. Local verification only |
| Attempt 5 | Files: `scripts/inspect-image.mjs` (sweeps `/app`; runs as root with `--user 0`; non-root user checked via `Config.User`; `find` is its own positive control; its exit status is read; any `find` error = FAIL; `/run` included; bounded PASS message), `scripts/inspect-image.d.mts`, `test/unit/inspect-image.test.ts` (41), `package.json` (`check:deps`, `check:local`). Local verification: `check:local` green (86/86, `npm audit --omit=dev` with no vulnerabilities). `inspect:image` → `DEFERRED` (exit 3). Falsifiers: 4 mutations red, reverted. Evidence re-run: **VERIFIED** |
| Reviewer attempt 5 | **PASS** (`opus`). The 3 findings and the advisory resolved; no false-PASS paths in the Dockerfile or the fixtures; local gate met; no NFR-01 regression |
| Final ADVISORY | (1) `evaluateUser` checks the name, not the UID: a `useradd -o -u 0` would pass (unreachable today); the effective UID should be resolved in the real run. (2) Scoped or renamed packages (`@yarnpkg/cli-dist`, `@pnpm/exe`). (3) Stale Dockerfile comment ("find/id"). (4) `check:deps` needs registry access. (5) Digest pin of `node:22-slim` pending |
| **ENVIRONMENT-DEPENDENT DEFERRED VALIDATION (mandatory before deploying)** | In an environment with Docker: `npm run inspect:image` against the real `Dockerfile` (expected PASS) and against `test/fixtures/dockerfiles/Dockerfile.falsifier-docker-cli` and `Dockerfile.falsifier-maven` (expected FAIL), plus container start and health. The digest pin is also pending |
| Final status | **PASS (local portion)**. T-01 `[x]` per the owner's decision, with the environment validation deferred and recorded |
| Requirements | NFR-01, NFR-08 · DD-01, DD-05, DD-15, DD-19, §4.2 |
| Decisions | Leader adjudication (the gate is the real image; the scanner is a pre-check); exceptional 4th attempt authorized by the owner; reclassification of the environment validation by owner decision; `CLAUDE.md` updated (Node 22 LTS, `check:local`, `inspect:image`) |
| Budget | T-01 consumed 5 review rounds (≈1.5 budgeted per task). Spec cumulative: 7 rounds in 2 tasks. Within the total (~50), with a trend being watched |
| spawns (attempt 5) | implementer 62 calls, 157412 tokens, ended partial (Docker deferred by owner decision); reviewer ended complete |

> **Progress mode (2026-10-05):** the owner's instruction ("run T-00 to T-22 and stop at the end") is treated as approval of routine progress within Gate A: the continue-or-pause gates between tasks are passed with the record `auto-approved (owner Gate A mandate)`. HALT, Pivot, budget tripwire, `FATAL_FAIL`, an open decision or an environment-dependent deferred validation still stop for the owner.

### T-04 — State machine: closed list T1–T13 · in progress

| Field | Value |
|---|---|
| Attempt 1 | Files: `executor/src/domain/state-machine/index.ts`, `executor/src/domain/errors/index.ts`, `executor/test/unit/state-machine.test.ts` (576 tests; Cartesian product of 520 cases). Falsifier T9 50→40 → 5 red. Red run (reject everything) → 69 red. Evidence re-run: **VERIFIED** (576/576, 0 type errors in its files, lint clean) |
| Reviewer attempt 1 | **FAIL** (`opus`). (1) The **execution** state machine (QUEUED…CANCELLED) is missing, and it is within T-04's scope per FR-05. (2) Guards are never tested with false values: deleting almost any guard leaves the suite green. (3) T7/T8 accept codes that bypass §7.2 and the canonical rule (`FAILED(TARGET_BUSY)`, `LOCK_TIMEOUT`, `INVALID_TRANSITION`, `DEPLOY_WINDOW_CLOSED` on non-ssh, FAILED without a code) |
| ADVISORY attempt 1 | Tautological tests (L259, L489, L210); T3 does not increment `attempt`; `ssh` T6 without a V4 entry; deadlines owned by the application layer; `classifyDeployExitCode` throws on 0 |
| Attempt 2 | In progress. Effort xhigh. Leader guidance: the execution chain is specified in the source (proposal §10.6 and the FR-05 table): QUEUED→RUNNING→{SUCCEEDED, FAILED, TIMED_OUT, CANCELLED}. Do not invent transitions; a gap is reported as a spec gap |
| spawns (attempt 1) | implementer 49 calls, 184284 tokens, ended complete; reviewer 14 calls, 89825 tokens, ended complete |

### T-02 — Versioned schemas and semantic definition · in progress

| Field | Value |
|---|---|
| Attempt 1 | Files: `schemas/{pipeline,targets,event}.schema.json`, `pipeline-definitions/prms/reporting-dev.yaml`, `pipeline-definitions/targets/dev.yaml`, `executor/test/contract/*` (25 tests), `executor/package.json` (ajv, ajv-formats and yaml as dev). Falsifier: removing `deployWindowPolicy` from `oneOf[0].required` → red. Evidence re-run: **VERIFIED** (`check:local` 687/687; internal-identifier search clean) |
| Reviewer attempt 1 | **FAIL** (`opus`). (1) A negative case for "omits the external deployers declaration" and a positive one for the `none` + `not-required` branch are missing. (2) Spec tension: `none` ⇒ `not-required` in the schema versus the §7.7 table, which allowed `required` + empty. (3) `interpolableString` accepts `$(...)` and backticks (embedded script, FR-01 `AND IT MUST`) |
| ADVISORY attempt 1 | Message "reserved, not enabled" → T-03 (reusable list in `$defs`); `STEP_RETRY`/`LOCK_RETRY` require `status` (validate with T-07); `openedBy`/`externalJobsDisabled` at the top level and `closesAt` missing; ajv and yaml must become production dependencies in T-03; no dedicated case for omitting `migrationCompatibility` |
| **Spec amendment (tension → owner)** | The owner approved "`none` ⇒ `not-required`". Edit of design §7.7 (table and "Versioned form"): the empty list requires `not-required`, and `required` + empty is invalid. Recorded for the next task's Reviewer brief |
| Attempt 2 | In progress: corpus cases for (1), rejection of `$(`, backticks and a bare `$` for (3), `$comment` aligned with the amendment for (2) |
| spawns (attempt 1) | implementer 79 calls, 205259 tokens, ended complete; reviewer 12 calls, 92152 tokens, ended complete |
| Attempt 2 | Files: `schemas/pipeline.schema.json` (strict `interpolableString`, `argString` without `;|&<>`), `schemas/targets.schema.json` (`$comment` aligned with the amendment), `executor/test/contract/{targets,pipeline}-schema.contract.test.ts` (33 tests). Falsifiers: removing `externalDeployersRef` from `required` → red; allowing `$(` → red; allowing a backtick → red. Evidence re-run: **VERIFIED** (33/33; internal-identifier search clean) |
| Reviewer attempt 2 | **PASS** (`opus`). The 3 findings resolved; conformant with design §7.7 as amended on 2026-10-05; no regressions in the allowed interpolations |
| Final ADVISORY | (1) `\n`/`\r` are not excluded in `argString`. (2) CodeBuild `env` values accept loop-shaped text (not evaluated by the Executor). (3) `migration.check`/`run` are free text that reaches the target. (4) A single case per check in ssh args |
| Forward pointers (recorded) | **T-03:** restrict `migration.check`/`run` to a script-name pattern and consider closing the CodeBuild `env` keys; message "type reserved, not enabled"; `ajv`/`yaml` as production dependencies. **T-13:** every SSH arg is passed escaped (no shell interpretation); reject or escape `\n`/`\r` |
| Final status | **PASS** |
| Requirements | FR-01, FR-02, FR-04 · §6.1, §7.7 (amended), DD-11, DD-21, DD-23 |
| spawns (attempt 2) | implementer 50 calls, 120796 tokens, ended complete; reviewer ended complete |
| Attempt 2 | Files: the same 3 (execution machine E1/E2, falsifiers per guard, restriction of T7/T8 codes with a blocklist, advisories). 623 tests. Evidence re-run: **VERIFIED** |
| Reviewer attempt 2 | **FAIL** (`opus`). Attempt-1 findings 1–3 resolved. New: (1) T9 does not check that code 50 belongs to the current attempt (a stale 50 returns a live attempt to `WAITING_LOCK`); (2) the blocklist still accepts `SUPERSEDED`, `TIMED_OUT` as `FAILED` and exit codes in T7 from `DISPATCHING`; (3) T7 does not relate `reason` and `failureCode`. Advisory: T12 from `RUNNING` ssh/codebuild with `externalRef` contradicts the recovery table |
| Spec gaps (for the owner) | (a) No rule defines **which terminal state** an execution takes (aggregate of its steps). (b) `QUEUED → CANCELLED` (and any trigger of `CANCELLED`) is not specified. No transitions are invented. **Obsolete under Model B** (Gate A closure): the execution-level closed list X1–X16 (design §7.3) replaces the step aggregate, and Model B has no `CANCELLED` state |
| Attempt 3 (last) | In progress: per-transition allowlists derived from §7.2; attempt identity in T9; `reason` ⇔ code in T7; T12 aligned with the recovery table |
| spawns (attempt 2) | implementer 79 calls, 203145 tokens, ended complete; reviewer ended complete |
| Attempt 3 | Per-transition and per-type allowlists derived from §7.2; T9 with `matchesCurrentAttempt`; T7 with `reason` ⇔ `DEPLOY_WINDOW_CLOSED`; T12 from `RUNNING` accepted for lambda/source/notify and rejected for ssh/codebuild. There was one continuation of the same attempt because the Leader's directive on T12 was too narrow and the Leader corrected it. 646 tests (794 in total). Falsifiers: 6 mutations red, reverted. Evidence re-run: **VERIFIED** |
| Reviewer attempt 3 | **PASS** (`opus`). Attempt-2 findings resolved; allowlists faithful to §7.2; T12/T13 conformant with the recovery table; terminals immutable |
| Final ADVISORY | `notify` without codes in T7: the handler must always reach T6 or a result (T-16/T-19); a `RUNNING codebuild` whose build `BatchGetBuilds` cannot find has no exit → T-11 must handle it; T10 trusts the caller's `retryable` flag |
| Forward pointers | **T-11 (reconciler):** build not found by `BatchGetBuilds` → define the closure without inventing states (escalate if the spec does not cover it). **T-10:** derive `retryable` from the §7.2 codes. **T-16/T-19:** the `notify` handler always reaches T6 or a result |
| Final status | **PASS** |
| Requirements | FR-05, FR-11, FR-16 · §7.2, §7.3, DD-03, DD-04 |
| continuations | 1 (T12 directive, Leader error) |
| spawns (attempt 3) | implementer 86 calls, 231870 tokens, ended complete; reviewer ended complete |

### T-03 — `DefinitionSource` and semantic validation · in progress

| Field | Value |
|---|---|
| Attempt 1 | Files: `application/definition-service/*` (index, semantic-rules, registry-rules, reference-resolution, schema-validation), `adapters/bundled-definition-source`, `schemas/targets.schema.json` (`scriptName` for migrations, `portRef`), `pipeline-definitions/targets/dev.yaml`, unit tests (5 files) and contract tests. `ajv`, `ajv-formats` and `yaml` become production dependencies. Continuation (the Leader ruled there is no OD-Q7 block, because DD-19 packaging is in scope): `Dockerfile` with the repo root as context, copy of the 3 folders, `.dockerignore` at the root, build arg `DEFINITION_REF`, `deploy-scripts/README.md`, `resolveBuildContext` in `inspect-image`. 801/801. Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`). (1) **NFR-01 boundary:** startup resolves every reference, including `envSecretRef` (an application secret). (2) Duplicate detection over resolved values is incomplete: it does not resolve `name`, groups by the full connection secret (not by host) and compares the whole port mapping instead of the published port. (3) The image starts in production without an injected `DEFINITION_REF`; a malformed `BUILD_INFO.json` is silently ignored |
| ADVISORY attempt 1 | `portRef` and advisory (b) acceptable; definitions root from an environment variable instead of walking directories upward; one end-to-end case per schema rule through the service; T-18 must call `validateForStartup` before consuming; widen the substitution test once the planner and handlers exist |
| Attempt 2 | In progress: allowlist of fields to resolve (`envSecretRef` opaque), resolved connection value shaped with `host`, published port, resolved `name`, `requireInjectedRef` in production and `CICD_DEFINITIONS_ROOT` |
| spawns (attempt 1) | implementer 136 calls, 318403 tokens, ended complete (with continuation); reviewer ended complete |
| continuations | 1 (DD-19 packaging) |

### T-06 — Lock policy · in progress

| Field | Value |
|---|---|
| Attempt 1 | Files: `executor/src/domain/lock-policy/index.ts`, `executor/test/unit/lock-policy.test.ts` (27). Red run without clamping → 3 red. Falsifiers: cap 1000 → red (after fixing a tautology with the literal 900); elapsed as a sum → red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`). The logic is conformant. The test of the 10-attempt cap is tautological: it uses the exported constant, so changing 10 to 11 does not turn it red |
| ADVISORY attempt 1 | Fractional `delaySeconds` (SQS requires an integer); the fencing token restarts if the TTL deletes and recreates the lock → T-08 must use a monotonic condition; 60 s renewal constant; a chain test is missing |
| Forward pointers | **T-08:** target write condition with monotonic fencing (`token ≥ stored`) and never delete live locks by TTL. **T-11:** round and use `LOCK_RENEWAL_INTERVAL_SECONDS` |
| spawns (attempt 1) | implementer 49 calls, 149248 tokens, ended complete; reviewer ended complete |
| Attempt 2 | The cap test uses the literals `lockWaitAttempts` 9 and 8. `delaySeconds` is an integer (`ceil`, never > 900). `LOCK_RENEWAL_INTERVAL_SECONDS = 60` is exported. 30/30. Falsifier: cap 11 → red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`). Finding resolved; the `ceil` rounding is conformant with §7.6 |
| Final status | **PASS** |
| Requirements | FR-11, FR-16 F17–F18 · DD-09, §7.6 |
| spawns (attempt 2) | implementer 23 calls, 81903 tokens, ended complete; reviewer ended complete |
| Attempt 2 | Allowlists for resolved refs (`envSecretRef` never resolved); resolved-value duplicate detection by parsed `host`, resolved container `name`, published host port; `requireInjectedRef` in production; `BUILD_INFO.json` removed; `CICD_DEFINITIONS_ROOT`; end-to-end `validateForCi` cases; English translation of touched files. check:local 846/846. Evidence re-run: **VERIFIED** (T-03 suites 86/86, 0 type errors, 0 prod vulns) |
| Reviewer attempt 2 | **FAIL** (`opus`). Attempt-1 findings resolved; §7.7 (amended) conformant. New: (1) three Spanish fragments left (`.dockerignore`, `definition-service/index.ts`, `reference-resolution.ts`); (2) `parseResolvedExternalDeployers` echoes resolved values into error text (NFR-02, DD-23); (3) **spec tension**: design §7 `definition-service` row prohibits reading secret values, while startup reads GitHub/Slack tokens and the SSH connection secret (host+user+credential) only to prove existence (DD-23) |
| **Owner ruling (spec tension, 2026-10-05)** | **"Existence without reading" (least privilege).** `SecretProvider` gains an existence-only check (AWS: `DescribeSecret`, never the value). Credential refs (`repository.credentialRef`, Slack `tokenRef`, and the new SSH `credentialRef`) are existence-checked only at startup. `getSecret` is used at startup only for non-sensitive identifier refs. The Target Registry splits the connection into `connectionRef` (non-sensitive identity JSON `{host, port, user}`) and `credentialRef` (SSH key or password, read only by the SSH handler at use time and kept in memory). Spec amendment to DD-23 and design §7 to be applied once the in-progress English translation of `design.md` lands |
| Attempt 3 (last) | In progress: the ruling above, plus findings 1–2 and the advisory (no resolved identifiers in error text, target IDs only) |
| spawns (attempt 2) | implementer 137 calls, 236055 tokens, ended complete; reviewer 13 calls, 98641 tokens, ended complete |

### Language normalization (owner directive, 2026-10-05)

| Field | Value |
|---|---|
| Directive | Owner: all code, its documentation and commits must be in English (conversation stays in Spanish). Scope extended by the owner to the spec documents under `docs/specs/` |
| Rule placement | `CLAUDE.md` ("Language"), `AGENTS.md`, `.agents/{leader,implementer,reviewer}.md` (Reviewer item 6: Spanish in committed code is a FAIL) |
| Part 1 (code) | Translated comments, JSDoc and test titles in `domain/{state-machine,errors,lock-policy}`, their tests and `schemas/pipeline.schema.json`. No behavior change: identical test counts (646/30/43/41) green; zero Spanish by scan and manual read. Leader verified counts inline. Commit `7abda3c` |
| Leader slip | Commit `7abda3c` staged `executor/src/domain` broadly and swept in the in-progress T-07 file `domain/events/index.ts` before its review. Not destructive; T-07's review covers the full content (diff vs `206ca9f`) and its final commit will land the rest. Lesson: stage explicit paths only |
| Specs | `proposal`, `requirements`, `design`, `judgment` being translated (separate agent, fidelity checks on table rows/headings/IDs). `tasks.md` and `execution.md` translated at the end of Gate A; new `execution.md` entries already written in English |

### T-07 — Event envelope, normalization and orphan events · in progress

| Field | Value |
|---|---|
| Attempt 1 | Files: `domain/events/index.ts`, `application/event-router/{index,schema-validation}.ts`, `test/unit/event-{normalizers,router}.test.ts` (23), `test/fixtures/aws/*` (9 synthetic, marked provisional; P-1/P-17/P-18). Falsifier: disabling the externalRef check → STALE_ATTEMPT test red. Evidence re-run: **VERIFIED** (0 type errors, 23/23, lint clean) |
| Reviewer attempt 1 | **FAIL** (`opus`): four Spanish comment fragments (English-only rule). Everything else conformant (schema via DefinitionSource, FR-09/§7.2 classification, orphan paths, poison error, provisional fixtures) |
| Leader decisions for attempt 2 (execute-time, from advisories) | (B) a result for the current attempt arriving while the step is still DISPATCHING without `externalRef` returns `RETRY_LATER` (left unacknowledged for SQS redelivery) instead of being acked as orphan; Lambda correlates on the current `dispatchToken` per design §6.1 (FR-04 names `requestId`; the design is more specific and wins). (C) `environment` comes from the execution record, not hardcoded. (D) Ajv error details (no payload values) in `MalformedEventError` |
| Forward pointers | **T-10 (dispatcher):** for lambda steps `externalRef` is the `dispatchToken`; write it consistently. **T-18 (consumer):** `RETRY_LATER` and `MalformedEventError` must not be acknowledged |
| Attempt 2 | Translated fragments; `RETRY_LATER` for CodeBuild results arriving in DISPATCHING without `externalRef`; Lambda correlates on `dispatchToken`; `environment` from lookup; Ajv paths/messages in `MalformedEventError`; +4 router tests (27 total). Falsifiers: RETRY_LATER removed → red; Lambda by externalRef → red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`). No Spanish; decisions B–D sound; RETRY_LATER bounded by maxReceiveCount→DLQ and reconciler T13/T12 |
| ADVISORY | Log/metric for RETRY_LATER + DLQ triage note in runbook (T-22); EventBridge rule must filter terminal `build-status` (T-28 / infra inventory T-22); internal producers keep `attempt` current (T-10); `MalformedEventError.rawMessage` must not be dumped to logs (T-18) |
| Final status | **PASS** |
| Requirements | FR-04, FR-07, FR-09 · §6.1–§6.3, §7.2, DD-02, DD-19 |
| spawns | implementer attempt 1 113 calls 211801 tokens complete; reviewer 10 calls 93792 tokens complete; implementer attempt 2 66 calls 154269 tokens complete; reviewer complete |

### T-03 — final

| Field | Value |
|---|---|
| Attempt 3 | Owner ruling implemented (`SecretProvider.exists()`; credential refs existence-only; `connectionRef` identity-only with credential-field rejection; required `credentialRef`); no resolved values in any error text; remaining Spanish translated. 93/93. Falsifiers: 4 mutations red, reverted. Evidence re-run: **VERIFIED** |
| Reviewer attempt 3 | **PASS** (`opus`). Ruling conformant; earlier fixes intact; English-only clean; no internal identifiers |
| ADVISORY | Sanitize provider `cause.message` (possible ARN/account ID) in the AWS adapter task; formal DD-23/§7 amendment pending (spec translation); prefer an allowlist `{host, port, user}` for the identity JSON over a credential-key denylist |
| Forward pointers | **Secrets adapter (Gate B):** `exists()` via `DescribeSecret`; never surface ARNs in errors. **T-18:** call `validateForStartup` before consuming |
| Final status | **PASS** |
| Requirements | FR-01, FR-02, NFR-01, NFR-02, NFR-08 · DD-19, DD-23 (+ owner ruling), §7, §7.7 |
| spawns | attempt 1 implementer 136 calls 318403 tokens complete (+1 continuation); attempt 2 implementer 137 calls 236055 tokens complete; attempt 3 implementer 112 calls 205463 tokens complete; 3 reviewers complete |

### T-05 — Planner · in progress

| Field | Value |
|---|---|
| Attempt 1 | Files: `domain/planner/index.ts`, `test/unit/planner.test.ts` (9). Falsifier `.every`→`.some` → fan-in red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): implementation conformant; missing evidence for FR-06 "dependency failure" clauses — no in-flight-after-failure test; TIMED_OUT never exercised |
| Spec gaps for the owner (added) | (c) outcome precedence when FAILED and TIMED_OUT coexist (implementer chose FAILED > TIMED_OUT, documented); (d) whether independent pending steps keep being dispatched after a failure; (e) execution outcome when a step is SKIPPED by supersede (T4). **Obsolete under Model B** (Gate A closure): there are no steps, no planner and no `TIMED_OUT`; the execution-level closed list X1–X16 (design §7.3) defines every outcome |
| spawns (attempt 1) | implementer 30 calls, 140812 tokens, complete; reviewer complete |
| Attempt 2 | Added in-flight-after-failure and TIMED_OUT tests; cheap advisories (skip reason, T4 comment, missing finally snapshot as PENDING, ssh finally routing note). 11/11. Falsifiers: 3 mutations red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`) |
| Forward pointer | **T-10 (dispatcher):** RUN_FINALLY for a step with no Step item must not loop (create items up front or treat absent as PENDING in the conditional write); route ssh finally steps via T2 |
| Final status | **PASS** |
| Requirements | FR-06, FR-16 F5 · DD-06, §7.3 |
| spawns (attempt 2) | implementer 39 calls, 93178 tokens, complete; reviewer complete |

### T-17 — Observability · done

| Field | Value |
|---|---|
| Attempt 1 | Files: `observability/{logger,metrics,heartbeat}/*`, 5 test files (33). Falsifier: PEM pattern removed → red (an inert fixture was found and fixed first). Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): redaction leaks — presigned URL security token and `ASIA` keys; key-only tokens and `Authorization` schemes; Error instances / null-prototype objects / non-string sensitive values; suffix keys (`db_password`), multi-word quoted values, truncated PEM |
| Attempt 2 | In progress (also: fields cannot overwrite context; end-to-end corpus through the logger; heartbeat ticks on start, try/catch, atomic healthcheck write) |

### T-20 — GitHub webhook ingress · in progress

| Field | Value |
|---|---|
| Attempt 1 | New package `ingress/github-webhook/` (pure core + adapters; 25 tests). Falsifier: `timingSafeEqual` swapped → structural test red. Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): §6.6 requires `WEBHOOK_UNMATCHED` and "ignored and logged" log entries; the package logs nothing |
| Leader ruling (recorded) | The ingress uses its own minimal `PipelineDefinitionReader` (list capability) over the same bundled `pipeline-definitions/` instead of the Executor's `DefinitionSource` (no list capability; task scope limited to the ingress package). Acceptable; a future task may add a list capability to `DefinitionSource` and schema validation to the reader |
| Attempt 2 | In progress (logger port + structured entries + no-secret test; truthful comments on ref resolution; environment from definition; omit empty `after`) |

### Spec translation and amendment

| Field | Value |
|---|---|
| Translation | `proposal`, `requirements`, `design`, `judgment` translated to English; fidelity review **PASS** (identical line/row/heading/ID counts; no meaning changes); review wording suggestions applied. Commit `8081bc8` |
| Amendment applied | design v3.2: DD-23 and §7 `definition-service` row amended per the owner's "existence without reading" ruling (see T-03) |
| T-20 attempt 2 | Logger port + `StdoutJsonLogger`; `WEBHOOK_UNMATCHED`, `EVENT_IGNORED`, `MALFORMED_PAYLOAD`, `MISSING_DELIVERY_ID` entries without payload contents; NFR-02 no-secret test; environment from definition; omit empty `after`; truthful ref-resolution comments. 30/30. Falsifiers: 2 red. Evidence re-run: **VERIFIED** |
| T-20 reviewer attempt 2 | **PASS** (`opus`) |
| T-20 final status | **PASS** · Requirements FR-20, FR-03, NFR-02 · §6.6, DD-20 · spawns: implementer a1 70 calls 136111 tokens; reviewer 14 calls 93037 tokens; implementer a2 73 calls 143413 tokens; reviewer complete |
| T-17 attempt 2 | Widened presigned/AKIA|ASIA patterns, suffix-based sensitive keys with exemptions, Error normalization, generic object walk, suffix key/value and truncated PEM patterns; logger field-override fix; e2e corpus; heartbeat tick-on-start/try-catch; atomic healthcheck write. 83/83. 5 falsifiers red. Evidence re-run: **VERIFIED** |
| T-17 reviewer attempt 2 | **FAIL** (`opus`): tokens inside string content leak (key=value, JSON bodies, `X-Amz-Security-Token:` header, `ghs_`/`github_pat_`); cyclic objects crash the logger (no cycle guard; BigInt throws); `idempotencyToken` (a correlation id per DD-04) over-redacted |
| T-17 attempt 3 (last) | String-content vocabulary extended (`token`, `api_key`, `authorization`, `passwd`, `pwd`, `cookie`, `sshkey`, JSON-quoted keys, header-colon form), `gh[opusr]_`/`github_pat_`, standalone `Signature=`, URL basic-auth credentials, `secretsmanager` ARN over-redaction fixed; `WeakSet` ancestor-path cycle guard; `safeStringify` fallback (BigInt); `idempotencyToken`/`nextToken` exempted (DD-04); `Error.cause`/`AggregateError.errors`; heartbeat split try blocks. 115/115. 4 falsifiers red. Evidence re-run (Leader): typecheck + lint clean, 115/115 — **VERIFIED** |
| T-17 reviewer attempt 3 | **PASS** (`opus`): all three findings resolved; corpus still covers every §12 secret type (PEM falsifier still red when removed); exemptions exact-match only (`xDispatchToken` still redacted); `executionId` cannot be overridden by callers; EMF set matches §12; NFR-01 clean |
| Advisory (non-gating) | (1) add `private[-_]?key` / `secret[-_]?access[-_]?key` to the string-content vocabulary; (2) JSON values with escaped quotes leak the tail — use `"((?:\.|[^"\])*)"`; (3) treat Buffer/typed arrays as opaque; (4) minor over-redaction (`tokenCount=`, presigned tail); (5) test uses the AWS documentation account placeholder — prefer `<AWS_ACCOUNT_ID>`-style (relevant to T-21 guard 4); (6) Map/Set serialize to `{}` |
| Status | **Done** |

### T-22 — Infrastructure inventory and base runbooks · done

| Field | Value |
|---|---|
| Attempt 1 | `infra/RESOURCES.md` (23 resources + IAM by component + checklist), `docs/runbook.md`, `docs/resources.md`, `docs/jenkins-coexistence-log.md`. Sanitization scan clean; falsifier on the 7-day clause flipped the checklist. Evidence re-run: **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): Executor IAM blocks Slack/GitHub credential reads at point of use; S3 lacks SSE/BPA/bucket policy and worker grants; 7-day rule misdescribed; ingress Lambda missing; wrong cross-reference (#6); coexistence log lacks migration-state/snapshot columns |
| Design gap noted | FR-17 requires an alarm for executions past their deadline; design §12 lists none. Implemented as an inventory alarm on a reconciler-emitted metric (forward pointer to T-11) |
| Forward pointer | **T-11:** emit `ExecutionsPastDeadline` metric for the alarm |
| Attempt 2 | Executor IAM: `GetSecretValue` at point of use on #11–#13, `DescribeSecret` limited to #11–#13 (#14 excluded); #4 SSE + BPA + bucket policy, worker S3 grants on #17 (`executions/*/source/*` read, `executions/*/quality/*` write); 7-day expiration from object creation; ingress row #24; #6 → #23; coexistence log columns "Migration state before / after" and "DB snapshot taken"; `ExecutionsPastDeadline` alarm placeholder; `ecr:GetAuthorizationToken` accepted exception; `sqs:GetQueueAttributes`. Cross-reference script OK; falsifier deleting #24 → MISSING. Evidence re-run (Leader): sanitization scan clean, #24 present — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`): all six findings fixed; NFR-01 intact (no ECR push, build, DB or application secrets for the Executor); NFR-09 DEV-only scoping; open decisions untouched |
| Advisory (non-gating) | (a) a `> 0` alarm on `ExecutionsPastDeadline` may fire on routine reconciliation — T-11 should decide on consecutive periods or post-reconciliation counting; (b) #17's S3 grants also apply to the quality worker's Jenkins invocations — worth one sentence in IAM review; (c) #4's bucket policy principal should name the worker role itself |
| Forward pointer | **T-11:** choose the `ExecutionsPastDeadline` alarm semantics (advisory a) |
| Status | **Done** |

### T-14 — Generic deploy-container.sh · in progress

| Field | Value |
|---|---|
| T-14 attempt 1 | `deploy-scripts/deploy-container.sh` (outer orchestrator + `--internal-locked` worker under `flock -n -E 50`; `trap '' HUP` first; previous image from running container; migration before swap; restore on health failure; per-repository pruning keeping previous; 0600 runtime env files under `/tmp/cicd-<executionId>/`; `CICD_RESULT` last line) + shim test suite (9 cases). Declared deviations: `--migration-mode`, `runtime-<container>.env`, usage exit 2, isolated `fetch_runtime_secret()` (OD-Q5 pending). Falsifier (swap before migrate) → container-state assertions red with exit 20 unchanged. shellcheck not installed (SKIPPED, not PASS). Evidence re-run (Leader): `bash deploy-scripts/test/run-tests.sh` → 9 run, 0 failed — **VERIFIED** |
| Deferred (environment) | Real Docker, kernel `flock` and Linux behavior — Gate C, T-33 |
| Reviewer attempt 1 | **FAIL** (`opus`): (1) idempotent re-run (running image == `--image`) sets the restore candidate to the new image and prunes N's image, and reports different `previousImages` — violates FR-13 "previous image" and "script idempotency", §5.3; no idempotency test; (2) codes 30 and 10 and `--migration-mode temp-container` lack container-state assertions (T-14 Done/Disqualifier, DD-11). Deviations (a) `--migration-mode`, (b) `runtime-<container>.env`, (c) usage exit 2, (e) per-repository pruning accepted; (d) `fetch_runtime_secret` does **not** resolve OD-Q5 (proposal §10.10 already prescribes the credentials-file exclusion) |
| T-14 attempt 2 | Idempotent re-run keeps the `--previous` hint as restore candidate (or skips pruning without one) — `test_idempotent_rerun.sh`; container-state tests for codes 10 and 30 and for `temp-container` mode; neutral secret ref; skip semantics in the harness; `validate_token()` strict charset (exit 2 before effects); 0600 capture (environment-limited, SKIP); wording per proposal §10.10; consumer `bundled-definition-source.test.ts` updated. 14 run / 0 failed / 1 skipped; vitest 1006 passed |
| Evidence re-run attempt 2 | **MISMATCH** (Leader): `run_test()` lets `TEST_SKIPPED` override a failure, and `test_secret_not_leaked.sh` marks the whole test skipped because its 0600 sub-check cannot run on this filesystem — the secret-leak assertions can no longer fail here (gate blind). Counts as FAIL |
| T-14 attempt 3 (last) | In progress: failure precedence over skip; 0600 as a skipped assertion only; falsifier proving the leak test reports FAILED |

### T-21 — Boundary guards and validation command · done

| Field | Value |
|---|---|
| Attempt 1 | Six guards in `executor/scripts/guards/*.mjs` orchestrated by `run-all.mjs`, wired to `npm run validate` and `check:local`: (1) static Dockerfile boundary scanner (real `inspect:image` stays DEFERRED); (2) project/application denylist from `proposal.md` (provenance quoted; `risk`/`monitoring`/`swarm` excluded on false-positive grounds — judgment call); (3) schema expression smoke corpus; (4) publication-policy scan over `git ls-files` + staged with masked output, narrow literal and path+rule allowlists, optional gitignored local denylist; (5) local analysis files untracked and ignored; (6) NFR-08 fictitious second definition validated through `validateForCi`. 12 tests. Falsifier `if (project === 'prms')` → guard 2 red. Evidence re-run (Leader): typecheck + lint clean, validate 6/6, 12/12; extra Leader probe (`'aiccra'` in the planner) → guard 2 red at file:line, reverted — **VERIFIED** |
| Consumer drift noted | `bundled-definition-source.test.ts` assumed `deploy-container.sh` absent; T-14 now adds it — fix assigned to T-14 attempt 2 |
| Reviewer attempt 1 | **FAIL** (`opus`, full): (1) guard 2 denylist omits projects cited in the proposal (`clarisa`, `alliance-indicators`, `bi`, `risk`, `monitoring`) — a probe with those names stays green; violates the T-21 Disqualifier and NFR-01. `swarm` exclusion accepted (deployment technology, not a project). (2) "At image build time" neither done nor labeled deferred. Calls (b) allowlists, (c) in-memory transpile, (d) smoke corpus accepted; guards confirmed not to ship in the runtime image |
| Deferred (dependency) | Running `npm run validate` at image build time is deferred to **T-31** as a CI step before `docker build` (guards 4 and 5 need `git ls-files`, unavailable inside a Docker build context). T-31 is blocked on **OD-N1**, which stays open; not resolved by assumption |
| T-21 attempt 2 | Guard 2 adds `clarisa`, `alliance-indicators`, `bi`, re-adds `risk`/`monitoring` with per-entry `word`/`quoted` matching (common words only as whole quoted literals), corrected citations, scans non-comment lines of `deploy-scripts/**/*.sh`; guard 4 masks to ≤2 chars, scans untracked non-ignored files, adds two AWS public documentation literals to the global allowlist, requires a FAKE marker for the observability-test exemptions; whole-line `.gitignore` matching. 22 tests; full vitest 1016 passed. Evidence re-run (Leader): validate 6/6, 22/22; Leader probe (`'bi'`, `'clarisa'`) → 2 violations, reverted — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`, full): denylist now covers every project cited in the proposal (probes flagged; prose not flagged); build-time run deferred to T-31 with OD-N1 open; allowlist literals `AKIAIOSFODNN7EXAMPLE` and `s3.us-west-2.amazonaws.com` accepted as public AWS documentation values (exact match); FAKE-marker exemption verified; guards do not ship in the runtime image |
| Advisory (non-gating) | quoted-only matching misses compound forms (`'risk-dev'`, `startsWith('risk-')`); path-style S3 bucket names are not checked; results observed on Node v20.19.5 locally, not yet on Node 22 |
| Status | **Done** (build-time run deferred to T-31) |

## PAUSE: Gate A — architecture change AC-01 under evaluation (2026-10-06)

| Field | Value |
|---|---|
| Trigger | Owner request: evaluate GitHub Actions as the CI owner and the Executor as CD-only coordinator (START SIMPLE) |
| State at pause | 12/23 Gate A tasks done and pushed (T-00–T-07, T-17, T-20, T-21, T-22) |
| In-flight, frozen (uncommitted, untouched) | T-08 DynamoDB store (implementer report never delivered); T-14 deploy script attempt 3 (implementer reported done; Leader evidence re-run not performed — interrupted) |
| Analysis | `architecture-change-01.md` (status PROPOSED) |
| Resume condition | Owner approval of AC-01, coherent revision of proposal/requirements/design/tasks, scoped Judgment Day APPROVED |

## RESUME: Gate A under Model B (2026-10-06)

| Field | Value |
|---|---|
| Authority | Owner approval 2026-10-06 after the scoped Judgment Day (APPROVED); specs proposal/requirements v3.4, design/tasks v4.4 (commit 6d2fecd) |
| Scope | Gate A only: N-01…N-22 (tasks v4.4). Gate B and C not started |
| Mapping | Old T-tasks map to N-tasks per tasks §3; T-00, T-06 (partly → N-07), T-17, T-21 kept as done |
| Frozen work | T-08 files land in N-08; T-14 attempt-3 evidence is re-verified by the Leader inside N-15 |
| Environment | No local Docker; shim/static validations only; Node observed locally v20.19.5 (project targets 22) |

### N-01 — Obsolescence cleanup and guard · done

| Field | Value |
|---|---|
| Attempt 1 | Deleted `ingress/github-webhook/**`, adapters `git-cli-client`, `s3-artifact-store`, `zip-packager`, `handlers/{lambda,codebuild,notify}`, ports `artifact-store`, `git-client`, `application/step-dispatcher`; new guard 8 `obsolescence` (10 DELETED, 16 PENDING with owners N-03/N-04/N-05/N-07/N-08/N-12; import scan covers `from`, `import()`, `require`, `vi.mock`); 9 negative tests. Red run before deleting: 10 paths + 2 barrel imports. Falsifier: import of `git-cli-client` → red. Pre-review Leader correction: renumbered to guard 8 (guard 7 reserved for action-pinning). Evidence re-run (Leader): typecheck/lint clean, validate PASS, vitest 1025 passed / 17 skipped; Leader falsifier (import of `zip-packager` in the planner) → red, reverted — **VERIFIED** |
| Residual references reported | Dockerfile git comment (N-18); `docs/runbook.md`, `docs/resources.md`, `infra/RESOURCES.md` CodeBuild/Lambda/ingress rows (N-20); stale "step-dispatcher" comments (rework tasks) |
| Reviewer attempt 1 | **PASS** (`opus`, full): every §15 DELETE row deleted or PENDING with the right owner; imports (incl. dynamic, `require`, `vi.mock`) checked; nothing KEEP/REWORK deleted; residual references acceptable with their owners |
| Forward pointers | **Every owner task** (N-03, N-04, N-05, N-07, N-08, N-12) flips its PENDING entries to DELETED when it removes the path or symbol. **N-22:** add a strict mode that fails while any PENDING entry remains (advisory 1). **N-19:** add `executor/scripts` to the scan roots and drop the stale `scripts`/`ingress` roots; cover `vi.doMock`/`vi.importMock`. Next task touching `ports/queue-publisher.ts` fixes its stale comment |
| Status | **Done** |

### N-15 — `deploy-container.sh` adaptation · done

| Field | Value |
|---|---|
| Step 1: T-14 attempt-3 evidence (Leader re-run) | `bash -n` OK; `bash deploy-scripts/test/run-tests.sh` → 14 run, 0 failed, 0 whole-test skips, 1 assertion skipped (0600 bits; not reflected on this filesystem, deferred to Gate C); shellcheck SKIPPED (not installed). Leader falsifier: `cat` of the secret file to stderr in `materialize_runtime_secret` → "secret value leaked into stderr", TEST FAILED; reverted, suite green — **VERIFIED**. T-14 attempt 3 fixed failure-over-skip precedence (Leader MISMATCH of attempt 2) |
| Attempt 1 (N-15) | In progress |

### N-02 — Schemas: deployment, deploy request, internal events · done (commit together with N-05)

| Field | Value |
|---|---|
| Attempt 1 | New `deploy-request.schema.json`, `deployment.schema.json`; `event.schema.json` reduced to `LOCK_RETRY_REQUESTED`, `RECONCILE_TICK`, `DEPLOY_WINDOW_OPEN_REQUESTED`, `DEPLOY_WINDOW_CLOSE_REQUESTED`, `TARGET_RESOLUTION_RECORDED`; flat `deployment-definitions/prms/reporting-dev.yaml`; `deployment-definitions/targets/dev.yaml` copied (old `pipeline-definitions/` kept for N-03). Contract suite 103. Falsifier (nested `additionalProperties`/digest rule removed) → 7 red; permissive red run → 66 failed. Evidence re-run (Leader): `test/contract` 103/103, validate PASS — **VERIFIED** |
| Sequencing | Reducing `event.schema.json` breaks 5 old event-router tests (old types); N-05 rewrites the router. **N-02 is committed together with N-05** so no red tree is pushed |
| Reviewer attempt 1 | **PASS** (`opus`, full): exact §6.1/§6.2/§6.4 fields; nested rules exercised; `*Ref` pattern enforces DD-23; body `source` is an integrity check only — authorization stays with `SenderId` (DD-25) |
| Forward pointers | **N-10:** own the §6.2 "unit set must equal the request's" check (missing-unit and extra-unit tests) at X1 consistency. **N-05:** tighten per-type event fields (`oneOf` + `unevaluatedProperties: false`); authorize only from the `SenderId` mapping, never from body `source`. **N-03:** add negatives for raw `imageRepositoryRef`/`container`, `runtimeSecretRefs`, raw health `url`, extra `observedDigests` key; reword the targets comment that cites an unpublished source; use the same Ajv options at runtime as the contract tests |
| Status | **Done** (commit pending with N-05) |

### N-04 — State machine X1–X16 and errors · done

| Field | Value |
|---|---|
| Attempt 1 | Pure `applyTransition` with X1–X16, effect hints (`clear`, `appendTargetUnresolved`, `raiseHighestDispatched`, `conditionOnDispatchToken`, `terminal`); errors reworked (`classifyExitCode`); planner deleted (guard 8 → DELETED); temporary types-only `legacy-vocabulary.ts` for frozen T-08 files and the old router. 100 tests (72-pair matrix). Red run 92 failed; falsifier X14→QUEUED → 6 failed. Evidence re-run (Leader): typecheck/lint clean, validate PASS, 100/100; Leader falsifier X3→WAITING_LOCK → 2 failed — **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): X2 gated on an owned dedupe claim, but rejection precedes the claim (design §3.3, §7 ordering) and `REJECT#MSG#` cases have no dedupe key (§5.1) — would force claiming dedupe for unauthorized senders |
| Attempt 2 | Reject reason first, X2 without a claim; only X1 needs the claim. Leader rulings: legacy shim PENDING in guard 8 (owners N-05, N-08); `DISPATCH_INTERRUPTED` only via the reconciler request; X7 on elapsed ≥ 1,800 s **or** `lockWaitAttempts` ≥ 10 (§7.6), X14/X15 same facts. Falsifier (re-gating X2) → 5 failed. Evidence re-run (Leader): typecheck/lint clean, validate PASS, 116/116 — **VERIFIED** |
| Forward pointers | **N-10/N-12:** maintain `lockWaitAttempts`; own lock release at X6 and resource release at X14; reset `deadlineAt` at X5/X14 (§7.1). **N-05/N-06:** reuse `REJECT_REASONS` |
| Reviewer attempt 2 | **PASS** (`opus`): Issue 1 resolved; rulings (a)–(c) correct; no regressions. Committed snapshot (HEAD + N-04 only) checked in a clean worktree: typecheck 0 errors, guards PASS, vitest 474/474 |
| Status | **Done** |

### N-15 — attempt 1

| Field | Value |
|---|---|
| Attempt 1 | `--artifact <container>=<repo>@sha256:<64-hex>`; `validate_artifact_ref` in `parse_args` before effects (tags, bare repo, short/non-hex digest, `..`, leading `-`/`/` → exit 2); `--previous` validated the same; pull/run/previous by digest; pruning by digest; already-running-same-digest → exit 0 without migration/swap; shims fail loudly on non-digest pulls; 3 new cases; README updated. Suite 17/0, 1 assertion skipped (0600). Falsifier (validation disabled) → tag cases red |
| Evidence re-run (Leader) | `bash -n` OK; suite 17/0; Leader falsifier disabling the `--previous` validation → "--previous with a tag: expected exit 2, got 0", docker invoked, 1 failed; restored — **VERIFIED** |
| Deferred (environment) | `docker ps` image reporting for digest-started containers and `docker images --digests` pruning semantics → Gate C (T-33) |
| Reviewer attempt 1 | **FAIL** (`opus`): the previous image comes from `docker ps` unchanged, so a container started by tag (normal first deploy where Jenkins deploys by tag) is recorded, restored and pruning-compared by tag — violates DD-26 and FR-13 ("identified by digest", "never run by tag"). Probe: exit 30 restored `…app:123` |
| Leader ruling | Resolve the running image to `<repo>@sha256:<digest>` via image ID + matching RepoDigests; fallback without a matching RepoDigest = restore by image ID (content-addressed), reported as unresolved, never a tag. Also exclude ALREADY_CURRENT containers from restore |
| Attempt 2 | `resolve_running_image`: a `docker ps` value already in digest form is used as is; otherwise image ID → matching RepoDigest → `<repo>@sha256:<digest>`; no match → image ID marked `unresolved:sha256:<id>` (content-addressed, never a tag). Feeds RESTORE_IMAGE, previousImages, restore, already-running comparison and the pruning keep-set. ALREADY_CURRENT containers excluded from restore; README and §6.5/N-15 references updated; 3 new cases. Falsifiers (raw docker ps value stored; restore skip removed) → red. Evidence re-run (Leader): suite 20/0, 1 assertion skipped — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`): Issue 1 resolved (probe: tag-started container restored by image ID, never by tag); no regressions; genericity intact |
| Accepted deviation | `previousImages.<c> = "unresolved:sha256:<id>"` when no RepoDigest matches (DD-26 spirit: immutable, content-addressed; never a tag). Documented in the README |
| Committed snapshot | HEAD + `deploy-scripts/**` + the consumer `bundled-definition-source.test.ts` (T-14 update: script now exists): typecheck 0, lint clean, guards PASS, vitest 494/494 |
| Forward pointers | **N-08/N-09/N-12:** recognize the `unresolved:` prefix in `previousImages` and never treat it as a digest; runbook §12.2 mentions it. **Gate C (T-33):** real `docker ps`/`docker inspect`/RepoDigests/`rmi`-by-digest semantics; a container whose image cannot be inspected (today treated as absent). Advisory: empty-string `previousImages` on an already-current re-run without a hint; stray spaces at line 588 |
| Status | **Done** |

### N-07 — Supersede policy · done

| Field | Value |
|---|---|
| Attempt 1 | Pure `domain/supersede-policy`: `compareOrdering` (OLDER/EQUAL/NEWER/DIFFERENT_SOURCE; equal never older; no cross-source order), `evaluateS1` (lastDeployed, highestDispatched, highestAccepted), `evaluateS2` (max of lastDeployed and highestDispatched only), `decideRaiseMax` (absent or `stored <= new`); invalid `runNumber` throws. `evaluateSupersede` deleted from lock-policy; guard 8 entry → DELETED. 22 tests mixing arrival and run order. Falsifier `<` → `<=` → 5 failed. Evidence re-run (Leader): 49/49; Leader falsifier (different-source check removed) → 4 failed — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full) |
| Committed snapshot | HEAD + N-07 only (guard file staged with the N-07 hunk alone, because N-05 shares it): typecheck 0, lint clean, guards PASS, vitest 493/493 |
| Forward pointers | **Callers (N-10/N-12):** map `REJECTED_SOURCE_MISMATCH` to an audited outcome; FR-23 notification and "listed as unresolved" clauses; build `sourceRef` identically everywhere (repository + workflow + environment, DD-27 item 1). **N-03:** two-sources startup validation. Advisory: `SUPERSEDED.by` names the first newer attribute, not the max |
| Status | **Done** |

### N-05 — Request contract, internal events and message router · done (commit together with N-02 and N-08)

| Field | Value |
|---|---|
| Attempt 1 | `domain/request-contract` (types, 8 KB UTF-8 limit before parsing, `requestIdMatches`, `consistentWithSource`), `application/message-router` (parse → eventType → authorize via `SenderAuthorizer` port → schema → requestId → lookup → consistency → handler); rejected `DEPLOY_REQUESTED` → X2 via `applyTransition` + ack; unparseable / unknown type / invalid internal event → no ack; per-type `oneOf` + `unevaluatedProperties: false` in `event.schema.json`; `domain/events`, normalizers, `test/fixtures/aws`, old router tests deleted. Falsifier (ack unparseable) → 7 failed. Evidence re-run (Leader): tsc 0, lint clean, validate PASS, 146/146; Leader falsifier (requestId check disabled) → red — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full). Rulings accepted: unknown/invalid internal events → DLQ; unauthorized internal sender acked; `workflowRef` exact equality (fail closed); handler errors → no ack; oversized `DEPLOY_REQUESTED` → DLQ (never parse oversized untrusted input) |
| Sequencing | N-08 (in progress) already removed the types-only `event-router/index.ts` shim that N-05 left for the frozen T-08 files and observability. N-05 cannot be committed alone without that shim → **N-02, N-05 and N-08 land in one commit** after N-08's review |
| Forward pointers | **N-24 / DD-29:** pin which GitHub value `ci.workflowRef` carries and what `source.workflowRef` resolves to (caller `workflow_ref` vs SHA-pinned `job_workflow_ref`, P-G11) before N-32, or every real request ends `CONSISTENCY_MISMATCH`. **N-06/N-10:** carry `senderId` (role-ID prefix only) as audit data into `EXEC#.senderRef` and rejection records; N-06 records the intended reason when an unknown `deploymentId` makes the authorizer fail first. **N-17:** remove leftover orphan vocabulary in observability if any remains after N-08 |
| Status | **Done** (commit pending with N-08) |

### N-20 — Infrastructure inventory and runbooks · done

| Field | Value |
|---|---|
| Attempt 1 | `infra/RESOURCES.md` rewritten for Model B (OIDC provider; per-repository/environment CI role with the DD-24 trust shape — six exact `StringEquals` keys, `job_workflow_ref` at `<PINNED_COMMIT_SHA>`, 1 h; queue policy with the DD-25 per-type rule; Scheduler target role; operator principal; reduced Executor role; GitHub-side configuration incl. admin-only `CICD_BOUND_REF`, secrets only, SHA-pinned actions; DynamoDB items/TTLs; alarms); `docs/runbook.md` (§12.1 kept, §12.2 resolution procedure with the OD-A8 boundary), `docs/resources.md`, `docs/jenkins-coexistence-log.md`. Checklist derived from design §11/§5/§12: 77 items. Red run vs HEAD: 40+ missing; mutations (StringLike `sub`, `job_workflow_ref@*`) → 3 and 2 failed. Evidence re-run (Leader): 77/0, publication scan 0, Leader mutation → 2 failed — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, checklist) |
| Spec gap recorded | FR-17 requires an alarm for executions past their deadline, but design §12 names no metric; `ExecutionsPastDeadline` is a placeholder name. Owner: **N-14** (reconciler) emits it; design §12 to be amended in the Gate A closure spec sync |
| Forward pointers | **N-24 (Gate B):** the queue policy needs an explicit `Deny` for principals outside the four (an `Allow` alone does not block same-account IAM principals); CI role states DEV-only scope; shared `<ECR_REPOSITORY>` across environments recorded as residual (P-7 / OD-A7); operator principal is a role (no static keys); add `ecr:BatchGetImage` only if digest capture needs it. **N-11:** deliver `tools/resolve-target` (design §12.2 has a stray space: `tools/ resolve-target`) and mark it in runbook step 6. Removals list to name `<WEBHOOK_SECRET_REF>` (editorial) |
| Status | **Done** |

### N-03 — DefinitionService rework · done (lands in the combined N-02/N-03/N-05/N-08 commit)

| Field | Value |
|---|---|
| Attempt 1 | Port `getDeploymentDefinition`; `validateForCi`/`validateForStartup` on `deployment.schema.json` + `targets.schema.json` with the contract-test Ajv options; issues name the field; step-graph rules removed; new semantic rules (id match, unique unit/container, targetRef exists, migration requires `migrationCompatibility` + `attestedBy`); single-source rules (`lock-key-multiple-deployments`, `deployment-duplicate`; bundled source rejects duplicate ids); identifier refs resolved at startup (allowedSenderRef, source.*Ref, principal refs from the composition root); credential refs existence-only; `runtimeSecretRefs` values never touched. Deleted the pipeline schema, `pipeline-definitions/`, the pipeline contract test and the substitution test. Out of brief, to keep the build green: guards 3 and 6 retargeted to the deployment schema, `schema-paths.ts`, Dockerfile COPY path. Falsifier (one-per-lockKey rule off) → 2 failed. Evidence re-run (Leader, full tree): tsc 0, lint clean, validate PASS, vitest 590/23 skipped — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full). Rulings: guard edits acceptable (N-19 keeps the rename, guard 7 and negatives; the NFR-08 fixture rework is already done); principal-ref location is a spec gap; lockKey compared as the logical key is the real lock identity; substitution test deletion is what the task asked; `runtimeSecretRefs` untouched and Slack token existence-only are correct |
| Forward pointers | **N-17:** read principal refs from configuration (not hard-coded); look definitions up only from the validated startup result or enumerate them, so no unvalidated definition is served. **N-19:** rename guard 3 file to `deployment-schema-expressions`, add guard 7. Editorial: stale comment in `targets-schema.contract.test.ts`, the targets YAML comment citing an unpublished source; FR-01 lists `lockKey` but §6.2 keeps it in the registry (spec sync at closure) |
| Status | **Done** (commit pending with N-08) |

### N-08 — DynamoDB store reduction · done

| Field | Value |
|---|---|
| Attempt 1 | Step, step-attempt-lookup and instance-lease repositories deleted; keys per §5.1 (`DEDUPE#{deploymentId}#{requestId}`, `REJECT#…`, `DEPLOYMENT#…/SEQ`); execution-level `ExecutionItem` with conditional `update` (status + version, plus `dispatchToken`); GSI1 dropped, sparse GSI2 kept; new rejection repository (attribute_not_exists, 30 d TTL); legacy-vocabulary and event-router shims removed (observability seam types inlined). Integration (DynamoDB Local, Java 17, no Docker): 7 files / 23 tests, race 50 × 5 writers → one winner per round. Falsifier `version >=` → "expected 5 to be 1". Evidence re-run (Leader, full tree): tsc 0, lint, validate, vitest 590; integration 23/23 PASS, but the runner never exited (timeout, exit 124) |
| Reviewer attempt 1 | **FAIL** (`opus`): (1) the integration runner never exits and leaks one JVM per run — on Windows `child.kill()` ends only the javapath shim, the real jdk JVM keeps the pipes open; (2) Spanish text in landed files (comments and one runtime error message) |
| Environment cleanup | Leader stopped 5 leaked DynamoDB Local JVMs (command line under `executor\.local\dynamodb-local` only); no other java process touched |
| Attempt 2 | `stop()` kills the process tree (`taskkill /T /F`; POSIX process group) and waits for the port to close; stdout ignored; new `dynamodb-local-lifecycle.int.test.ts`; Spanish removed; `create()` and `update()` share `assertSparseIndexCovenant` + test. Evidence re-run (Leader): tsc 0, lint, validate, vitest 590 / 25 skipped; `npm run test:integration` exits 0 by itself in 14 s, 8 files / 25 tests, race min=max=1; no DynamoDB Local JVM left; no Spanish — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`) |
| Forward pointers | **N-09:** replace `lastDeployedSequence` with the ordering fields. **N-16/N-17:** remove pre-AC-01 step names left in observability (`stepId`, `STEP_NOT_FOUND`, `recordStepDuration`, orphan vocabulary). **N-22 / CI (OD-N1):** treat the integration runner SKIP path as a failure in CI; confirm the POSIX kill path on the first Linux run |
| Landing | One combined commit with N-02, N-03 and N-05 (shared files: guard 8, `schema-paths.ts`, the definition port; splitting would require hand-built intermediate versions). The full working tree was verified green before the commit |
| Status | **Done** |

### N-06 — Sender authorizer · done

| Field | Value |
|---|---|
| Attempt 1 | `createSenderAuthorizer` with the router's port shape; per-type rule (DEPLOY_REQUESTED ← that deployment's allowedSender; LOCK_RETRY_REQUESTED ← Executor; RECONCILE_TICK ← scheduler; DEPLOY_WINDOW_* and TARGET_RESOLUTION_RECORDED ← operator); role-ID prefix only, session discarded, body never an input; fail-closed reasons; `decide()` returns `{authorized, senderRef, reason}`. 26 tests. Falsifier (stub authorizing from `ci.repository`) → 3 failed. Evidence re-run (Leader): 67/67; Leader falsifier (RECONCILE_TICK mapped to CI) → 2 failed — **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): metric emitted as `UnauthorizedSender`, but design §12 and DD-25 define `RejectedRequests` by reason with the alarm on `RejectedRequests{UNAUTHORIZED_SENDER}` — the specified alarm would never fire |
| Forward pointers | **N-17:** widen the router port to `decide()`, write `senderRef` into `REJECT#…` and `EXEC#…` (FR-21 audit); decide whether to log the session suffix as labeled untrusted audit data; avoid double-counting rejections |

### N-09 — Target state with ordering and fencing · done

| Field | Value |
|---|---|
| Attempt 1 | `TargetStateRepository` rewritten (replaces `lastDeployedSequence`): `recordDeployed` fenced `token >= stored`, refuses a different source, opaque previous images (`unresolved:` marker); `highestDispatchedUpdate` (Update spec for the X9 transaction, `stored <= new`, unfenced) and standalone raise; `raiseHighestAccepted` as a separate conditional update after X1 (E2; tasks text was stale); `unresolvedAppendUpdate` for X16; `removeUnresolved` never touches ordering fields. Ordering via `decideRaiseMax` (N-07). 14 integration tests, 60-rep races. Falsifier (condition removed) → 8 failed. Evidence re-run (Leader): integration exit 0, 8 files / 37 tests, no JVM left — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full): token order implies run order under S2 + the X9 condition, so the fence alone keeps `lastDeployed` monotonic |
| Committed snapshot | HEAD + N-09 files: tsc 0, lint, guards PASS, vitest 590 / 37 skipped |
| Forward pointers | **N-12:** owns the lock-owner half of the §5.1 `lastDeployed` condition (check ownership before `recordDeployed`, or request a transaction builder); assert the companion `Put` is absent when the X9 transaction is cancelled. Editorial (closure spec sync): design §5.1 line still says `highestAccepted` is written in the X1 transaction; tasks N-09/N-10 scope text likewise |
| Status | **Done** |

### N-11 — Deploy windows: service and operator CLI · done

| Field | Value |
|---|---|
| Attempt 1 | Pure `domain/window-policy` (all external deployers covered, ≤ 8 h, `none` ⇔ `not-required`, fail-closed `isDeployAllowed`); `deploy-window-service` (idempotent open/close; `revalidate` V1→X4, V2→X8, V3→X15, V4→X10, fail-fast, never waits); `TargetResolutionService` (Executor-side preconditions; audit before the single conditional `removeUnresolved`; ports cannot write ordering fields or terminal states); operator CLI core in `executor/src/operator-cli` with `tools/deploy-window` and `tools/resolve-target` wrappers. 52 tests. Falsifier (coverage check disabled) → 3 failed. Evidence re-run (Leader): 52/52; Leader falsifier (8 h → 9 h) → 2 failed — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full) |
| Committed snapshot | HEAD + N-11 files: tsc 0, lint, guards PASS, vitest 642 / 37 skipped |
| Forward pointers | **N-17:** real SQS publisher adapter for the operator CLI (today it refuses unless `--dry-run`); pass `senderId` to the resolution handler; adapters for `TargetPolicyLookup`, `UnresolvedStore`, `ExecutionLookup`, `LockOwnerLookup`, `ResolutionAuditWriter`. **N-14:** the reconciler's GSI2 sweep closes expired open windows. Advisory: redelivered resolution after success could return an idempotent `ALREADY_RECORDED`; runbook line "close, then reopen" to extend a window |
| Status | **Done** |
| Attempt 2 (N-06) | `Metrics.recordRejectedRequest(reason)` emits `RejectedRequests` = 1 with dimension `reason` (design §12); `UnauthorizedSender` removed; the authorizer records `UNAUTHORIZED_SENDER` on every rejection; tests assert name, value and EMF dimensions; prototype-key test; redundant guard removed. Falsifier (old name) → 2 failed. Evidence re-run (Leader): 70/70; Leader falsifier (`in` instead of own-property) → prototype test red — **VERIFIED** |
| Reviewer attempt 2 (N-06) | **PASS** (`opus`). Leader alignment: `infra/RESOURCES.md` alarm row now names `RejectedRequests{reason=UNAUTHORIZED_SENDER}` (checklist 77/0) |
| Committed snapshot (N-06) | HEAD + N-06 files: tsc 0, lint, guards PASS, vitest 671 / 37 skipped |
| Status (N-06) | **Done** |

### N-10 — Identity, dedupe and execution creation · done

| Field | Value |
|---|---|
| Attempt 1 | `createExecutionService` → `deployRequested` / `rejected`: catalog lookup and unit-set equality (X2 `UNKNOWN_DEPLOYMENT` / `CONSISTENCY_MISMATCH`, no claim, no sequence) → DD-20 leased claim (BOUND → no-op; live foreign claim → not acked; expired → conditional takeover reusing the stored sequence) → sequence after the claim → X1 → bind → separate `highestAccepted` raise (E2) → S1/X3. Rejection records `REJECT#{dep}#{req}` or `REJECT#MSG#{sqsMessageId}`; `senderRef` stored as audit data. One injective `buildSourceRef` helper (`repository=…;workflow=…;environment=…`, percent-encoded). 27 unit + 7 integration tests (50 reps × 8 contenders → one execution, sequence 1; CC-2 pre-claim). Falsifier (sequence before claim) → "expected 9 to be 1". Evidence re-run (Leader): 27/27; integration exit 0, 9 files / 44 tests — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full). Redelivery table matches DD-20 incl. R2-I3; 120 s lease = DD-20's "now + 2 min" |
| Committed snapshot | HEAD + N-10 files: tsc 0, lint, guards PASS, vitest 698 / 44 skipped |
| Forward pointers | **N-17:** adapter from `TargetStateRepository` (`raiseHighestAccepted` → `{raised}`) to the `TargetOrderingPort` (`{accepted}`) and `readOrdering` from `get()`, with one integration test on the real repository; `DeploymentCatalog` over DefinitionSource; supply `senderRef` and `sqsMessageId` from the router. **N-12 / N-09 consumers:** import `buildSourceRef` — never rebuild the string. **N-19 (optional):** grep guard that no other module builds `repository=` strings. Advisory: consistent reads in `DedupeRepository.get`; tests for concurrent expired-claim takeovers and the `recordSequence` fallback; JSDoc on the lease constant citing DD-20 |
| Status | **Done** |

### Incident — staged rename leaked into commit 2f0031a (2026-10-06)

| Field | Value |
|---|---|
| What happened | N-19's in-progress `git mv` (guard 3 rename) was already staged in the index when the Leader staged and committed N-10 by explicit paths; `git commit` took the whole index, so 2f0031a contained the rename without its importer updates. `npm run validate` and `boundary-guards.test.ts` were broken at HEAD (pushed) |
| Detection | The clean-worktree check for N-18 (HEAD + N-18 files) failed on a module-not-found in `boundary-guards.test.ts` |
| Fix | Hotfix 5a39c58: import path updated in `run-all.mjs` and `boundary-guards.test.ts` (HEAD versions, path only); worktree check tsc 0, guards PASS, vitest 698 / 44 skipped. A staged deletion from N-12 (`ports/step-handler.ts`) was also unstaged before it could leak |
| Process change | Before every commit: the index must be empty before staging (`git diff --cached` empty), and the staged list must equal the task's list. Implementers must not stage (`git mv`/`git rm` → plain file operations) |

### N-18 — Dockerfile and image inspection without git · done

| Field | Value |
|---|---|
| Attempt 1 | `git` removed from the runtime stage (only `ca-certificates`); guard 1 rule `forbidden-package:git` (comment lines stripped); `inspect-image.mjs` `FORBIDDEN_NAMES` includes `git` (command -v, find -name, node_modules). Tests: real Dockerfile clean; three git fixtures red. Red run before the change → `final stage installs git package`. Evidence re-run (Leader): tests green, tsc 0; Leader falsifier (git re-added) → guard 1 red, restored → PASS. `npm run inspect:image` → **DEFERRED** (no Docker daemon; environment-dependent, mandatory before deployment) — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`) |
| Committed snapshot | HEAD (after hotfix 5a39c58) + N-18 files: tsc 0, lint, guards PASS, vitest 703 / 44 skipped |
| Deferred (environment) | Real image inspection incl. the git falsifier fixture (`npm run inspect:image -- --dockerfile test/fixtures/dockerfiles/Dockerfile.falsifier-git`) on a Docker-capable host; a file named exactly `git` in the image must be triaged |
| Status | **Done** |

### N-16 — Notifications (Slack) · done

| Field | Value |
|---|---|
| Attempt 1 | `notification-service` per design §6.6: ACCEPTED root; replies SUPERSEDED, DEPLOY_WINDOW_CLOSED, LOCK_TIMEOUT, DEPLOY_FAILED(code), UNKNOWN_TARGET_STATE (runbook link), SUCCEEDED (root rewritten with outcome/duration); REJECTED to the platform channel (reason + sender ref only); no CI notifications (OD-A5). `EVT#` claim before send (best-effort, at-most-once); `notify` never rejects; failures logged with redaction + `NotificationFailures{provider}`. Slack provider via injectable HTTP client (Node fetch), token from `SecretProvider` at point of use, never logged. Observability cleanup: pre-AC-01 step/orphan/retry-later names removed; Slack token redaction pattern added. Falsifier (EVT# check removed) → two messages. Evidence re-run (Leader): suites green, tsc 0 — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full) |
| Committed snapshot | HEAD + N-16 files: tsc 0, lint, guards PASS, vitest 719 / 44 skipped |
| Forward pointers | **N-17:** wire the service (callers, `slackThreadTs` persistence, `resolveChannel`, real `EventMarkRepository`, always supply `logsUrl` + test; platform channel/token refs for REJECTED; mark key for rejections must reuse the rejection identity `{deploymentId}#{requestId}` or `MSG#{sqsMessageId}`). **Closure spec sync:** add `NotificationFailures{provider}` and the rejection event-mark key shape to design §12/§5.1; reconcile §12 metric names (`ExecutionsAccepted`, `ExecutionsSuperseded`, `DeployDurationMs` vs code). Advisory: dedicated Slack-token entry in the redaction corpus |
| Status | **Done** |

### N-19 — Guards retarget and guard 7 "action-pinning" · done

| Field | Value |
|---|---|
| Attempt 1 | Guard 3 renamed to `deployment-schema-expressions`; guard 4 also walks `.github/workflows/`; new guard 7 `action-pinning` (YAML-parsed `uses:` at step and job level; full 40-hex SHA, `docker://…@sha256:<64-hex>`, `./` local; masked values; absent workflow → PASS with note); obsolescence scan roots fixed (`executor/scripts` added, stale roots removed, `vi.doMock`/`vi.importMock`). Evidence re-run (Leader): 56/56, validate PASS; Leader probe in a temp dir: `@v4` flagged, pinned SHA accepted — **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): the local exemption `/^\.\.?\//` also accepted `../evil` — DD-29 allows only `./` |
| Attempt 2 | `LOCAL_REF = /^\.\//`; case-insensitive `uses` keys; `*.reusable.yaml` scanned too; strict mode (`--require-workflow` / `CICD_REQUIRE_REUSABLE_WORKFLOW=1`) fails when no reusable workflow exists; unused import removed. The implementer's `../` falsifier was blocked by the permission classifier (it would weaken a repo file); the Reviewer ran it on a scratch copy: loosened regex accepts `../evil`, so the new test would go red. Evidence re-run (Leader): 60/60, lint 0 warnings, validate PASS, strict mode fails as designed — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`) |
| Committed snapshot | HEAD + N-19 files (guard 8 file staged with the N-19 hunks only; the N-12 `step-handler` line stays PENDING until N-12 lands): tsc 0, lint, guards PASS, vitest 748 / 44 skipped |
| Forward pointers | **N-22 and CI (OD-N1):** run `validate` with `--require-workflow`. **N-21:** avoid local actions and local job-level calls in the trusted workflow (nested workflows not named `*.reusable.*` are not scanned), or forbid them in its contract test. **Closure spec sync:** record the owner's wording that the trailing version comment is "where useful" in DD-29 |
| Status | **Done** |

### N-12 — Deploy coordinator · done

| Field | Value |
|---|---|
| Attempt 1 | `application/deploy-coordinator` (`evaluateQueued`, `handleLockRetry`), `ports/deploy-transport`, atomic X9 and X16 `TransactWriteItems` (`deploy-transactions.ts`), `ExecutionRepository.updateSpec()`; `ports/step-handler` deleted. 36 unit + 7 integration tests. Falsifier (`execStartedAt` after exec) → crash classified X11 instead of X16. Evidence re-run (Leader): tsc 0, lint, validate, 36/36; integration exit 0, 10 files / 51 tests; Leader falsifier (semaphore slot not released) → 23 failed — **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`, reproduced): a concurrent duplicate `LOCK_RETRY_REQUESTED` acquires the lock re-entrantly, loses X9 and releases the distributed lock while the sibling's script runs (violates §7.5, DD-09, DD-22: the target mutex must never be the only barrier). Judgement calls accepted: lease 180 s; `attempt = execution.attempt + 1`; lost session keeps the lock; target write before X12; owner check before `lastDeployed`; 2 SSH connect retries (§7.2) |
| Leader assignment | `windowClosedDuringRun` (FR-24, §7.7) assigned to N-12; no fabricated `currentImages` when `CICD_RESULT` is missing. **N-14:** re-drives use `attempt = execution.attempt + 1` |
| Attempt 2 | `acquire` reports `alreadyHeld` (same owner re-entering a live lease); a handler releases only a lock it took fresh, or after committing X9/X6 itself; on an X9/X6 conflict it re-reads and keeps the lock if the sibling is DEPLOYING. Post-exit window re-check sets `windowClosedDuringRun` (outcome unchanged). Missing `CICD_RESULT` → `currentImages` untouched, `lastDeployed` still written, `cicdResultMissing` flag. 43 unit + 8 integration tests incl. the concurrent-duplicate repro. Falsifier (release-on-conflict restored) → "expected 1 to be +0". Evidence re-run (Leader): 43/43; integration exit 0, 10 files / 52 tests, no JVM left — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`): release audit of every exit; deliberate lease-expiry cases (timeout, lost session, re-entrant handler erroring before X9/X6) are safe |
| Committed snapshot | HEAD + N-12 files: tsc 0, lint, guards PASS, vitest 791 / 52 skipped |
| Forward pointers | **N-14:** re-drive attempt = execution.attempt + 1. **Closure spec sync:** add `cicdResultMissing` and `windowClosedDuringRun` semantics to §5.1; runbook §12.2 mentions that `TARGET.currentImages` may lag `lastDeployed` when the flag is set. Advisory: compare fencingToken/acquiredAt before a loser releases (theoretical window); distinct label for the post-exit window check |
| Status | **Done** |

### N-21 — Reusable workflow and PRMS caller · done

| Field | Value |
|---|---|
| Attempt 1 | `.github/workflows/deploy-request.reusable.yml` (workflow_call; `guard` job event allowlist + input validation; Environment job `needs: guard` with bound-ref check first, account-ID mask, checkout, OIDC, ECR login, plain docker build/push with strict digest capture, jq body, one final `send-message`; identifiers only from five Environment secrets; `vars.CICD_BOUND_REF` the only variable; no local actions), `docs/examples/caller-workflow.yml`, contract test (26: 25 pass, actionlint SKIPPED — not installed). Pinned actions resolved by the implementer and **independently by the Leader** via api.github.com (checkout v7.0.1 `3d3c42e5…`, configure-aws-credentials v6.3.0 `e1253824…`, amazon-ecr-login v2.1.7 `03f1aad4…` after annotated-tag dereference) — match. Falsifier (send before build) → 2 failed. Leader falsifier (one secret changed to `vars.*`) → red — **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): the contract test does not parse the caller example, although FR-22's "CI failure → no request" relies on `deploy: needs: ci` and DD-29 requires SHA-pinned callers |
| Escalated to the owner (design gap) | If the Environment-scoped `CICD_BOUND_REF` is unset, a repository- or organization-level variable of the same name (creatable with `write` access, P-G13) may satisfy the bound-ref check, contradicting E1's "never a repository-level variable" in the degraded case without branch rules (P-G7). GitHub's documentation read at source (2026-10-06) does not state the precedence between levels → **UNVERIFIED**. Candidate mitigation (owner decision): a Gate B check (N-24/N-29) that no repository/organization variable named `CICD_BOUND_REF` exists, plus observation at N-32 |
| Forward pointers | **N-24/N-32:** pin the `ci.workflowRef` form (`github.workflow_ref` = caller workflow at `@refs/…`) that `source.workflowRef` must resolve to; confirm digest capture on GitHub-hosted runners and Environment secrets visibility in called workflows (P-G14) |
| Attempt 2 | Contract test parses the caller example (triggers, `permissions: {}`, `deploy.needs: ci`, SHA-pinned `uses`, no `secrets: inherit`, exact `with` keys and permissions, no literals); guard rejects a leading `-` in context/dockerfile; digest read via `docker inspect` RepoDigests after push (strict sha256 check). Falsifiers: drop `needs: ci` → red; allow leading `-` → red. Evidence re-run (Leader): contract 34 passed / 1 skipped (actionlint SKIPPED), `run-all --require-workflow` PASS; Leader falsifier (caller `@main`) → red — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`) |
| Committed snapshot | HEAD + N-21 files: tsc 0, lint, guards PASS, vitest 825 / 53 skipped |
| Deferred | Real GitHub run, RepoDigests on GitHub-hosted runners, Environment secrets/variables in a called workflow (P-G14), `ci.workflowRef` form — Gate C (N-32) |
| Status | **Done** |

### N-14 — Reconciler (reduced) · done

| Field | Value |
|---|---|
| Attempt 1 | `createReconciler().reconcile()`: two GSI2 queries (EXECUTION, WINDOW; scan-forbidding client), re-read before acting; overdue QUEUED → `evaluateQueued`; overdue WAITING_LOCK → fresh `LOCK_RETRY_REQUESTED` (attempt + 1) or canonical X7; overdue DEPLOYING → X16 (with `unresolved[]`) or X11, never publishes or re-runs; expired windows closed (EXPIRED); `ExecutionsPastDeadline` metric every tick; per-item failure isolation. 19 unit + 7 integration tests; X7 race handler vs reconciler → one winner, identical item. Falsifier (TIMED_OUT) → red. Evidence re-run (Leader): 25/25; integration exit 0, 11 files / 59 tests, no JVM — **VERIFIED** |
| Reviewer attempt 1 | **FAIL** (`opus`): overdue QUEUED is re-evaluated without S1/X3 (design §7, §7.1, §7.3 CW-2, FR-15 require X3/X4/X5). No-re-run property verified at source (X11 and the phase-2 `execStartedAt` write are mutually exclusive). Accepted: no orphan-lock action (leases expire, §7.5/QAS-2/DD-13 — FR-15 prose to align at closure), window closure via the store, AggregateError redelivery, attempt + 1 |
| Open obligations | **N-17:** wire `onTransitioned` so LOCK_TIMEOUT, UNKNOWN_TARGET_STATE and SUPERSEDED notify (FR-15, FR-23) + test; pass `target` to `createReconciler`; bind `reconcileTick`. **Closure spec sync:** FR-15 "orphan locks" wording vs lease expiry |
| Attempt 2 | Overdue QUEUED runs S1 (persisted `order.sourceRef`/`runNumber`, target ordering read) before `evaluateQueued`: newer → X3 conditional, nothing published; source mismatch → error, nothing written. `buildPatch` exported from the coordinator (export only) and reused for X3/X7/X11/X16. RESOURCES.md metric wording aligned. Falsifier (S1 branch dead) → 3 unit + 1 integration red. Evidence re-run (Leader): 25/25; integration 3 consecutive runs exit 0, 62/62 — **VERIFIED** |
| Reviewer attempt 2 | **PASS** (`opus`) |
| Committed snapshot | HEAD + N-14 files: tsc 0, lint, guards PASS, vitest 850 / 63 skipped |
| Status | **Done** |

### N-13 — SSH deployer adapter · done

| Field | Value |
|---|---|
| Attempt 1 | `adapters/ssh-deployer` (DeployTransport over `ssh2`): pinned host key checked in `hostVerifier` before auth (constant time, fail closed, never retried); credential from `SecretProvider` per attempt, memory only, scrubbed from errors/logs; private key by default, password only with an explicit temporary flag; SFTP delivery to `/tmp/cicd-{executionId}/` with read-back sha256 checksum before exec; every argument single-quoted, `\n`/`\r`/NUL rejected; strict last-line `CICD_RESULT`; no retry after exec; `ssh2` ^1.17.0 (0 vulnerabilities). Tests against a real in-process `ssh2` Server with runtime-generated keys: 40. Falsifier (hostVerifier always true) → mismatch test red. Evidence re-run (Leader): 40/40, lint clean, check:deps 0 vulnerabilities; Leader falsifier (single-quote escaping removed) → 2 failed — **VERIFIED** |
| Reviewer attempt 1 | **PASS** (`opus`, full). Retry budget within §7.2 (coordinator 3 attempts, adapter 0) |
| Leader-directed hardening (before commit) | HIGH advisory: a pre-existing `/tmp/cicd-{id}` with open permissions could let another local user swap the script after the checksum (FR-12) → refuse non-fresh / non-0700 directories; DD-23: no host/IP/port in SSH_CONNECT messages; `connectRetries` test-only |
| Spec gap escalated to the owner | FR-12 allows a password "only if the entry marks it temporary", but the Target Registry schema (§6.3) has no such marker; the adapter defaults to key-only (safe) |
| Forward pointers | **N-17:** `assertSafeScriptArgs(plan.scriptArgs(...))` before the X9 intent (else an unsafe argument yields X16 instead of X11); persist the delivered-script checksum on the execution (FR-12); `TargetResolver`; keep `connectRetries` at 0; confirm `getDeployScript` is bound to the definition version. **Closure spec sync:** add `/tmp/cicd-{id}.result.json` to §5.2 |

### Observed flake — N-10 parallel-duplicates integration test (2026-10-06)

| Field | Value |
|---|---|
| Observation | One run (reported by the N-14 implementer, concurrent with other DynamoDB Local runs) failed `rep 0: no other outcome or error: expected 7 to be 8` in `execution-service.int.test.ts:117` — one of 8 contenders rejected with an error other than `ClaimInProgressError` |
| Leader reproduction | 3 consecutive full integration runs: 62/62 each — not reproduced |
| Safety assessment | The single CREATED, sequence = 1 and BOUND assertions were not reached in that run; in production an unexpected error leaves the message un-acked and redelivered (idempotent), so no duplicate deploy is possible, but an unclassified race outcome exists |
| Owner | **N-22:** diagnose (log the unexpected error type in the test, run the race repeatedly), and either classify the outcome in execution-service or fix the test isolation |
| Hardening amendment (N-13) | Fresh `/tmp/cicd-{id}` mkdir 0700 only (any pre-existing directory refused, no exec, no removal); script file 0500 before the checksum; generic SSH error messages without host/IP/port (DD-23); `connectRetries` removed (coordinator owns the §7.2 loop). 43 tests; falsifier (accept pre-existing dir) → 4 red |
| Evidence re-run (N-13) | **MISMATCH** (Leader): the ssh-deployer suite is flaky — 3 of 8 runs failed with `Cannot parse privateKey: Malformed OpenSSH private key` in different tests. Counts as FAIL → attempt 2: root-cause the key generation or credential handling, ≥ 20 consecutive green runs |
| Attempt 2 (N-13) | Root cause of the flake: `ssh2`'s `utils.generateKeyPairSync("ed25519")` emits ~1.1% keys its own parser rejects (leading zero byte dropped → 31-byte field; 22/2000 reproduced). Test support now generates ed25519 keys with `node:crypto` and a hand-written OpenSSH encoder (armor assembled at runtime); new `ssh-test-keys.test.ts` parses 1000 keys. Production unaffected (keys from ssh-keygen; credentials passed byte for byte). Evidence re-run (Leader): three ssh suites 12/12 consecutive runs, 44/44 — **VERIFIED** |
| Reviewer confirmation (N-13) | **PASS** (`opus`): hardening conforms to FR-12/DD-23/§7.2; no executionId can become stuck (worst case: a session drop between exit 50 and cleanup → next attempt X11 SSH_CONNECT, terminal and visible) |
| Committed snapshot (N-13) | HEAD + N-13 files: tsc 0, lint, guards PASS, vitest 894 / 63 skipped |
| Status (N-13) | **Done** |

### N-17 — SQS consumer and bootstrap · done (Leader split: N-17a consumer/publisher, N-17b composition)

| Field | Value |
|---|---|
| Split rationale | The task carried ~15 recorded obligations from earlier reviews (composition, wiring, notifications, audit fields); split into two concurrent implementers with an explicit interface contract, reviewed separately, landed in one commit |
| N-17a attempt 1 | `inbound/sqs-consumer` (long-poll with SenderId + ApproximateReceiveCount; visibility heartbeat; delete only after `ack: true`; no visibility reset on failure; body never logged; bounded ordered shutdown) and `adapters/sqs-publisher` (integer delay 0–900). ElasticMQ 1.7.1 emulator via Java, no Docker (process-tree kill). Falsifier (delete before handler) → restart/poison/heartbeat red. Evidence re-run (Leader): unit 18/18; emulator 4 passed + 1 todo (SenderId **DEFERRED** to N-26); no JVM left — **VERIFIED** |
| N-17a review | **PASS** (`opus`). Advisories: emulator SKIPPED path exits 0 — gate evidence must quote the vitest summary, not the exit code (or add `SQS_EMULATOR_REQUIRED=1`); "restart resumes from state", `maxMessages` choice and process exit after stop → N-17b |
| N-17b | In progress |
| N-17b attempt 1 | `main/bootstrap.ts` + `composition/**`: env config (refs must be `<PLACEHOLDER>`), startup validation of ALL bundled definitions with a catalog projected only from the validated result, router on `decide()` with `senderRef` + `sqsMessageId` persisted (FR-21), no double-counted rejections, TargetOrderingPort over the real repository, plan resolver with `assertSafeScriptArgs` before X9, SSH TargetResolver (`temporaryPassword: false`), checksum persisted, lifecycle notifications wired, all handlers bound, heartbeat + ordered shutdown + exit; restart test (fresh instance resumes from DynamoDB via the reconciler). `maxMessages` 1 with `ssh slots + 2` pollers. Falsifier (skip startup validation) → 2 red. Evidence re-run (Leader): tsc 0, lint, validate, vitest 920 passed; integration exit 0, 12 files / 67 tests — **VERIFIED** |
| N-17b review attempt 1 | **FAIL** (`opus`): terminal-outcome notifications (LOCK_TIMEOUT, UNKNOWN_TARGET_STATE, SUPERSEDED…) wired but untested (FR-15 "+ notification", N-14 obligation "+ test"). HIGH advisory: an unsafe resolved argument leaves the execution QUEUED forever and each tick goes to the DLQ |
| Leader decisions | Reject unsafe resolved values at startup (§6.2 "an invalid set prevents startup") with the runtime throw as backstop; the missing QUEUED→FAILED edge for configuration errors is a **spec gap for the owner**. Secrets Manager `SecretProvider` adapter (design §15 KEEP, no N-task) → **Gate B prerequisite** before N-25/N-32. `--unit` naming collision → closure spec sync |
| N-17b attempt 2 | Terminal-outcome notifications tested: integration LOCK_TIMEOUT via a fresh instance's RECONCILE_TICK (one event in the thread, logs URL, no transport call), table-driven `lifecycle-notifier` unit test over every terminal status/code, S1 SUPERSEDED through `deployRequested`. `verifyPlansAtStartup` refuses startup when a resolved value would produce an unsafe script argument (message never contains the value; runtime throw kept as backstop; no transition added). TransactionConflict during X9/X16 rethrown (redelivery). `main/index.ts` handles `start()` rejection. Falsifiers: drop `onTransitioned` → red; swap two notifier branches → 2 of 14 red. Evidence re-run (Leader): tsc 0, lint, validate, vitest 937 passed / 74 skipped / 1 todo; integration 2 consecutive runs 12 files / 69 tests; no JVM — **VERIFIED** |
| N-17b review attempt 2 | **PASS** (`opus`) |
| Done criterion | "Executor runs end-to-end locally with a fake transport": composition integration drives DEPLOY_REQUESTED to SUCCEEDED, a rejection, LOCK_TIMEOUT and SUPERSEDED, and a crash/restart resumed from DynamoDB state. SenderId on real SQS **DEFERRED** to N-26 |
| Landing | One commit for N-17a + N-17b (shared files); the full working tree equals HEAD + N-17 and was verified green |
| Status | **Done** |

### N-22 — Gate A closure: spec sync (editorial, no new decision)

| Field | Value |
|---|---|
| Rule | Editorial and consistency sync of facts already decided and implemented. Anything that would need a decision is listed below for the owner, not resolved |
| `design.md` v4.5 | §5.1: `highestAccepted` is a separate conditional update after X1 (the "same transaction as X1" wording removed; DD-27 item 3 aligned); execution attribute `cicdResultMissing` added and the semantics of `windowClosedDuringRun`/`cicdResultMissing` stated; write-once audit fields `scriptChecksum` and `slackThreadTs`; event-mark key shape for `REJECTED` (`EXEC#REJECT#{deploymentId}#{requestId}` or `EXEC#REJECT#MSG#{sqsMessageId}`, `EVT#{eventKey}`); resolution audit item `TARGET#{lockKey}` / `LOG#RESOLUTION#{eventId}`. §5.2: `/tmp/cicd-{executionId}.result.json`, fresh 0700 directory rule and 0500 script file. §6.5: `--unit` carries the `deploymentId`. §12: metric names as implemented (`ExecutionsStarted/Succeeded/Failed`, `RejectedRequests{reason}`, `NotificationFailures{provider}`, `ExecutorHeartbeat`, `ExecutionsPastDeadline`), recorders without a caller (`LockWaitMs`, `DispatchLatencyMs`) and listed-but-unimplemented names (`ExecutionsSuperseded`, `DeployDurationMs`); FR-17 alarm `ExecutionsPastDeadline` > 0. §12.2: `tools/resolve-target` path and audit item name. DD-29: trailing version comment "where useful"; guard 7 also scans `*.reusable.yaml` |
| `requirements.md` v3.5 | FR-01: `lockKey` reached through `targetRef` (registry); FR-15: "orphan locks" replaced by lease expiry (FR-11, design §7.5); glossary "Reconciler" aligned |
| `tasks.md` v4.5 | N-09/N-10 scope text aligned (E2); §6.1 Gate B prerequisite (Secrets Manager `SecretProvider` adapter before N-25/N-32) and carry-overs; §7.1 Gate C carry-overs |
| `docs/runbook.md` | `currentImages` may lag `lastDeployed` under `cicdResultMissing`; `unresolved:sha256:<id>` previous images; exit 50 followed by a lost cleanup (next attempt `FAILED (SSH_CONNECT)`, recover with a new request); "close, then reopen" to extend a window; `LOG#RESOLUTION#{eventId}` and audit-before-removal order; metric wording |
| `execution.md` | Older T-task entries translated into English (meaning, IDs, hashes and tables unchanged); pre-AC-01 spec gaps (a)–(e) marked obsolete under Model B |

#### Spec gaps for the owner (Gate A closure)

| # | Gap | Where it surfaced | Current safe behavior |
|---|---|---|---|
| G-1 | FR-12 allows a password "only if the entry marks it temporary", but the Target Registry schema (design §6.3) has no temporary-password marker | N-13 | The SSH adapter is key-only (`temporaryPassword: false` in the composition) |
| G-2 | No `QUEUED → FAILED` transition exists for configuration errors (e.g. a resolved value that would produce an unsafe script argument); X1–X16 is closed | N-17b | Startup refuses such definitions (`verifyPlansAtStartup`); the runtime throw remains a backstop that leaves the execution `QUEUED` and the tick in the DLQ |
| G-3 | `CICD_BOUND_REF` variable precedence between Environment and repository/organization levels is **UNVERIFIED** (P-G13); a same-named repository or organization variable may satisfy the bound-ref check when the Environment variable is unset | N-21 | Candidate mitigation (not adopted): a Gate B check (N-24/N-29) that no such variable exists, plus observation at N-32 |
| G-4 | `ci.workflowRef` form: caller `workflow_ref` vs SHA-pinned `job_workflow_ref` (P-G11), and what `source.workflowRef` must resolve to | N-05, N-21 | Exact equality, fail closed (`CONSISTENCY_MISMATCH`); to be pinned at N-24 before N-32 |
| G-5 | `--unit` naming: the script argument carries the `deploymentId`, which collides with the meaning of `artifacts[].unit`; renaming the argument would change the script CLI contract | N-17b | Value is used only for temporary paths and logs |
| G-6 | Metrics listed up to design v4.4 but not implemented (`ExecutionsSuperseded`, `DeployDurationMs`), and implemented recorders with no caller (`LockWaitMs`, `DispatchLatencyMs`, the latter named by NFR-05): add, drop or wire is a decision | N-16, closure sync | Design §12 states the implemented names; NFR-05 evidence is due in Gate C (N-34) |
| G-7 | Pre-AC-01 step-model gaps (a)–(e) (T-04, T-05) | T-04, T-05 | **Obsolete under Model B**; no action |

### N-22 — Gate A closure · done

| Field | Value |
|---|---|
| Spec sync | design v4.5, requirements v3.5, tasks v4.5, runbook: editorial alignment with the implementation (metric names, §5.1 attributes, §5.2 temp paths, `tools/resolve-target`, DD-29 "where useful", FR-01/FR-15 wording, stale N-09/N-10 text); Gate B prerequisite (Secrets Manager `SecretProvider`) and Gate B/C carry-overs recorded in tasks. Older Spanish log entries translated. No new decision |
| Flake diagnosis | ~5,000 race repetitions under concurrent load: not reproduced; every conditional-write outcome in execution-service is mapped; most likely a non-conditional SDK/infrastructure error from a CPU-starved DynamoDB Local (unproven). The test now names any unexpected rejection; service unchanged |
| Gate evidence (Leader, Node **v20.19.5**; Node 22 not available locally → Node 22 run **DEFERRED**) | `npm run check:local` exit 0 (typecheck 0 errors, lint clean, build, validate, vitest 937 passed / 74 skipped / 1 todo, `npm audit --omit=dev` 0 vulnerabilities); `run-all.mjs --require-workflow` 8/8 PASS incl. guard 7 on the real reusable workflow and guard 8 with **0 PENDING** entries; `npm run test:integration` exit 0, 12 files / 69 tests, race min=max=1; `npm run test:sqs-emulator` 4 passed + 1 todo (SenderId DEFERRED to N-26); deploy-script shim suite 20 run / 0 failed / 1 assertion skipped (0600 bits); `npm run inspect:image` **DEFERRED** (no Docker daemon); no emulator JVM left |
| Falsifier | Recreated `executor/src/domain/planner/index.ts` → guard 8 FAIL "is marked DELETED … but still exists"; removed → PASS |
| Coverage | Not measurable locally: no coverage provider installed (`@vitest/coverage-v8` absent); not added without owner approval |
| Size | `executor/src`: 78 TypeScript files, 9,510 lines (incl. comments) |
| Spec gaps for the owner | G-1 temporary-password marker (FR-12 vs §6.3); G-2 no QUEUED→FAILED edge for configuration errors; G-3 `CICD_BOUND_REF` variable precedence UNVERIFIED; G-4 `ci.workflowRef` form (N-24); G-5 `--unit` naming; G-6 unemitted/unimplemented metrics (`DispatchLatencyMs` for NFR-05, `LockWaitMs`, `ExecutionsSuperseded`, `DeployDurationMs`); G-7 pre-AC-01 step gaps obsolete |
| Status | **Done** — Gate A complete; Gate B not started |

---

## Gate B — B0 (integration kit) start — 2026-10-06

- Owner approved `gate-b-plan.md` revision 2 with clarifications: SAM option (b) — `sam validate --lint` is owner-executed at the start of B1 and stays **NOT EXECUTED** until the owner reports it; validation and deployment are separate checkpoints A–D; GitHub values classified (plan §12): one Environment secret (`CICD_ROLE_ARN`), the rest Environment variables or values derived after OIDC; no static AWS keys.
- Scope authorized: K-1…K-9 only. No external mutation (AWS, GitHub, targets). B1 requires a separate approval.
- No SAM CLI or cfn-lint installed; local Node is 20.19.5 (Node 22 remains DEFERRED).

### K-2 — Secrets Manager `SecretProvider` (2026-10-06)

| Item | Record |
|---|---|
| Attempt 1 | `adapters/secrets-manager-provider` (`exists` = `DescribeSecret` only; `getSecret` = `GetSecretValue` at point of use, no cache, value unchanged; `<NAME>` → `CICD_SECRET_ID_PREFIX` + `NAME`; sanitized `SecretProviderError` with ref, operation and AWS error name only, no `cause`); optional `CICD_SECRET_ID_PREFIX` validated in `loadConfig`; wired in `main/index.ts` with the SDK default credential chain (DD-16); dependency `@aws-sdk/client-secrets-manager`. 11 unit tests on a fake client; implementer falsifiers (GetSecretValue in `exists`; AWS message in the error) → red |
| Leader evidence (non-author) | Isolated worktree (HEAD + K-2 files): tsc 0, lint clean, guards 8/8, vitest 949 passed / 74 skipped / 1 todo. Leader falsifiers: `DeletedDate` check removed → red; `SecretString` check removed → red |
| Review | Reviewer (opus): **PASS**. Advisories (non-blocking, not applied): pure prefix check could move out of the adapter module; an `undefined` DescribeSecret response returns true (unreachable with the real SDK); `loadConfig` runs twice at startup; `getSecret` leak test could also check `<AWS_ACCOUNT_ID>` |
| Not executed | Any real Secrets Manager call (owner, B1) |

### K-5 — GitHub value classification and the Gate B caller example (2026-10-06)

| Item | Record |
|---|---|
| Owner direction | Plan §12: `CICD_ROLE_ARN` the only Environment secret; `CICD_AWS_REGION`, `CICD_ECR_REPOSITORY`, `CICD_DEPLOY_QUEUE_NAME`, `CICD_BOUND_REF` Environment variables; registry, queue URL and account ID derived after OIDC and masked; no static AWS keys |
| Attempt 1 | Reusable workflow: account segment of the role ARN masked before OIDC; `mask-aws-account-id: true` (input verified in `action.yml` at the pinned SHA); `sts get-caller-identity` → mask; registry from the login step output; queue URL from `sqs get-queue-url`, fail-closed and masked before the single final `send-message`. Contract test (49 + 1 skipped actionlint) covers secret/variable sets, ordering, masking and both caller examples. New `docs/gate-b/github/caller-workflow.example.yml`. Leader spec edits: design DD-24 v4.6 (classification, CI role `sqs:GetQueueUrl`), `infra/RESOURCES.md`, `docs/resources.md`. Implementer falsifiers → red. Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 964 passed / 74 skipped / 1 todo; Leader falsifier (queue URL mask removed) → red. Review: **FAIL** — FR-22 scenario and two design sentences still stated the superseded rule |
| Attempt 2 | Requirements v3.6 (FR-22 "public-safe logs"), design DD-29 decision and §11 security row aligned, proposal pointers, N-21 supersede note, RESOURCES verification row. Review: **FAIL** — one RESOURCES verification row left |
| Attempt 3 | RESOURCES row aligned. Review: **PASS**. Advisory: P-G14 (Environment values visible in a called workflow) stays deferred to the first real run |
| Not executed | Any real GitHub run (owner, B2) |

### K-1 — SAM template for the DEV foundation (2026-10-06)

| Item | Record |
|---|---|
| Attempt 1 | `infra/sam/template.yaml` (queue + DLQ, queue policy with explicit `Deny` on `SendMessage` outside the four roles, table + GSI2 + TTL matching the code, conditional OIDC provider (Retain), CI role with the six exact `StringEquals` DD-24 claims and `sqs:GetQueueUrl`, Executor/Operator/Scheduler roles, reconcile schedule DISABLED by default, log group, five alarms, optional probe ECR repository, explicit deletion policies, outputs), `parameters.example.json`, `samconfig.example.toml`, contract test (49) with a CloudFormation-tag YAML parser. Publication guard allowlists the public service identifiers `sts.amazonaws.com` and `scheduler.amazonaws.com`. Implementer falsifiers (StringLike trust; `Resource: "*"` on the Executor) → red. Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 998 passed / 74 skipped / 1 todo; Leader falsifiers (`ArnNotEquals`→`ArnNotLike`; table `DeletionPolicy` removed) → red. Review: **FAIL** — the Scheduler `<aws.scheduler.execution-id>` is not a UUID, so every RECONCILE_TICK would fail `eventId` `format: uuid` and go to the DLQ; the test substituted a made-up UUID |
| Attempt 2 | Not resolved by assumption: recorded as spec gap **G-8** for the owner. Template comment states the gap; the schedule must stay DISABLED; the test uses the documented real-format sample and asserts the rejection; outputs add the four role IDs (DD-25 identifier secrets). Leader evidence: isolated worktree lint clean, guards 8/8, vitest 1016 passed / 74 skipped / 1 todo; typecheck 0. Review: **PASS**. Leader editorial follow-ups from the advisories: stale Input comment reworded, G-8 in the parameter description, same-account principal note. Runbook items (poison message via the operator role, single ECR repository parameter, silent trust failure if a claim key is unsupported, IAM propagation retry, EMF alarms without log shipping) → K-8 |
| Not executed | `sam validate --lint` (owner, B1 checkpoint B), any deployment |

### Spec gaps found in B0 (owner decision; not resolved by assumption)

| ID | Gap | Effect |
|---|---|---|
| G-8 | EventBridge Scheduler cannot produce a UUID `eventId` (`<aws.scheduler.execution-id>` is a short id), while `schemas/event.schema.json` requires `format: uuid` for RECONCILE_TICK | **Resolved 2026-10-06 (owner):** minimal internal RECONCILE_TICK contract without `eventId`; correlation id generated by the Executor; no new infrastructure. Schedule still created DISABLED; the owner enables it in B1 |
| G-9 | `BundledDefinitionSource.listDeploymentIds()` skips definition files that fail to parse, so the Executor starts without such a deployment instead of refusing | **Resolved 2026-10-06 (owner): fail fast** — every file is discovered, parsed and validated at startup; any problem logs the file and reason and exits non-zero |

### K-3 — Offline definitions check (2026-10-06)

| Item | Record |
|---|---|
| Attempt 1 | `executor/src/tools/definitions-check/` (`runDefinitionsCheck` + `main.ts`), npm script `definitions:check` (`tsc` then the compiled tool): `validateForCi` only (no SecretProvider, no network), OK/FAIL per deployment, exit 0/1/2; definitions from `--root`, schemas from the repository if the root has none. Compiled into the image `dist` but never imported by the runtime path (no new dependency). Implementer falsifier (always exit 0) → red. Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 954 passed. Review: **FAIL** — a definition file that fails to parse was silently skipped (false green) |
| Attempt 2 | Tool-side scan of every definition file: unparsable → FAIL with path, parser code and position (no content); file without `deploymentId` → FAIL; zero deployments → exit 1; NOTE when schemas come from the repository fallback; unused deploy-scripts fallback removed; registry-load error printed once. Implementer falsifier → red. Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 1026 passed / 74 skipped / 1 todo; Leader manual falsifier (broken YAML next to the real definitions) → FAIL naming the file, exit 1. Review: **PASS**. Known limitation (→ K-8): literal migration commands with line breaks or NUL are refused at startup but not by this check. Executor-side silent skip = spec gap G-9 |

### K-7 — Owner probe tooling (2026-10-06)

| Item | Record |
|---|---|
| Attempt 1 | `tools/gate-b/probe/`: `ssh-preflight` (prints the owner's host-key fetch/compare and strict login commands; executes nothing), `target-probe.sh` (read-only target probe: bash, `flock`, Docker CLI version only, `/tmp` mode, numeric uid/gids, `flock -n` contention on a probe-only lock separate from the deploy lock; one `CICD_RESULT` line), `executor-ssh-probe` (+ `.mjs`, `.d.mts`): reuses `SecretsManagerSecretProvider` and `Ssh2DeployTransport` unmodified, serves only `target-probe.sh`, pinned host key, fresh 0700 directory, read-back sha256, no arguments, redacted summary; `--dry-run` makes no AWS or SSH call); README. Outside the deployScript enum, `deploy-scripts/`, `deployment-definitions/` and the image. 28 tests incl. an in-process ssh2 server. Implementer falsifiers (`docker pull`; accept-all host verifier) → red. Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 992 passed; Leader falsifier (`rm -rf` appended) → red. Review: **PASS** with hardening advisories |
| Hardening (before commit) | Symlink / non-regular lock path refused (`lock_path_unsafe`), noclobber create, removal only by the creating run, append-only opens, `open_failed` distinct from busy, prefix validated as a usage error, README cleanup section, leak/redaction/script-name/symlink tests (33). Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 1059 passed / 74 skipped / 1 todo; Leader falsifier (noclobber removed) → red. Re-review: **PASS**. Remaining advisories (read-only lock descriptors, theoretical FIFO hang, test tidiness) not applied |
| Not executed | Real `flock` contention (Git Bash has no `flock`); any run against a real target (owner, B4) |

### K-4 — Example definitions (2026-10-06)

| Item | Record |
|---|---|
| Attempt 1 | `docs/gate-b/examples/definitions/` (generic deployment `example-app-dev` with two units, `deploy-container.sh`, unresolved `runtimeSecretRefs` (OD-Q5), logical refs only; Target Registry entry with key-only credential (G-1), lockKey, window policy) and a README mapping every ref to the secret the owner stores, Read vs existence-only, copy commands into `executor/.local/definitions`. Test: `definitions:check` exit 0 on the example + publication scan. Implementer falsifier (deployScript removed) → red. Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 1028 passed. Review: **PASS** with owner-facing accuracy advisories |
| Follow-ups (before commit) | Host-key line format (no hostname field), connection JSON `user` required and numeric `port`, image repository form, exact source-binding forms, trailing-newline handling, absolute `CICD_DEFINITIONS_ROOT`, platform Slack refs, non-empty external deployers; test adds `jenkins` and a ref drift check. Leader evidence: isolated worktree vitest 1062 passed / 74 skipped / 1 todo; Leader falsifier (ref renamed in the README) → red. Re-review: **PASS**; its two wording advisories applied by the Leader |

### K-6 — Local Executor run kit (2026-10-06)

| Item | Record |
|---|---|
| Attempt 1 | `docs/gate-b/executor/executor.env.example` (keys of `loadConfig` + `AWS_PROFILE`, placeholders, stack-output mapping, no static keys), `tools/gate-b/run-executor.{sh,ps1}` (env file parsed without evaluation, portable Node 22 required, `dist` required, `CICD_DYNAMODB_ENDPOINT` and static keys refused, dry-run prints keys only), 14 tests with a fake node. Implementer falsifier (Node check removed) → red. Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 1073 passed; Leader falsifier (`AWS_SECRET_ACCESS_KEY` dropped from the refusal) → red. Review: **FAIL** — bash `exec` inside a subshell left SIGTERM undelivered to node (no ordered shutdown) |
| Attempt 2 | Plain `exec` in the launcher's own process; `AWS_PROFILE` required; inherited static keys removed from the child with a warning (both scripts); doc path `docs/gate-b/05-run-executor-node22.md`; value-less options → exit 2; BOM stripped; tests for SIGTERM delivery, child environment, literal values, CRLF (24). Implementer falsifier (subshell back) → red. Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 1086 passed / 74 skipped / 1 todo; Leader falsifier (unset disabled) → red. Review: **PASS** (advisory → K-8: on Windows stop with Ctrl+C) |
| Not executed | Starting the real Executor under Node 22 (owner, B1) |

### K-8 — Owner runbook `docs/gate-b/` (2026-10-06)

| Item | Record |
|---|---|
| Attempt 1 | `docs/gate-b/README.md` and `01`–`08` (SAM checkpoints A–D as separate steps with STOP conditions; secrets with `file://` values; GitHub Environment with one secret and four variables; definitions and target; portable Node 22 run; target probes; verification queries; teardown). `samconfig.example.toml` comments (copy under `executor/.local/gate-b/`; `resolve_s3` kept because unverified, extra managed stack torn down), `infra/RESOURCES.md` intro (OD-Q7 resolved: SAM), `docs/runbook.md` pointer. Leader corrections: plan B3 (a GitHub re-run is a new `requestId`, so a new execution with the same `runNumber`, not superseded; dedupe applies to SQS redelivery), `docs/resources.md` OD-Q7 row. Implementer falsifier (12-digit number) → guard 4 red. Review: **FAIL** — the setup allowed `deployWindowPolicy: not-required`, which would turn B2 into a real SSH deployment before B4/OD-Q5; the wrong-sender negative was missing |
| Attempt 2 | `required` policy with no window for B1–B4 and STOP lines; wrong-sender negative via the operator role; corrected untrusted-trigger claim; consistent key newline guidance; OIDC-provider redeploy guidance; empty overrides removed; G-2/G-4/G-6 added to limitations; history-safe prompts; exact launcher messages. Leader evidence: guards 8/8, npm test 1086 passed / 74 skipped / 1 todo, link check 90/0; Leader falsifier (public IPv4 in 07) → guard 4 red, restored → green. Review: **PASS**; its four accuracy advisories (bare role-id `senderRef`, unknown deployment also `UNAUTHORIZED_SENDER`, empty port prompt, lowercase launcher message) applied by the Leader |
| Not executed | Every documented command (owner, B1–B5) |

### K-9 — B0 closure (2026-10-06)

| Evidence | Result |
|---|---|
| `npm run check:local` (typecheck, lint, build, validate, tests, `check:deps`) | exit 0; vitest 1086 passed / 74 skipped / 1 todo (48 files passed, 13 skipped); 0 vulnerabilities |
| `npm run validate -- --require-workflow` | guards 1–8 PASS (strict) |
| `npm run test:integration` (DynamoDB Local) | 69/69, 12 files |
| `npm run test:sqs-emulator` (ElasticMQ) | 4 passed + 1 todo (SenderId deferred to real SQS) |
| Deploy-script shim suite | 20 run, 0 failed (shim only: not production Docker or Linux `flock` readiness) |
| Emulator processes after the run | none left |
| `executor/src` | 80 TypeScript files, 9,770 lines |
| Runtime used | Node 20.19.5 (Node 22 not observed: DEFERRED to the owner's B1) |

**NOT EXECUTED (owner-executed or deferred):** `sam validate --lint` (B1 checkpoint B), `sam deploy` (checkpoint D), every AWS, GitHub and target command in `docs/gate-b/`, the Executor under Node 22, real `flock` contention, real SQS `SenderId` (P-A4), `inspect:image` (Docker), P-G11/P-G14/P-G10 observations.

**Spec gaps open for the owner (at the B0 closure):** G-1…G-6 (Gate A), G-8 (scheduler execution id is not a UUID; reconcile schedule DISABLED), G-9 (unparsable definition files skipped at Executor startup). *G-8 and G-9 were resolved by the owner on 2026-10-06 — see "B0 acceptance corrections" below.*

B0 is complete. **B1 is not started and requires the owner's separate approval.**

## B0 acceptance corrections (owner, 2026-10-06)

The owner accepted B0 subject to G-8, G-9 and G-10. Each correction went through implementer → Leader non-author evidence and falsifier → reviewer → commit.

| ID | Owner direction | Result | Review |
|---|---|---|---|
| G-8 | Resolve by design, no new infrastructure; keep the Scheduler DISABLED until implemented and locally validated | Minimal internal RECONCILE_TICK contract (`specVersion`, `eventType`, `source = scheduler`, `timestamp`; a sender `eventId` is rejected); correlation id generated by the Executor; every other event type keeps a required UUID `eventId`; Scheduler Input updated; schedule still created DISABLED, enabled by the owner in B1 through the local samconfig. Design §6.4/DD-13 v4.7. Commit 43a826e. Leader falsifier (eventId back in the Scheduler Input) → 3 red | FAIL (broken enable command path, stale plan text) → **PASS** (attempt 2) |
| G-9 | Fail fast: discover, parse and validate all definition files; any problem → safe per-file error and non-zero exit | `DefinitionLoadError` listing every problem; strict entries under `deployment-definitions/` (only regular directories and lowercase `.yaml`/`.yml` files; symlinks and other files rejected); per-file attribution of validation issues; nothing starts before the check; `definitions:check` uses the same scan; `.dockerignore` ignores OS cruft at any depth. FR-01 scenario, design §6.2/DD-19 v4.7. Commit 59b2c66. Leader falsifiers (duplicate-id detection off; stray README in the root) → red | FAIL (second affected file dropped; symlinks and other files skipped) → **PASS** (attempt 2) |
| G-10 | `CICD_ROLE_ARN` is not a secret; no AWS credential or authentication secret in GitHub; OIDC only | Five Environment variables, zero secrets; pre-OIDC mask step removed (a variable prints in the step header); remaining masking is hygiene; narrow carve-out: only the CI role ARN and account ID may appear in CI logs (hosts, IPs, credential IDs, credentials and secret values stay forbidden). DD-24 v4.7, FR-22/NFR-02 v3.7, DD-23 rows, AC12, plan §12. Commit 69924b7. Leader falsifier (static key input) → 3 red | FAIL → FAIL (leftover sentences) → **PASS** (attempt 3) |

| Final evidence | Result |
|---|---|
| `npm run check:local` | exit 0; vitest 1110 passed / 74 skipped / 1 todo; 0 vulnerabilities |
| `npm run validate -- --require-workflow` | guards 1–8 PASS |
| `npm run test:integration` | 69/69 |
| `npm run test:sqs-emulator` | 4 passed + 1 todo |
| Deploy-script shim suite | 20 run, 0 failed |
| `definitions:check` on the Gate B example root | passed |
| Runtime | Node 20.19.5 (Node 22 still DEFERRED to B1) |

**NOT EXECUTED:** unchanged from the K-9 list (all SAM, AWS, GitHub, SSH/SFTP and target operations; Node 22; real `flock`; real SQS `SenderId`; `inspect:image`). Open spec gaps: G-1…G-6 only. B1 is not started.

## Gate B / B1 — pre-validation template fixes (2026-10-06)

B1-A review of the B0 template against primary sources found two defects that `sam validate --lint` would not catch:

| Defect | Effect | Fix |
|---|---|---|
| `GitHubOidcSub` pattern rejected `@` | A repository created, renamed or transferred after 2026-07-15 uses the immutable subject `repo:OWNER@OWNER-ID/REPO@REPO-ID:environment:NAME` (GitHub OIDC reference, P-G10); the stack would refuse the real value | Pattern allows `@` (wildcards and spaces still rejected) |
| `SchedulerRole` trust `aws:SourceArn` was the schedule ARN | AWS requires the schedule **group** ARN ("Confused deputy prevention in EventBridge Scheduler"); the Scheduler could not assume the role once enabled, so ticks would fail silently | `schedule-group/default`; `ReconcileSchedule.GroupName: default` explicit |

Leader evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 1111 passed / 74 skipped / 1 todo; implementer falsifiers (schedule ARN back; `@` removed) → red; Leader falsifier (`aws:SourceAccount` widened) → red. Review: **PASS** (each claim checked against public AWS/GitHub docs; advisories: SSO permission-set role recreation breaks a role-ARN trust — runbook note, owner decision; P-G11 `job_workflow_ref` form for an immutable-format platform repository stays deferred to B2). No AWS call was made.

### B1-B — owner-executed `sam validate --lint`, attempt 1 (2026-10-07)

| Item | Record |
|---|---|
| Owner result | SAM CLI 1.151.0 (bundled cfn-lint 1.43.0), `--region us-east-1`, commit 4e9a3af: `W1030 {'Ref': 'CiEcrRepositoryArn'} does not match <ARN pattern> when 'Ref' is resolved` at line 61 → "Linting failed", exit 1. **Failed — no deployment.** |
| Root cause | The CI role's ECR `Resource` and the `CiEcrRepositoryArn` output selected the repository with `!If` on a condition over a **different** parameter (`CreateProbeEcrRepository`), so the parameter default `""` could reach an ARN-typed property; only a `Rules` assertion blocked it at deploy time, and cfn-lint does not combine `Rules` with resolved Refs (cfn-lint 1.43.0 `conditions.satisfiable` only constrains a Ref through conditions that test the same parameter). The same structure also silently ignored a supplied ARN when the switch was true |
| Fix | One parameter decides: `UseExistingEcrRepository = Not(Equals[CiEcrRepositoryArn, ""])`, `CreateProbeRepository = Equals[CiEcrRepositoryArn, ""]`; `CreateProbeEcrRepository` and the `Rules` block removed; no suppression, no new infrastructure. Sentinel audit: `ExistingGitHubOidcProviderArn` and `AlarmTopicArn` were already guarded by conditions on themselves. New contract-test walker: every Ref to an empty-default parameter must sit in the non-empty branch of an `If` testing that parameter. Examples, `01-aws-sam.md` and plan §5 updated |
| Evidence | Isolated worktree tsc 0, lint clean, guards 8/8, vitest 1114 passed / 74 skipped / 1 todo; implementer falsifiers (old shape; bare `AlarmTopicArn` Ref) → red; Leader falsifier (OIDC `If` branches swapped) → red. Review: **PASS** (checked against cfn-lint 1.43.0 source). `sam validate --lint` itself: NOT EXECUTED by Claude — owner re-runs it |

### B1-B — owner-executed `sam validate --lint`, attempt 2 (2026-10-07)

| Item | Record |
|---|---|
| Owner result | Commit 1402982: `E1029 Sub is required if a variable is used in a string (embedded parameter "${Stage}" outside of an "Fn::Sub" at Parameters/CiEcrRepositoryArn/Description)` line 63 → "Linting failed", exit 1. **Failed — no deployment.** The W1030 of attempt 1 no longer appears |
| Root cause | The `CiEcrRepositoryArn` parameter Description (plain text, never substituted) contained the literal `cicd-poc-${Stage}-probe`, introduced by the Leader's brief in the W1030 fix. No other `${` outside `Fn::Sub` in the parsed template |
| Fix | Description text `cicd-poc-<Stage>-probe` (no `Fn::Sub`, no suppression). Contract guards: no `${` outside an `Fn::Sub` template string (E1029); every `Fn::Sub` template string contains `${` (W1020); probe repository name pinned to `!Sub cicd-poc-${Stage}-probe`. ECR selection of 1402982 unchanged |
| Attempt 1 of the fix | Review **FAIL**: the implementer's falsifier `sed` replace-all also changed the probe `RepositoryName` to `!Sub cicd-poc-<Stage>-probe` (would have triggered W1020 and E3031); not covered by any test. Attempt 2 restored it; the template diff is the line-63 Description only (Leader verified with `git diff -U0`) |
| Evidence | Isolated worktree tsc 0, lint clean, guards 8/8, vitest 1119 passed / 74 skipped / 1 todo; implementer falsifier (`<Stage>` on the repository name) → 2 red; Leader falsifier (variable-less `!Sub` schedule name) → red. Review: **PASS**, including a static sweep of the whole template against the cfn-lint 1.43.0 rule families (E1019/E1029/W1020/E2001/E2015/W2001/W8001/W1001/W3011/W3037/E3012/E3031) with no further expected finding; schema-dependent low-risk items: OIDC provider without `ThumbprintList`, alarm `Tags`, ECR `EmptyOnDelete`. `sam validate --lint`: NOT EXECUTED by Claude — owner attempt 3 pending |

### B1-B — owner-executed `sam validate --lint`, attempt 3 (2026-10-07): **PASS**

| Item | Record |
|---|---|
| Owner result | Commit e8ee25c, SAM CLI 1.151.0 (bundled cfn-lint 1.43.0), `sam validate --lint --template-file infra/sam/template.yaml --region us-east-1` → `D:\executor_component\infra\sam\template.yaml is a valid SAM Template`, exit 0. (An update notice for SAM CLI 1.167.0 was printed; the owner keeps 1.151.0, which validated the template.) |
| Status | **B1-B complete** (checkpoints B and C of plan §11). Next: B1-C, parameter resolution with owner-executed read-only discovery. No deployment yet |

## B1-C — owner-requested security review of the GitHub OIDC → AWS trust model (2026-10-07)

Method: Leader trace of the actual template and pinned workflow; independent adversarial falsifier (compromised caller workflow → OIDC → AWS); independent reviewer verifying every IAM statement against `infra/sam/template.yaml` (e8ee25c). No AWS/GitHub/docker command executed; no implementation change.

**Verdict: PASS WITH CONDITIONS.** CiRole has no excess privilege (reviewer: VERIFIED): `ecr:GetAuthorizationToken` (`*`, unscopable), push-only on one ECR repository, `sqs:SendMessage`/`GetQueueUrl` on the deploy queue; no IAM, CloudFormation, EC2, S3, DynamoDB, Secrets Manager, KMS, `sts:AssumeRole` or `iam:PassRole`; no ECR delete or pull; no queue receive/delete/purge. Every trust path from a job outside the pinned reusable workflow, a fork, another repository, an untrusted event, another branch or another platform SHA (including fork "imposter" commits) is blocked by an exact `StringEquals` condition or by the pinned workflow.

| ID | Severity | Finding | Smallest correction (not implemented) | Gate |
|---|---|---|---|---|
| SR-1 | HIGH (feasibility unverified) | `docker build` runs on caller-chosen paths AFTER OIDC credentials and the ECR login exist on the runner; input validation blocks `..`, absolute paths and remote contexts but not symlinks committed in the caller repository, so host files (runner file-command files, `~/.docker/config.json`) could plausibly be pulled into a build context; `ACTIONS_ID_TOKEN_REQUEST_*` are in the step env | Build all units before the OIDC/login steps; reject symlinked or out-of-workspace context/Dockerfile (`realpath` inside `$GITHUB_WORKSPACE`); strip `ACTIONS_ID_TOKEN_REQUEST_*` from the build environment | Before B2 (workflow only; no template change) |
| SR-2 | HIGH if credentials leak | `ci.runNumber` has no upper bound and the `ci.*` fields are self-reported; a forged DEPLOY_REQUESTED with a huge `runNumber` raises `highestAccepted` and supersedes every later legitimate run (persistent deployment denial until an operator reset) | Schema maximum plus an Executor plausibility bound relative to `highestAccepted`; operator reset runbook (spec decision on DD-27) | Before B2 |
| SR-3 | MEDIUM | Temporary Executor principal = the owner's administrative IAM user: the workstation Executor process (and its dependencies) runs as the same OS user that holds the administrative source credentials | Dedicated low-privilege workstation principal allowed only to assume ExecutorRole, with its own AWS config files (owner decision) | Before B1-C value of `ExecutorTrustedPrincipalArn` |
| SR-4 | LOW | Bound-ref binding is enforced by GitHub (Environment branch rules) and the pinned workflow step, not by the IAM trust | Add an exact `token.actions.githubusercontent.com:ref` condition (new parameter) | Owner decision before the first deploy (cheap now) |
| SR-5 | LOW | Probe ECR repository has no lifecycle policy (unbounded storage); a supplied existing repository's tag mutability is not enforced | Lifecycle policy on the probe repository; document IMMUTABLE for a supplied repository | Optional before deploy |
| SR-6 | LOW | Unrestricted `SendMessage` rate: a holder of CI credentials can flood the queue (rejections, DLQ, cost) | Detection exists (alarms); runbook | Residual |
| SR-7 | LOW | Same-account resource policies elsewhere granting `Principal: "*"` or the CiRole ARN would be reachable by CiRole | Owner account check (IAM Access Analyzer) | Residual |
| SR-8 | MEDIUM (functional, not privilege) | AWS lists `ecr:BatchGetImage` among push permissions; CiRole omits it on purpose; a containerd-based push may fail closed | Verify in B2; add the action only if the push fails | B2 |

Residual by design: whoever can run the caller workflow on the bound ref (push to the protected branch, or repository/organization admin) can deploy an image they built to the DEV target within the deploy-window policy — the same trust that branch already holds today.

### B1-C — owner-authorized security corrections SR-1, SR-3, SR-4, SR-5 (2026-10-07)

| ID | Change | Evidence and review |
|---|---|---|
| SR-4 | CiRole trust: 7th exact `StringEquals` key `token.actions.githubusercontent.com:ref` = new parameter `GitHubBoundRef` (no default, `^refs/heads/[A-Za-z0-9._/-]{1,200}$`); must equal `CICD_BOUND_REF` | Falsifiers: condition removed / `Default ""` / wildcard ref → red. Reviewer verified `ref` is an IAM GitHub key and describes the caller run (not caller-controlled) |
| SR-5 | `ProbeEcrRepository` lifecycle: keep the 100 most recent images (count-based, never empties); supplied repositories untouched | First value 30 raised to 100 after the falsifier showed ~4 runs of headroom. Falsifiers: count changed → red |
| SR-1 | Reusable workflow builds before OIDC and registry login; build inputs must resolve inside `$GITHUB_WORKSPACE` with no symbolic link on any component, no absolute path, `..`, `:` or control character; `ACTIONS_ID_TOKEN_REQUEST_*` and runtime tokens stripped from `docker build`; fail closed if any `AWS_*` is exported at build time; tag and push after login | Executable adversarial tests (fake docker, real symlinks): 19+ rejection cases. A falsifier-found trailing-newline unit collision in the guard was closed. A test regex damaged by a literal backspace character was repaired. Falsifiers: build after OIDC / token not stripped / symlink check removed / `aws` call before build → red |
| SR-3 | Dedicated workstation Executor principal documented (IAM user, only `sts:AssumeRole` on ExecutorRole, created by the owner before the deploy, policy after it); launchers require isolated `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` (absolute, under `executor/.local/aws/`, no links, hard-link count 1, not the default `~/.aws`), refuse duplicate env keys, alternative credential sources and non-key fields in the credentials file, require `CICD_EXECUTOR_ROLE_ARN` to equal the profile `role_arn`, strip alternative credential variables and disable IMDS | Three falsifier rounds (links, copies, relative paths, inherited variables, config content, duplicate keys, role pin). Leader falsifiers: metadata flag removed / duplicate-key refusal disabled → red |
| SR-7 | Owner-executed, later, read-only account resource-policy check (Access Analyzer listing and policy spot checks) documented in `07-verification.md` | Documentation |

Final Leader evidence: isolated worktree with all changed files: tsc 0, lint clean, guards 8/8, vitest 1240 passed / 75 skipped / 1 todo; repository-wide control-character scan clean. Reviewer: **PASS** (attempt 3 for SR-3; attempt 2 for the documentation path defect). The SAM template changed, so `sam validate --lint` must be re-run by the owner (NOT EXECUTED).

**Pending owner decisions (not implemented):**
- **SR-2** — `ci.runNumber` poisoning of `highestAccepted` with stolen CI credentials: decision proposal delivered to the owner (DD-27 change).
- **SR-1 residual 1l (MEDIUM, uncertain)** — a build-container escape would run in the same job that holds `id-token: write`; the robust fix is separate build and push jobs (artifact hand-off with a sha256 check), which adds pinned artifact actions.
- **SR-6, SR-7, SR-8** — residual or B2 verification, as recorded in the security review.

### B1-B — owner-executed `sam validate --lint` after the security corrections (2026-10-07): **PASS**

Commit 9558289, SAM CLI 1.151.0, `--region us-east-1` → `infra\sam\template.yaml is a valid SAM Template`, exit 0. Owner direction: SR-1 sufficiently mitigated for the PoC (separate build/push jobs deferred to production hardening); SR-2 is a blocker before B2, not before B1. Back to B1-C.

### B1-C — dedicated Executor principal and first-deploy configuration (2026-10-07): **PASS**

| Item | Record |
|---|---|
| Dedicated principal (owner-executed) | IAM user `cicd-poc-dev-executor-local` (`arn:aws:iam::<AWS_ACCOUNT_ID>:user/cicd-poc-dev-executor-local`) created before the deploy; verified: no managed or inline policies, no groups, no access keys, no console login profile (`NoSuchEntity`). Inline `sts:AssumeRole` policy and the access key wait until after the deploy / Executor start |
| Option B (owner-approved) | B2-only GitHub parameters set to fail-closed sentinels for B1: `GitHubRepositoryId=0`, `GitHubRepositoryOwnerId=0`, `GitHubEnvironment=pending`, `PinnedWorkflowSha=` 40 zeros, `GitHubOidcSub=repo:pending/pending:environment:pending`, `GitHubBoundRef=refs/heads/pending`; `PlatformWorkflowRepository` real. Replaced with real values by an in-place stack update before B2 (trust change does not replace the role) |
| Local config | `executor/.local/gate-b/samconfig.toml` (Git-ignored; holds the account ID). Leader check: all 16 template parameters valid against their `AllowedPattern`/`AllowedValues` (13 given, 3 empty defaults) |
| Next | B1-D: owner-executed `sam deploy` (NOT EXECUTED) |

### B1-C — canonical project tag (2026-10-07)

Owner requirement: `Project=ONECGIAR-CICD-Platform` identifies every AWS resource of this platform (inventory and cost). `infra/sam/template.yaml`: the tag value changed on the 15 taggable resources (2 queues, table, OIDC provider, 4 roles, log group, 5 alarms, probe ECR repository); `ReconcileSchedule` (`AWS::Scheduler::Schedule`) and `DeployQueuePolicy` (`AWS::SQS::QueuePolicy`) have no `Tags` property (CloudFormation reference, checked by the Leader). Stack-level `tags` added to `samconfig.example.toml` and the owner's local samconfig (tags the stack itself; explicit resource tags remain the source of truth). Contract tests: canonical tag on every resource outside the exact untaggable set; no legacy value; example samconfig tag. Docs 01 (A7 + canonical-tag note), 05 (`create-user` with the tag), plan §5. No permission, trust, name, sentinel or behaviour change (15 one-line template hunks). Evidence: isolated worktree tsc 0, lint clean, guards 8/8, vitest 1243 passed / 75 skipped / 1 todo; falsifiers (legacy value, tag removed, widened untaggable set, lowercase value) → red. Review: **PASS**. The template changed: owner `sam validate --lint` re-run required (NOT EXECUTED).

### B1-D — owner-executed first `sam deploy` (2026-10-07): **PASS**

Stack `cicd-poc-dev`, `us-east-1`, from commit 7107cb6 (after the owner re-validated the template): "Successfully created/updated stack", no `CREATE_FAILED`, no rollback. Outputs recorded by the owner (identifiers kept out of Git; logical names only): `DeployQueueName` `cicd-events-dev`, DLQ `cicd-events-dev-dlq`, `ExecutionsTableName` `cicd-executions-dev`, `ExecutorLogGroupName` `/cicd/executor/dev`, probe repository `cicd-poc-dev-probe`, the four role ARNs and role IDs, and the created GitHub OIDC provider. The CI role trust holds the Option B fail-closed sentinels. Next: B1-E, the dedicated Executor principal's inline `sts:AssumeRole` policy (owner-executed).

### B1-E — dedicated Executor principal permission (2026-10-07): **PASS**

Owner-executed: inline policy `AssumeExecutorRoleOnly` (only `sts:AssumeRole` on the stack's ExecutorRole) attached to `cicd-poc-dev-executor-local`. Verified: one inline policy, no managed policies, no groups, no access keys, no console login. `simulate-principal-policy`: `sts:AssumeRole` on ExecutorRole `allowed`; on CiRole and OperatorRole `implicitDeny`; `secretsmanager:GetSecretValue`, `sqs:SendMessage`, `sqs:ReceiveMessage`, `dynamodb:GetItem`, `ecr:GetAuthorizationToken`, `s3:ListAllMyBuckets`, `iam:CreateAccessKey`, `iam:PutUserPolicy` all `implicitDeny`. Next: B1-F, access key into the isolated files and an identity check through the `cicd-executor` profile.

### B1-F — isolated Executor credentials and identity (2026-10-07): **PASS**

Owner-executed: one access key for `cicd-poc-dev-executor-local` written directly into the Git-ignored `executor/.local/aws/credentials` (owner-only ACL, never echoed); isolated `executor/.local/aws/config` with `[profile cicd-executor]` (`role_arn` = ExecutorRole, `source_profile = cicd-executor-source`, `role_session_name = cicd-executor-workstation`, `duration_seconds = 3600`) and `[profile cicd-executor-source]`. `aws sts get-caller-identity --profile cicd-executor` with only the isolated files returned the assumed ExecutorRole session; the `UserId` role-ID prefix equals the stack output `ExecutorRoleId` (identifiers kept out of Git). Not the administrative user, not the dedicated user directly. Next: B1-G, portable Node 22 toolchain and Executor build (local only).

### B1-G — Executor validated under Node 22 (2026-10-07): **PASS**

| Item | Record |
|---|---|
| Runtime | Node **v22.23.3** (owner-installed through NVM; `C:\Program Files\nodejs\node.exe`), npm 10.9.9. A first attempt with v22.11.0 stopped on `EBADENGINE` (dev dependency `eslint-visitor-keys@5.0.1` requires `^22.13.0`); no dependency was changed |
| `npm ci` | exit 0, 207 packages, **no `EBADENGINE`**. Informational: `eslint@9.39.5` deprecation notice; the install-time audit of the whole tree (development dependencies included) reports 6 vulnerabilities (3 moderate, 1 high, 2 critical) — not the configured production gate, left for the owner (no `npm audit fix`) |
| Build | `tsc` exit 0; `dist/src/main/index.js` present |
| `npm run check:local` (PowerShell) | exit 0: typecheck, lint, build, guards 1–8 PASS, tests, **production audit `found 0 vulnerabilities`**, `inspect:image` DEFERRED notice. Vitest there: 1147 passed / 171 skipped — the extra skips are environmental: in PowerShell `bash` resolves to the WSL launcher and `realpath` is absent, so the bash-based adversarial suites skip by their capability probes |
| Full suite under Git Bash, same Node 22.23.3 | `npx vitest run` exit 0: **51 files passed / 13 skipped; 1243 passed / 75 skipped / 1 todo** — identical to the Node 20.19.5 reference; SR-1 build hardening (23), launcher (116) and target probe (13) suites executed |
| Closes | The Gate A deferral "Node 22 run of the full local gate" (local evidence was on Node 20.19.5 until now). `inspect:image` (Docker) stays DEFERRED |

### B1-H — local definitions root, `executor.env` and launcher dry run (2026-10-07): **PASS**

Local only (no AWS call). `executor/.local/definitions/` created from `docs/gate-b/examples/definitions/` plus the repository `schemas/` and `deploy-scripts/` (Git-ignored; `git status` clean); `npm run definitions:check -- --root .local/definitions` under Node 22.23.3 → `OK example-app-dev`, passed (1 deployment), no NOTE, exit 0. `executor/.local/executor.env` created (16 keys: isolated AWS files, `AWS_PROFILE=cicd-executor`, the pinned role ARN, region, queue URL, table name, logical principal and platform Slack refs, secret prefix `cicd-poc/dev/`, links, absolute definitions root; Git-ignored). Launcher dry run (`run-executor.ps1 -DryRun -NodePath` NVM Node 22.23.3) → exit 0: every isolation rule satisfied, values redacted, `CICD_EXECUTOR_ROLE_ARN` used only for the role-pin check and not passed to the child, `AWS_EC2_METADATA_DISABLED` set. B1 keeps the example `EXAMPLE_*` references (no target chosen; `deployWindowPolicy: required` with no window, so no SSH). Next: B1-I, the owner-created Secrets Manager entries required for startup.

## AC-02 — runtime multi-project Target Registry: spec update (2026-10-07)

Owner decision: the Target Registry leaves the Executor image and becomes a separate DynamoDB table `cicd-registry-<stage>` read with `GetItem` only; `DEPLOY_REQUESTED` carries `targetId`; target-side `allowedDeploymentIds` + environment authorization (`REJECTED` otherwise); target values inline; only credentials in Secrets Manager; Deployment Definitions stay bundled without `targetRef`; GitHub workflows in application repositories are configured by their owners; everything else unchanged. Spec updated: `architecture-change-02.md`, design v4.9 (§5.1 snapshot, §5.3 table, §6.1 `targetId`, §6.2, §6.3 target record, §6.4 window event `targetId`, §7.2/§7.3 X1/X2, module rows, DD-19, DD-23, DD-25, DD-27, §11.2, QAS-6), requirements v3.8 (glossary, FR-01, FR-02 rewritten with scenarios, FR-03, FR-13, FR-21 scenario), tasks §6.0.3 R-1…R-9 (tests defined first; implementation not started), gate-b-plan §7/§10a, RESOURCES. Review: FAIL (state machine, snapshot, window key, stale text, CONFIG# adopted by assumption) → FAIL (R-3 still built CONFIG#) → **PASS** (attempt 3). Open points for the owner: AC2-1 state table name, AC2-2 one deployment per target in the PoC, AC2-3 cross-target invariants at write time, AC2-4 registry write power, AC2-5 health URLs per deployment, AC2-6 Slack token at startup, **AC2-7 where non-secret definition refs live**. No code, infrastructure, AWS or GitHub change. B1 Executor startup stays PENDING.

## AC-02 V1 — simplification: no Deployment Definitions, script on the target, shared CI role (2026-10-07)

Owner decisions (same day, before the AC-02 commit was pushed): V1 has no Deployment Definitions; the request carries `targetId` and no `deploymentId`; the target record holds only `targetId`, `project`, `environment`, `host`, `port`, `user`, `hostKey`, `credentialRef`, `deployScript` (absolute path of a script installed on the target, never from the request) and `deployWindowPolicy` (+ audit fields); the script owns all application-specific logic; one CI role shared by the authorized repositories (no role per repository, no per-target `allowedCiRoleIds`). The `targetId` is the deploy identity and the lock key. Spec updated: `architecture-change-02.md` (rewritten for V1), design v5.0 (§1.2 normative mapping, §5.1–§5.3, §6.1–§6.6, module rows, X1/X2, §7.5, §7.7, DD-10, DD-11, DD-19, DD-20, DD-23–DD-27, DD-29, §11, QAS-4/5/6), requirements v4.0 (§1.3, glossary, FR-01 deferred, FR-02, FR-03, FR-12, FR-13, FR-21, FR-23–FR-25, NFR-08), tasks §6.0.3 R-1…R-9, gate-b-plan §7/§10a, RESOURCES, CLAUDE.md rule 5. Validation: `git diff --check` clean, no control characters, publication scan clean, `npm run validate` 8/8 PASS (Node 22.23.3). Review: FAIL (MAJOR: the cross-project risk of the shared CI role had been labelled owner-accepted, and the "script pulls only from its own repositories" mitigation is defeated by the shared ECR push; 12 MINOR/NIT) → **PASS** (attempt 2; remaining MINOR/NIT applied). **Open for the owner: V1-R1** (shared CI role allows an arbitrary image to be deployed on any target and a permanent ordering block; zero exposure while the trust admits one repository; a second repository is gated on the decision), V1-R2…V1-R5, AC2-1, AC2-4, AC2-6, AC2-7 (narrowed to platform references). No code, infrastructure, AWS or GitHub change. B1 Executor startup stays PENDING.

## AC-02 V1 — V1-R1 resolved by option A, conditional on B2 (2026-10-07)

Owner decision: keep one shared CI role and bind each target to one source repository through an IAM-enforced role session name: GitHub `repository_id` → `sts:RoleSessionName` (trust condition `${token.actions.githubusercontent.com:repository_id}`) → SQS `SenderId` suffix → Executor → target record `sourceRepositoryId`. The check runs after the sender and target checks and before any dedupe read or claim, sequence, `highestAccepted`, `highestDispatched`, lock or window write; a mismatch is `REJECTED (TARGET_NOT_AUTHORIZED)`, recorded under the message identity, with no effect on the target's operational state. Research basis (AWS IAM and GitHub documentation): session tags and `SourceIdentity` reach `AssumeRoleWithWebIdentity` only through token claims GitHub does not emit; the session name appears in `SenderId`. Premises **P-R1** (`sts:RoleSessionName` evaluated for `AssumeRoleWithWebIdentity`) and **P-R2** (the GitHub claim resolves as a trust-policy variable) stay `UNVERIFIED` until the real B2 positive and negative tests pass; both fail closed; no second repository before they pass; if either fails, option A is discarded and option B (SR-2) is evaluated. The owner amended DD-25 statement 2 (an IAM-enforced session name is an authorization input). Spec updated: `architecture-change-02.md` (decision 4 and 6, record, flow, V1-R1, V1-R2, AC2-4), design (§1.2, §5.1 snapshot, §6.3 field and rules, module rows, §7.2, X1/X2, QAS-4/5, DD-24, DD-25, DD-27, DD-29, §11.1), requirements (version, FR-02, FR-21, FR-23, FR-25), tasks R-1, R-2, R-4, R-7, R-8, gate-b-plan §7, RESOURCES row 9. Review: FAIL (2 MAJOR: stale V1 text in the design §1.2 source-binding row and in the requirements version row, both contradicting option A; 8 MINOR/NIT) → **PASS** (attempt 2; remaining MINOR/NIT applied, including: every V1 `DEPLOY_REQUESTED` rejection is keyed by the message identity, the real SQS `SenderId` suffix (P-A4) is part of the B2 positive test, and the tag-overwrite residual is referred to OD-A7). Validation: `git diff --check` clean, no control characters, publication scan clean, `npm run validate` 8/8 PASS (Node 22.23.3). No code, infrastructure, AWS or GitHub change.

## AC-02 V1 — task redistribution so every task ends green (2026-10-07)

Owner-approved option 1: R-1 cannot end green if it changes contracts that existing code consumes. R-1 keeps only the additive `target-record.schema.json`; the `deploy-request.schema.json` change (`targetId` in, `deploymentId` out) moves to R-4 with all its consumers, including the reusable workflow's `targetId` input and request body and the caller examples' `with:` key with their contract tests (moved from R-8 by applying the same owner rule; flagged to the owner); the `event.schema.json` change (`lockKey` → `targetId`) moves to R-5 with its consumers; the deletion of `deployment.schema.json` and `targets.schema.json` moves to R-9 with their consumers, guards and obsolete tests. Review: FAIL (MAJOR: the reusable workflow is also a consumer of the request schema) → **PASS** (attempt 2; caller example moved too). Architecture and V1 scope unchanged.

## R-1 — `schemas/target-record.schema.json` (2026-10-07): **PASS**

Test-first: `executor/test/contract/target-record-schema.contract.test.ts` written and run red (schema absent), then the schema (design §6.3: all fields incl. `sourceRepositoryId`, `additionalProperties: false`, `port` default 22; `deployScript` absolute path without `.`/`..` segments, trailing slash, arguments or metacharacters; `hostKey` as OpenSSH public-key lines compatible with `ssh-deployer/host-key.ts`; `credentialRef` a secret name, never an ARN or value; `environment` `dev`). Contract tests 95/95; a mutation check confirmed that weakening each core rule (`..` segment, `additionalProperties`, `sourceRepositoryId` pattern, required `hostKey`, `deployScript` pattern) makes the matching case fail. The publication-policy guard caught an ARN-shaped and two PEM-marker fixtures in the first test draft; replaced by placeholders. Regression (Node 22.23.3, Git Bash): `npx vitest run` 52 files passed / 13 skipped, 1338 passed / 75 skipped / 1 todo (baseline 1243 + 95; skips unchanged); `npm run check:local` exit 0 (typecheck, lint, build, guards 8/8, tests, production audit 0 vulnerabilities; `inspect:image` DEFERRED). Review: **PASS** (attempt 1; MINOR host IP-shaped names and NIT `.` segment / trailing slash applied with tests; other NITs left: host-key comment charset, fake key blobs not reusable for parser tests in R-3/R-5 — R-3/R-5 must join `hostKey` lines with a newline before `parsePinnedHostKeys`). No existing contract changed; no AWS or GitHub change.

## R-2 — Target Registry table, Executor read access and the CI role session-name condition (2026-10-07): **PASS (local IaC only; not applied to AWS)**

Test-first: `sam-template.contract.test.ts` and `composition.test.ts` extended and run red (12 failing), then `infra/sam/template.yaml`: resource `RegistryTable` (`cicd-registry-${Stage}`, PAY_PER_REQUEST, `pk`/`sk` string key, no index, no TTL, PITR `true`, `DeletionPolicy`/`UpdateReplacePolicy: Retain`, `Project` tag), ExecutorRole statement `TargetRegistryRead` (`dynamodb:GetItem` on the table ARN only; state table, GSI2 and secret-prefix statements unchanged), CI role trust condition `sts:RoleSessionName` = `${token.actions.githubusercontent.com:repository_id}` (a literal IAM policy variable under the existing `StringEquals`), output `RegistryTableName`; Executor config `CICD_REGISTRY_TABLE_NAME` required (`config.ts`, env example, runbook 05); teardown note (08) and RESOURCES. The local E1029 test helper now mirrors the real cfn-lint rule (flags only parameters, resources, `Resource.Attr` and `AWS::` pseudo parameters; IAM policy variables and `${!...}` literals pass), with self-tests. **P-R1 and P-R2 stay UNVERIFIED** (template comment, tests, RESOURCES): a static template proves nothing about `AssumeRoleWithWebIdentity`. Validation: targeted 89/89; `sam validate --lint` (SAM CLI 1.151.0, run with no AWS credentials and telemetry off) → valid, no lint finding; full suite (Node 22.23.3, Git Bash) 52 files passed / 13 skipped, 1348 passed / 75 skipped / 1 todo (1338 + 10); `npm run check:local` exit 0 (production audit 0 vulnerabilities; `inspect:image` DEFERRED). Review: **PASS** (attempt 1; MINOR redeploy note for the retained table and NIT "state table" wording applied in 08). Deployment notes for the owner: (1) once the CI role holds real values, deploy R-2 together with or after R-8 (`role-session-name`), otherwise every CI assumption fails closed; (2) the local `executor.env` needs `CICD_REGISTRY_TABLE_NAME` after the deploy; (3) a stack re-create needs the retained table deleted or imported. No AWS, GitHub or secret change.

## R-3 — `TargetRegistry` port and DynamoDB `GetItem` adapter (2026-10-07): **PASS**

Test-first: `test/unit/target-registry-adapter.test.ts` (fake document client) and `test/integration/target-registry.int.test.ts` (DynamoDB Local, table shaped like `cicd-registry-<stage>`) written and run red (adapter absent). Then `src/ports/target-registry.ts` (read-only port: `getTarget(targetId)` → `found` | `missing` | `invalid`; a storage failure is thrown, never an outcome) and `src/adapters/dynamodb-target-registry/index.ts` (one `GetCommand` on `TARGET#{targetId}` / `META` with `ConsistentRead`, same `dynamodb:GetItem` action as R-2; key attributes stripped; validation against `schemas/target-record.schema.json` of R-1; stored `targetId` must equal the key; `problems` carry rule and path only, never a stored value; deep copy, no aliasing; nothing logged; `hostKey` returned as the list of lines, no SSH transformation). Not wired into the router or execution path (R-4). Tests: unit 16/16 (incl. the code-level read-only guard: the adapter source references no `*Command` other than `GetCommand`; the port declares only `getTarget`); `npm run test:integration` 13 files / 75 tests (69 + 6, all run on DynamoDB Local); full suite (Node 22.23.3, Git Bash) 53 passed / 14 skipped files, 1364 passed / 81 skipped / 1 todo (the 6 integration cases skip in plain `npm test`, as all integration files do); `npm run check:local` exit 0 (production audit 0 vulnerabilities; `inspect:image` DEFERRED). Review: **PASS** (attempt 1; MINOR redundant denylist regex removed in favor of the exact-set guard, port guard extended to function-typed properties, header `§` style). No AWS, GitHub or secret change.

## R-4 + R-5 — targetId request, option A source authorization, snapshot deploy path (2026-10-07): **PASS (joint delivery)**

Owner decisions: R-4 and R-5 are delivered jointly (option A; removing `deploymentId` broke the definition-based deploy path until R-5), with no temporary bridge to Deployment Definitions; the Gate B4 probe is adapted to V1 (option A). Implemented test-first in stages (contracts, domain, sender authorizer, store and router, execution service, transport, coordinator, windows, composition, probe), each run red then green; the router implementation preceded its rewritten tests, so a mutation check was run afterwards: 6/6 mutants killed (no source check, dedupe read before the source check, no sourceRepositoryId, no BOUND shortcut, live claim rejected, rejection without message id).
- **Contracts:** `deploy-request.schema.json` requires `targetId` (no `deploymentId`); `event.schema.json` window and resolution events carry `targetId`; reusable workflow input/guard/body and both caller examples use `targetId`; operator CLI `--target-id`.
- **R-4:** sender authorizer accepts `DEPLOY_REQUESTED` only from the resolved `ciPrincipalRef` with a numeric session suffix (the IAM-enforced `repository_id`, option A; config `CICD_CI_PRINCIPAL_REF`); router order sender → schema → requestId → `GetItem` (R-3) → validity → source authorization (`sourceRepositoryId`), all before any dedupe claim or target state write; `TARGET_UNKNOWN`/`TARGET_INVALID`/`TARGET_NOT_AUTHORIZED` (the last with no dedupe read); every rejection `REJECT#MSG#`; BOUND redelivery no-op, live claim left to redelivery, expired claim rejected; execution service keyed by `targetId`, non-secret snapshot at X1, ordering source = `ci.repository` + `ci.workflowRef`; notifications on the platform channel.
- **R-5:** deploy plan from the snapshot with the §6.5 vector; transport runs the snapshot's `deployScript` (path guarded, quoted args), credential read at connect, host key fail closed, no SFTP/remote directory/checksum (private key only); coordinator, reconciler and windows use the snapshot (`deployTimeoutMinutes` 20); window open reads the registry (unknown/invalid/`not-required` rejected); window policy without modeled external deployers (V1-R5); target resolution by `targetId`; `catalog.ts` and `plan-resolver.ts` removed from the composition (definition startup validation stays until R-6).
- **B4 probe (option A):** `executor-ssh-probe --target-id --probe-script` reads the record (R-3 adapter), pins its host key, reads the credential via `credentialRef`, runs only the INSTALLED `target-probe.sh` with no arguments; B4-only restriction: safe absolute path, file name `target-probe.sh`, no empty/`.`/`..` segment, never the target's `deployScript`; runbook 06 and the probe README rewritten; host-key negative check through a scratch target record.
- **Docs:** runbooks 02/05 (`CICD_CI_PRINCIPAL_REF`), 06, probe README, env example, schema comments.
- **Known limitation:** `deploy-scripts/deploy-container.sh` still expects the old CLI (`--lock-key`, `--unit`, ...); its rewrite to the §6.5 interface is R-9, so a real deploy (B5) is blocked until R-9.

Validation (Node 22.23.3, Git Bash): `npm run check:local` exit 0 (typecheck, lint, build, guards 8/8, 53 files / 1414 passed / 87 skipped / 1 todo, production audit 0 vulnerabilities; `inspect:image` DEFERRED); `npm run test:integration` 13 files / 81 tests on DynamoDB Local (incl. an unauthorized repository leaving no DEDUPE/SEQ/TARGET/LOCK/WINDOW trace while the legitimate source still deploys, each `TARGET_*` rejection reading no secret and opening no SSH, a record edited or deleted after X1 not changing the execution on both the lock-retry and the reconciler paths). Tasks review: PASS (joint note; intro exception added). Final review: FAIL (MAJOR: the "never reads the target's credential" test was missing; MINOR runbook 06 text, reconciler-path snapshot test; NIT probe `//`, runbook 02) → **PASS** (attempt 2; NITs applied). P-R1/P-R2 stay UNVERIFIED (B2). No AWS, GitHub, secret or SSH change.

## R-6 — Startup without Deployment Definitions (2026-10-07): **PASS (local validation only; no AWS startup)**

- **Startup:** `bootstrap` no longer enumerates, loads or validates definitions (`listDeploymentIds`, `validateForStartup` and the file attribution are gone from the startup path) and reads no target; zero targets is a valid starting state. New module `platform-config` (`resolvePlatformConfig`): the four principal refs are read by value through the SecretProvider (AC2-7) and the platform Slack channel and token secrets are existence-checked (AC2-6); the token is never read at startup. A missing or unreadable platform ref fails fast with `UnresolvedReferenceError` naming only the ref, before any consumer, poller, heartbeat, queue or DynamoDB call. Reading of the design `platform-config` row: the Slack channel is "resolved as today", which means existence-checked at startup and read at point of use by the Slack provider (unchanged behavior).
- **Schemas:** new `SchemaSource` port and `BundledSchemaSource` adapter (bare `<name>.schema.json` names only, `schemas/` only) for the request, event and target record schemas (DD-19 V1: `schemas/` stays bundled). `CICD_DEFINITIONS_ROOT` keeps its name until R-9; `CICD_DEFINITION_REF` is no longer required at startup.
- **Removed from startup:** `Executor.deploymentIds`, `main/definition-diagnosis.ts` (replaced by the generic `startup-diagnosis.ts`). The definition service, `BundledDefinitionSource`, `deployment-definitions/`, `definitions:check` and the definition guards stay until R-9 (definition-service keeps its own copies of the shared types because a guard transpiles it in isolation).
- **Tests:** `startup-fail-fast.test.ts` rewritten for V1 (a root with `schemas/` only; an unparsable `deployment-definitions/` ignored; no DynamoDB call at startup; principal refs read by value and the token existence-only; production without `CICD_DEFINITION_REF`; each of the six platform refs missing fails fast naming it with nothing started; unreadable ref names no resolved value; missing schemas fail fast; unsafe schema names refused). Confirmed red against the old bootstrap (12 failures: `DefinitionLoadError`, missing `deployment-definitions/`, `CICD_DEFINITION_REF` required). Composition fixtures resolve only the platform refs, so the unit and DynamoDB Local composition tests now run with no definition reference at all. Mutation of `platform-config`: 5/5 killed.
- **Docs:** runbooks 02, 04, 05, gate-b README (G-2, G-9, K-3 notes), env example, Dockerfile comments, gate-b-plan B1 paragraph.

Validation (Node 22.23.3, Git Bash): `npm run check:local` exit 0 (typecheck, lint, build, guards 8/8, 53 files / 1424 passed / 87 skipped / 1 todo, production audit 0 vulnerabilities; `inspect:image` DEFERRED); `npm run test:integration` 13 files / 81 tests on DynamoDB Local. Review: **PASS** (attempt 1; MINOR docs 04/README and Dockerfile comments, NIT test value assertion, duplicate-type comment and the design-row reading applied). B1 startup against AWS stays PENDING on the owner prerequisites (R-2 template deployed, real Slack token, platform identifier refs). No AWS, GitHub, secret or SSH change.

## Fix — Executor reads a target `credentialRef` by its full secret name (2026-10-08): **PASS**

Defect found while preparing R-7: `target-record.schema.json` (R-1) and design §6.3 define `credentialRef` as a Secrets Manager secret name under the Executor's secret prefix (no `<>`), but `SecretsManagerSecretProvider` only accepted `<LOGICAL>` refs, so the V1 SSH transport (R-5) and the B4 probe would have failed with `InvalidLogicalRef` on any schema-valid record against real AWS (the tests used fakes). Fix: `credentialRefProblem(prefix, ref)` (non-empty prefix; secret-name charset, so never an ARN; strictly under the prefix) and the provider accepts such a name as-is, failing closed otherwise with the sanitized error. The accepted set equals the IAM scope `secret:${SecretIdPrefix}*`. Tests red first (full name read as-is; outside names, the bare prefix, look-alike prefixes, ARNs and an empty prefix refused with no SDK call). Runbook 02 states the full-name form. Review: PASS (with R-7).

## R-7 — Target Registry administrative tool (2026-10-08): **PASS (local validation only; nothing written to a real table)**

- **Tool:** `tools/target-registry` (`executor/src/tools/target-registry/`): `put` validates the full record against `target-record.schema.json` before any AWS call (rule and path only, never a value), enforces `credentialRef` under `--secret-id-prefix` (same rule as the provider), owns `schemaVersion`/`version`/`updatedAt`/`updatedBy` (an input setting them or `pk`/`sk` is refused) and writes conditionally (create: `attribute_not_exists(pk)`; update: `version` = `--expected-version`, bumped by one); `get` (consistent `GetItem`); `checklist` (repository_id, V1-R2, V1-R3 ownership, §6.5 interface with the mutex, host key, credential, FR-13, the option A B2/P-A4 gate, administrative profile). A write requires `--checklist-confirmed`; `--dry-run` makes no AWS call. No delete command, no secret read, no SSH, no GitHub call, no new dependency.
- **Identity (AC2-4):** an explicit administrative `--profile` is required; the Executor profile (`cicd-executor`) as `--profile` or `AWS_PROFILE` is refused, as are static keys, web identity, container credential and the isolated AWS file variables in the environment; the entry point disables the instance metadata fallback.
- **Tests:** unit 43 (schema refusals, tool-owned fields, credentialRef prefix, identity refusals, exact conditional `PutCommand`, conditional failures, checklist gate, dry run, `get`), DynamoDB Local 2 (create, refused re-create, refused stale update, update; read back as `found` by the Executor's read-only adapter; update of a missing target refused). Mutation 8/8 killed. The publication-policy guard caught a PEM-like marker in a first draft of a test; replaced with a neutral sentinel.
- **Docs:** new runbook `docs/gate-b/09-target-registry.md`; runbooks 02, 06 (scratch record via the tool), README.

Validation (Node 22.23.3, Git Bash): `npm run check:local` exit 0, `npm run test:integration` on DynamoDB Local (figures in the commit report). Review: **PASS** (attempt 1 interrupted by a session end; attempt 2 PASS; MINOR identity fall-through to web identity, container credentials and instance metadata closed; NITs on wording, the prefix source and the update target id applied). No AWS, GitHub, secret or SSH change.

## R-8 — Reusable workflow role session name and first live flow runbooks (2026-10-08): **PASS (local validation only; nothing run on GitHub or AWS)**

- **Workflow:** the OIDC step of `.github/workflows/deploy-request.reusable.yml` sets `role-session-name: ${{ github.repository_id }}` (option A); it is not an input and no input, variable or event field feeds it; one shared CI role is kept. Contract tests red first (session name, the exact `with:` keys of the OIDC step, not an input, callers never set it); the older test that pinned the OIDC step keys was updated to the new contract.
- **Coordination with R-2:** the CI role trust requires the session name, so the stack's `PinnedWorkflowSha` must be a commit that contains this change (or the B2 probe); a stack pinned to an older SHA denies every run. Runbook 01 now states eight trust conditions and the expected changeset of the R-2 update.
- **Safe cut point for the first live flow (no bypass, no state machine change):** stage 1 without a target record ends `REJECTED (TARGET_UNKNOWN)` (sender authorized, registry read, no claim); stage 2 with the record at `deployWindowPolicy: required` and no window ends `FAILED (DEPLOY_WINDOW_CLOSED)` at X4 (first window check), before any lock, credential read or SSH. Limitation: stage 2 needs a schema-valid record, so the TEST server's host name and public host key must be chosen first (no server configuration or login).
- **Identity tests:** runbook 03 section 7 is now a session-name probe published at the reusable workflow path on a throwaway platform branch and pinned temporarily: it records the claims (P-G10, P-G11) and calls `AssumeRoleWithWebIdentity` with the repository id (must be allowed) and two other session names (must be denied) for P-R1/P-R2; section 10 is the Executor-level negative (`TARGET_NOT_AUTHORIZED` with no target state change) by temporarily changing the record's `sourceRepositoryId` through the R-7 tool. If P-R1 or P-R2 fails, stop: option B is not implemented by assumption.
- **Docs:** runbooks 01, 03, 07 (V1 key shapes, `REJECT#MSG#` lookup, `error.code`, B2 evidence table, wrong-sender body with `targetId`), the caller examples (session-name note), README (first live flow sequence L1–L12 and the real Slack requirement).

Validation (Node 22.23.3, Git Bash): `npm run check:local` exit 0 (54 files, 1475 passed, 89 skipped, 1 todo, guards 8/8, 0 vulnerabilities). Review: **PASS** (attempt 1; no blocker for the first live flow; four non-blockers applied: 17 stack outputs incl. `RegistryTableName`, `UPDATE_COMPLETE` end state, full `put` commands in 03 section 10, the probe prints the real denial code). No GitHub, AWS, secret or SSH change.

## B2 first live flow — L1 to L6: OIDC trust validated on AWS (2026-10-08): **PASS for the OIDC part only**

Executed by the owner (AWS, GitHub); prepared and checked by Claude. Real identifiers are kept out of Git: the numeric repository and owner ids appear below as `<GITHUB_REPOSITORY_ID>` / `<GITHUB_OWNER_ID>`; the account id and role names are not recorded.

| Step | What happened | Evidence |
|---|---|---|
| L1 | Owner identity and stack state read | Stack `cicd-poc-dev` (`us-east-1`) `CREATE_COMPLETE` with the pre-AC-02 template and placeholder parameters |
| L2 | Caller repository chosen: the platform repository `AllianceBioversityCIAT/onecgiar-cicd-platform` itself (public; created 2026-10-05, so the immutable `sub` form applies) | Ids read through the public GitHub API |
| L3 | Probe published on the throwaway bound branch `b2-session-probe`, based on the published `origin/main` | Probe commit **`3840f99a2d217f5c4342c45935e3e26cb055ade5`** (only the reusable workflow path replaced); remote SHA verified through the GitHub API; no run triggered |
| L4 | Stack updated with the R-2 template, `PinnedWorkflowSha` = probe SHA, repository / owner ids, Environment `cicd-poc-dev`, `GitHubBoundRef` `refs/heads/b2-session-probe`, immutable-form `GitHubOidcSub`; omitted parameters kept their empty defaults | `sam validate --lint` exit 0; change set reviewed before execution: `Add RegistryTable`, `Modify CiRole` / `ExecutorRole` (no replacement), `Modify DeployQueuePolicy` dynamic only (semantic comparison of the deployed and local templates: the policy is identical; it is re-evaluated because it references the role ARNs); `UPDATE_COMPLETE` |
| L5 | Environment `cicd-poc-dev` with one branch rule `b2-session-probe`, no secrets; throwaway caller **`b0e9b5a`** on the bound branch calling the reusable workflow path `@3840f99…` (full form); run triggered by its push | Real GitHub Actions run (see below) |
| L6.1 | Only the R-8 commit **`7f148ceb90e494edd4b87a161524936c4f7ded94`** published to `main` (fast-forward from `7abf95b`; `b557cc5` kept local) | Remote `main` SHA verified through the GitHub API; no run triggered |
| L6.2–L6.3 | `PinnedWorkflowSha` changed from the probe SHA to the R-8 SHA only; change set reviewed and executed | `UPDATE_COMPLETE`; `aws iam get-role` shows the trust pinned to `7f148ce…` with the other conditions unchanged |

**L5 real run (probe at `3840f99`, not the R-8 workflow).** Observed claims: `repository_id` = `<GITHUB_REPOSITORY_ID>`, `repository_owner_id` = `<GITHUB_OWNER_ID>`, `environment` = `cicd-poc-dev`, `ref` = `refs/heads/b2-session-probe`, `job_workflow_ref` = `AllianceBioversityCIAT/onecgiar-cicd-platform/.github/workflows/deploy-request.reusable.yml@3840f99a2d217f5c4342c45935e3e26cb055ade5`. `AssumeRoleWithWebIdentity` results: session = repository id → **ALLOWED**; `wrong-session` → **DENIED (AccessDenied)**; another numeric id → **DENIED (AccessDenied)**.

| Premise | Status | Basis |
|---|---|---|
| P-R1 (`sts:RoleSessionName` evaluated for `AssumeRoleWithWebIdentity`) | **VERIFIED on AWS** | Two wrong session names denied with every other claim matching |
| P-R2 (the claim resolves as an IAM policy variable) | **VERIFIED on AWS** | The repository id as session name allowed |
| P-G11 (`job_workflow_ref` form for a SHA-pinned call) | **VERIFIED** | `path@<40-hex SHA>`, as the template builds it |
| P-G10 (`sub` form) | **VERIFIED (indirectly)** | The assumption succeeded against the immutable-form `GitHubOidcSub` parameter; all eight `StringEquals` conditions matched |
| Trust pinned to the R-8 workflow | **DEPLOYED and read back** (`get-role`) | Not yet exercised by a run: the first run with the R-8 workflow happens at L9 |

**Still pending (not validated):** P-A4 (the real SQS `SenderId` suffix equals the repository id), the R-8 workflow end to end (build, ECR push, one `SendMessage`), SQS delivery to the Executor, the Executor started against AWS (L7 platform secrets incl. a real Slack token, L8 startup), the router outcomes on AWS (`TARGET_UNKNOWN` without a record, accepted request ending `FAILED (DEPLOY_WINDOW_CLOSED)` with no lock or SSH, `TARGET_NOT_AUTHORIZED` with no target state change, `UNAUTHORIZED_SENDER`), and B3–B5. The caller on `b2-session-probe` still points at `@3840f99`; a push to that branch now runs the probe and is denied by the trust (harmless, no message sent). It is moved to `@7f148ce…` only at L9, after L7 and L8, because that push runs the real flow. A second repository is not added to the trust (option A gate).

## B2 first live flow — L7 to L9: Executor on AWS and the first real request, `TARGET_UNKNOWN` (2026-10-08): **PASS (controlled rejection)**

Executed by the owner (AWS, GitHub, Slack); prepared, checked and pushed (only the authorized commits) by Claude. Real account identifiers, role names, the queue URL and secret values are kept out of Git.

| Step | What happened | Evidence |
|---|---|---|
| L7.1–L7.3 | Read-only checks with the owner identity | Stack `UPDATE_COMPLETE`, 17 outputs, four role ids of the expected form; `ExecutorRole` has only `executor-runtime` (7 statements, incl. `TargetRegistryRead`); the dedicated Executor user has only `AssumeExecutorRoleOnly` (`simulate-principal-policy`: `sts:AssumeRole` on the Executor role allowed, everything else `implicitDeny`), no groups, no console password, one existing access key (no new static key); the isolated `cicd-executor` profile resolves to the Executor role session `cicd-executor-workstation`; no secret existed under `cicd-poc/dev/` yet |
| L7 decision | Slack Incoming Webhooks evaluated and not adopted: no thread or root update (design §6.6), the startup check needs both refs (AC2-6), and reusing the existing servers' webhook would share a credential owned elsewhere | Bot token kept (approved design, no code change) |
| L7.7 | Six platform secrets created by the owner: four principal references (role ids) and the platform Slack channel and bot token | `list-secrets` shows the six names; values never printed |
| L7.8 | Local configuration | `dist/` rebuilt with Node 22.23.3; the env file fixed locally (it pointed `CICD_DEFINITIONS_ROOT` at a stale pre-AC-02 copy of the schemas without `target-record.schema.json`, lacked `CICD_REGISTRY_TABLE_NAME` and `CICD_CI_PRINCIPAL_REF`, and its references did not match the secret names); `loadConfig` OK; `run-executor.ps1 -DryRun` exit 0 (the launcher stripped inherited static keys from the parent shell); queue and DLQ empty, both tables empty |
| L8 | Executor started on the workstation against AWS (owner) | `executor started`, heartbeat every 60 s, healthcheck file updated, no error |
| L9.1 | Caller commit **`77c514f781792643c50ef2a92f540909c70a82d0`** on the bound branch `b2-session-probe`: reusable workflow `@7f148ceb90e494edd4b87a161524936c4f7ded94` (R-8, the SHA pinned in the trust), `targetId` `b2-probe` (absent from `cicd-registry-dev`, consistent read), one `FROM scratch` build unit under `b2/` | R-8 `guard` and "Validate build inputs" scripts run locally with bash and jq: pass; one `send-message` step, last, no retry; no SSH or deploy wording in executable content; local Docker build not executed (daemon not running) |
| L9.3 | Only `77c514f` pushed (fast-forward from `b0e9b5a`); the push triggered exactly one run | Run **`37840910980`**, workflow `b2-caller`, event `push`, attempt 1 |

**L9 traceability (one request end to end).**

| Hop | Identifier | Observed |
|---|---|---|
| GitHub Actions | Run `37840910980` attempt 1, commit `77c514f`, <https://github.com/AllianceBioversityCIAT/onecgiar-cicd-platform/actions/runs/37840910980> | `completed` / `success`: bound ref, build, OIDC with the session name = repository id, ECR push, request body, one send |
| SQS | Message id `30e714fc-7aea-4680-9bd9-fa69415881c3` | Delivered once: `ApproximateReceiveCount` = 1 |
| Executor | Same message id | `RejectedRequests` = 1 with reason `TARGET_UNKNOWN`; message acknowledged; heartbeat continued afterwards |
| DynamoDB `cicd-executions-dev` | `REJECT#MSG#30e714fc-7aea-4680-9bd9-fa69415881c3` | `reason` `TARGET_UNKNOWN`, `targetId` `b2-probe`, `requestId` `37840910980-1` (= run id + attempt) |
| Slack (platform channel) | — | `Request rejected: TARGET_UNKNOWN` received |

**What this proves.** The R-8 reusable workflow ran for real under the trust pinned to `7f148ce`; the CI role sent one `DEPLOY_REQUESTED`; SQS delivered it to the Executor running against AWS; the router authorized the CI sender (the `SenderId` session suffix was numeric, otherwise the reason would be `UNAUTHORIZED_SENDER`), validated the body against the schema, read the Target Registry and rejected the unknown target with a rejection record keyed by the SQS message id; the platform Slack notification works with the real bot token. Result: **PASS** for the L9 objective (controlled `TARGET_UNKNOWN` rejection).

**Additional L9 verifications (owner, read-only, 2026-10-08).**

| Check | Status | Evidence or basis |
|---|---|---|
| No dedupe claim for the rejected request | **VERIFIED** | Consistent `get-item` of `DEDUPE#b2-probe#37840910980-1` / `DEDUPE` returned `null` |
| No execution item | **VERIFIED** | The only `EXEC#` item is the notification mark `EVT#REJECTED` (pk `EXEC#REJECT#…`, the Slack de-duplication mark of the rejection, not an execution); no other execution record exists |
| Queue state afterwards | **VERIFIED** | `cicd-events-dev`: 0 visible, 0 in flight; `cicd-events-dev-dlq`: 0 visible, 0 in flight; `RedrivePolicy` `maxReceiveCount` = 5 |
| No SSH | **INFERRED, strongly** | No target record, no execution item and no lock: the coordinator and the SSH transport are only reached from an execution. Not yet confirmed from the Executor console (absence of any connection or deploy line) |
| No target state | **PENDING** | `DEPLOYMENT#b2-probe` / `SEQ`, `TARGET#b2-probe` / `STATE`, `LOCK#b2-probe` / `LOCK`, `WINDOW#b2-probe` / `WINDOW` not read individually (implied by the absence of any execution, not observed) |
| ECR | **PENDING** | Exactly one image tagged `ci-probe-37840910980-1` in the probe repository |
| `senderRef` on the rejection item | **PENDING** | Equals the CI role id (stack output `CiRoleId`), without the session suffix |

**Still pending for B2:** P-A4 in full (the `SenderId` suffix equals the record's `sourceRepositoryId`) needs stage 2 with a registered target (`deployWindowPolicy: required`, ending `FAILED (DEPLOY_WINDOW_CLOSED)` with no lock or SSH) and the `TARGET_NOT_AUTHORIZED` negative; then the untrusted-trigger and wrong-sender negatives (L10–L12). No target is registered, no window exists, and no second repository is added to the trust.

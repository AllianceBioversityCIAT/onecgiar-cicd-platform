# onecgiar-cicd-platform

Event-driven CI/CD platform that replaces Jenkins responsibilities in phases. Its core is a **lightweight Executor** that **coordinates**: it does not compile, does not build images and must never become another Jenkins.

## Language

**Everything committed to this repository is written in English**: identifiers, code comments, JSDoc, test titles, error and log messages, schema `$comment`s, Dockerfile comments, READMEs, runbooks, agent guides and commit messages. When a test maps to a spec scenario written in Spanish, translate the title (optionally append the reference, e.g. `FR-05`). The AKILI spec documents under `docs/specs/` are also maintained in English (owner decision, 2026-10-05; translation in progress).

## Sources of truth

| Document | Role |
|---|---|
| `docs/specs/changes/cicd-executor-poc/proposal.md` | Approved intent (acts as the PoC PRD) |
| `docs/specs/changes/cicd-executor-poc/requirements.md` | Approved requirements (FR/NFR) |
| `docs/specs/changes/cicd-executor-poc/design.md` | Approved design (Judgment Day APPROVED; acts as the PoC TRD) |
| `docs/specs/changes/cicd-executor-poc/tasks.md` | Plan by gate (A/B/C/D) |
| `docs/specs/changes/cicd-executor-poc/execution.md` | Execution log |

There is no `docs/prd.md`, `docs/trd/trd.md` or `docs/ux-ui/design.md` (minimal constitution); the spec documents play those roles. There is no UI.

## Stack

- Node.js 22 LTS (runtime and image), strict TypeScript, ESM. No web framework (design DD-15). See `executor/package.json` (`engines`).
- Tests: `vitest`. Schemas: JSON Schema with `ajv`. AWS SDK v3. SSH: `ssh2`.
- Target-side script: `bash` (runs on Linux; design §6.4).

## Commands (inside `executor/`)

| Command | What it does |
|---|---|
| `npm ci` | Install Executor dependencies |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | Lint |
| `npm test` | Local unit and integration tests |
| `npm run validate` | Validates definitions and registry and runs the boundary guards (T-21); after AC-02 V1 task R-9, schemas and guards only |
| `npm run check:local` | Local gate without Docker: typecheck, lint, build, tests, `check:deps` |
| `npm run inspect:image` | Real image inspection (**requires Docker**; environment-dependent deferred validation, mandatory before deployment) |

## Non-negotiable rules

1. **Executor boundary (NFR-01).** The Executor does not compile, build images, install application dependencies, run migrations, connect to application databases, read application secrets, contain per-project logic (PRMS, Tanzania, MARLO, AICCRA…) or Jenkins logic, or interpret expressions. If a task requires it: **stop and escalate**.
2. **Closed state machine** (design §7.3, T1–T13). No transition outside the list.
3. **Correctness through conditional writes** in DynamoDB (DD-03). No in-memory state as source of truth.
4. **Two lock layers:** distributed DynamoDB lock plus target-side local mutex. Neither replaces the other (DD-09, DD-22).
5. **`DefinitionSource`** is the core's only path to definitions (DD-19). **AC-02 V1 (owner, 2026-10-07):** definitions are removed by tasks R-1…R-9; from then on the read-only **`TargetRegistry`** port (`GetItem` only) is the core's only path to target configuration, and the deploy script lives on the target.
6. **Publication policy** (design §4.1, DD-23): never commit account IDs, hosts, IPs, credential IDs, revealing secret names, Jenkins job names or sensitive values. Use logical references (`<AWS_ACCOUNT_ID>`, `<PRMS_REPORTING_DEV_TARGET>`, …).
7. **Local-only files:** `JENKINS_REPLACEMENT_AKILI_CONTEXT.md` and `JENKINS_REPLACEMENT_FEASIBILITY_ANALYSIS.md` are in `.gitignore`. Before every commit run `git status` and `git ls-files` and confirm neither appears.
8. **Open decisions** (OD-Q5, OD-Q7, OD-Q11–Q15, OD-N1) are never resolved by assumption.
9. Commit messages are written in English and follow semantic commits with gitmoji: `<emoji> <type>(<scope>): <Subject>. <issue reference>` — types and emojis: ✨ feat, 🐛 fix, 📝 docs, ♻️ refactor, 👷 build, ✅ test, 💚 ci, 🎨 style, 🔧 chore, ⚡ perf (scope and issue reference optional, e.g. `✨ feat(executor): Add the deploy coordinator.`). Spec traceability goes in the body: `Spec: changes/cicd-executor-poc, task N-xx (FR/DD refs).` (owner decision, 2026-10-06).

## Model Routing

| Tier | Role | Model |
|---|---|---|
| T1 | Leader / architecture / specification | `opus` |
| T2 | Implementer | `sonnet` |
| T3 | Reviewer (author ≠ auditor) | `opus` |

## Skill Map

`tdd` (domain and adapters) · `aws-serverless` (AWS adapters) · `error-handling-patterns` · `api-design-principles` (contracts and schemas) · `cognitive-doc-design` (documentation).

## Agents

Personas live in `.agents/` (`leader.md`, `implementer.md`, `reviewer.md`).

## Module Guides

None yet.

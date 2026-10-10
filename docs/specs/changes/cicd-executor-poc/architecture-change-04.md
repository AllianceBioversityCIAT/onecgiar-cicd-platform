# Architecture Change 04 — `SQS_AGENT`: asynchronous dispatch to one agent per server

| Field | Value |
|---|---|
| Status | **APPROVED by the owner as the implementation baseline (revision 2, 2026-10-10).** E1 (contracts) authorized and implemented locally; E2–E7 each need the owner's authorization. This document itself changes no code, infrastructure, server or AWS resource |
| Owner decisions applied (2026-10-10) | Fully **asynchronous** central Executor (attached mode rejected); **one agent per server and per platform stage** serving several applications through a local catalog; hybrid identity with temporary credentials, one identity per agent; dedicated OS user, `sudoers` per script; **logs in S3 from the MVP**; Node.js 22; FIFO command and results queues with DLQs; IAM + queue policies + `SenderId`; locks independent of any Executor process; **UNKNOWN keeps the target blocked**; Slack centralized in the Executor; reusable per-agent infrastructure; SSH kept during the transition. Approved items AP-1…AP-9 are listed in §20 |
| Revision 2 corrects | Lock lifetime (no expiry while a command may run), agent-side exclusivity and fencing persistence, the claim/start failure windows, FIFO and local concurrency interaction, unknown-outcome hold, lock item TTL |
| Supersedes | The `SQS_AGENT` sections of the local assessment (§7–§11, §13, §23) and the attached-mode proposal |
| Not changed | Origin authorization (OIDC, repository-bound CI roles, `sourceRepositoryId`), dedupe, ordering and supersede, deploy windows, the closed **state set** and transitions X1–X16, fencing tokens, the target mutex, AC-03 (arguments, exit codes, `CICD_RESULT`, version check), audit, the GitHub Actions integration |

## 1. Responsibilities

| Layer | Owns | Never does |
|---|---|---|
| **Executor** (central, stateless process) | Authorize the request (sender, repository, target), dedupe, ordering, windows, per-target lock and fencing, execution state, **dispatching a command** to the authorized agent, consuming agent events, closing executions, holds and their release, audit, notifications | Waiting for a deploy, holding a session, renewing a lock per execution, running scripts, polling DynamoDB per execution |
| **Agent** (one per server and platform stage, systemd) | Receiving only its own commands, validating them against its local catalog, starting a catalog script **at most once per command**, local exclusivity per target, timeouts, local concurrency, uploading logs to S3, reporting events, answering evidence queries | Running anything not in its catalog, taking a path or command from a message, deciding authorization, holding Slack credentials or other targets' AWS permissions |
| **Deploy script** | The AC-03 contract, unchanged (including its own `flock` mutex, exit 50) | — |

## 2. Decisions

| # | Decision |
|---|---|
| AG-D1 | **Asynchronous dispatch.** The handler that commits X9 sends one `AGENT_COMMAND` and returns. Agent events arrive on the shared results queue and are applied by an independent consumer |
| AG-D2 | **No new execution state and no new transition.** `DEPLOYING` means "dispatched". Existing transitions close it; X11 and X14 gain new **trigger causes** (§7). This is the only state-machine change |
| AG-D3 | **Dispatch outbox.** X9 persists the command identity before the send; a lost send is re-driven with the **same** identity. DynamoDB and SQS are never assumed atomic |
| AG-D4 | **Execution-bound lock.** From X9 the target lock has **no time expiry**: it is released only by a fenced transaction that closes the execution with **proof that no process exists**, or by a hold resolution (§9). No Executor process renews it |
| AG-D5 | **Unknown outcome = hold** (AP-3). X16 keeps the lock (`hold`); it is released by never-started evidence from the owning agent or by an operator resolution, never by time |
| AG-D6 | **Agent: at most one start per command, at most one live run per target**, fencing tokens persisted per target, never a lower token after a higher one (§10.3–§10.4) |
| AG-D7 | **Evidence query.** For a silent execution the Executor sends `AGENT_QUERY` in the same FIFO group as the command; the agent answers from its journal (§6, §9.3) |
| AG-D8 | **Authenticity:** one IAM identity per agent, queue policies, `SenderId` verification on both sides (§11.4). No message signature in the MVP |
| AG-D9 | **Logs in S3 from the MVP**, uploaded by the agent even on failure (§12) |
| AG-D10 | **Agent AWS permissions ≠ script AWS permissions** (per-target script roles, §11.3) |
| AG-D11 | **Transport per target**: `ssh` (default, current path) or `sqs-agent`. The hold rule (AG-D5) applies to both transports (§15) |

## 3. Flow

```
GitHub Actions ─ OIDC ─ ECR ─> SQS cicd-events-<stage> ─> Executor (request consumer)
   authorize, dedupe, order, V1/V2, lock acquired (fencing N, short lease), S2, V4
   X9 transaction: DEPLOYING + outbox + lock PINNED (no expiry, owner+N)
   └─> SendMessage AGENT_COMMAND ─> cicd-agent-<stage>-<agentId>-cmd.fifo  (group = targetId) ; handler returns
Agent
   receive ─> validate ─> wait for local slot (visibility extended) ─> journal ACCEPTED ─> delete message
   ─> journal STARTING ─> spawn ─> STARTED, HEARTBEAT ─> FINISHED ─> upload logs ─> LOG_UPLOADED
   every event: journal + outbox ─> SendMessage AGENT_EVENT ─> cicd-agent-results-<stage>.fifo (group = executionId)
Executor (results consumer)
   SenderId ↔ agent ↔ target ─> conditional apply ─> close (X11/X12–X16/X14) + fenced lock release or hold, audit, notify
Reconciler tick (existing, extended): re-drive PENDING_SEND, send AGENT_QUERY, deadlines, hold evidence
```

## 4. Reuse

| Reused as is | Changed | New |
|---|---|---|
| Request router, CI sender binding, dedupe, supersede (S1/S2), windows (V1/V2/V4), lock acquisition with fencing, X1–X9 code paths, `classifyExitCode`, `CICD_RESULT` parser, version check, `unresolved[]` and operator resolution, notification service and suppression switch, `TargetRegistry` (`GetItem` only), SQS consumer and publisher, DynamoDB Local / ElasticMQ harnesses | Coordinator after X9 (branch by transport; async path ends at the send); lock repository (pin, fenced release, hold, TTL rule); X16 keeps the lock (both transports); reconciler (outbox re-drive, queries, deadlines); resolution service (second caller: agent evidence); `target-record` schema; sender authorizer (`agent` class); bootstrap (results consumer) | `agent-command`, `agent-event`, `agent-query`, `agent-heartbeat` schemas; `AGENT#<agentId>` registry record; `AgentDispatcher` port + SQS adapter; results consumer + event applier; `agent/` package; `agent-stack.yaml` and `target-script-role.yaml` templates; log bucket in the platform stack |

## 5. Data model

**Target record (registry), new optional fields:** `transport` (`ssh` default | `sqs-agent`); `agentId` and `scriptId` (required for `sqs-agent`; the script path lives only on the server). The log prefix `<project>/<environment>/<targetId>` is **derived** from the record, never stored (one source of truth). SSH fields (`host`, `port`, `user`, `hostKey`, `credentialRef`, `deployScript`) are required (except `port`) only for `ssh` and forbidden for `sqs-agent`; agent fields are forbidden for `ssh`. Until E2, the Executor's registry adapter refuses `sqs-agent` targets (`TARGET_INVALID`), so no such target can reach the SSH path.

**Agent record (registry):** `AGENT#<agentId> / META` = `agentId`, `stage`, `roleId` (compared with `SenderId`), `commandQueueUrl`, `targets[]`, `minAgentVersion`, `schemaVersion`, `version`, `updatedAt`, `updatedBy`. Written by the administrative tool, read with `GetItem`.

**Execution (new fields, `sqs-agent`):** `transport`, `agentId`, `commandId`, `dispatchState` (`PENDING_SEND` | `SENT`), `sentAt`, `notAfter`, `hardDeadlineAt`, `acceptedAt`, `execStartedAt` (existing, set from `STARTING`/`STARTED`), `lastHeartbeatAt`, `lastEventSeq`, `queriesSent`, `log{bucket, keyPrefix, status, bytes, sha256}`, `lateEvents[]` (bounded, audit only).

**Lock item (existing `LOCK#<lockKey>`), new attributes:** `mode` (`LEASE` | `PINNED`), `hold` (bool), `holdReason`, `holdSince`. A `PINNED` lock has `leaseExpiresAt` = maximum value (the existing acquisition condition `leaseExpiresAt < now` therefore refuses it unchanged) and **no TTL attribute**: the 24 h cleanup TTL is removed while pinned and restored on release, so a long hold can never be deleted by TTL and the fencing counter stays monotonic.

**Agent liveness:** `AGENT#<agentId> / STATE` in the executions table: `lastSeenAt`, `agentVersion`, `clockOffsetMs`, `running[]`. Written only by the results consumer.

## 6. Messages (FIFO queues; JSON, schema-validated on both sides, ≤ 256 KB)

**`AGENT_COMMAND`** (Executor → `…-cmd.fifo`; `MessageGroupId = targetId`, `MessageDeduplicationId = commandId`)

| Field | Rule |
|---|---|
| `specVersion`, `type` | `1`, `AGENT_COMMAND` |
| `commandId` | `<executionId>:<dispatchToken>` |
| `executionId`, `dispatchToken`, `fencingToken` | From X9 and the lock |
| `agentId`, `targetId`, `scriptId` | From the snapshot; re-checked by the agent against itself and its catalog |
| `args` | The AC-03 vector (`standard`) or `[]` (`none`), built by the existing `deployPlanOf` |
| `issuedAt`, `notAfter` | Latest moment the agent may **start** (AP-7: `issuedAt` + 5 min) |
| `timeoutSeconds`, `killGraceSeconds` | Executor deploy timeout (60–3600) and the kill grace used in `hardDeadlineAt` (5–600); the agent applies `min(command, catalog)` for the timeout and refuses a catalog kill grace above the command's (`REJECTED_CONFIG`) |
| `log` | `{ bucket, keyPrefix }` = `logs/<project>/<environment>/<targetId>/<executionId>/<dispatchToken>/` |
| `commit`, `requestId`, `project`, `environment` | Traceability (written into the log metadata) |

**`AGENT_QUERY`** (Executor → `…-cmd.fifo`; same group as the command, `MessageDeduplicationId = <commandId>:q<n>`): `queryNumber`, `commandId`, `executionId`, `dispatchToken`, `targetId`, `agentId`, `commandIssuedAt` and `notAfter` (the command's own values, so the agent can apply the `NEVER_SEEN` rule without the command), `issuedAt`. FIFO order guarantees the agent has already processed the command (if it was ever enqueued) before it answers.

**`AGENT_EVENT`** (agent → `cicd-agent-results-<stage>.fifo`; `MessageGroupId = executionId`, `MessageDeduplicationId = <commandId>:<seq>`)

| `phase` | Proves | Extra fields |
|---|---|---|
| `ACCEPTED` | Journaled; may start before `notAfter` | `acceptedAt` |
| `STARTED` | Process spawned | `startedAt`, `pid` |
| `HEARTBEAT` | Still running (60 s) | `elapsedMs` |
| `FINISHED` | Process group ended | `exitCode`, `signal`, `timedOut`, `durationMs`, `cicdResult`, `logTail` (≤ 4 KB, redacted) |
| `NOT_STARTED` | **Never started**, will never start | `reason`: `EXPIRED` (received or slot obtained after `notAfter`), `BUSY` (no slot before `notAfter`), `PREDATES_JOURNAL` (issued before the agent's journal existed: a reinstalled agent never runs an old command), `TARGET_ACTIVE` (another command of the target is active on the agent), `REJECTED_*` (schema, wrong agent, unknown target or script, invalid args), `STALE_FENCING`, `CLOCK_SKEW`, `ABANDONED` (journaled `ACCEPTED`, agent restarted before `STARTING`) |
| `LOST` | Started (`STARTING` journaled), agent restarted, process group gone, effect unknown | `startedAt` |
| `NEVER_SEEN` | Answer to `AGENT_QUERY`: the command is not in the journal (it can no longer start: any later delivery is `EXPIRED`). Sent **only** when the command's `issuedAt` is later than the journal's creation time (`journalEpoch`, persisted at first start) and inside the journal retention; otherwise the answer is `NO_RECORD` | — |
| `NO_RECORD` | Answer to `AGENT_QUERY` when the journal cannot prove anything (journal recreated, reinstalled agent, entry older than retention). **Not evidence**: the hold stays for the operator | `journalEpoch` |
| `LOG_UPLOADED` | Logs stored or failed definitively | `log{key, bytes, sha256, status}` |

Common fields: `specVersion`, `type`, `commandId`, `executionId`, `dispatchToken`, `fencingToken`, `agentId`, `targetId`, `seq` (monotonic per command, persisted), `sentAt`, `agentVersion`. An answer to a query re-sends the **last journaled phase** (for example `FINISHED` with its stored result).

**`AGENT_HEARTBEAT`** (agent → results queue, group `agent#<agentId>`, every 60 s, also when idle): `agentId`, `agentVersion`, `running[]`, `clockOffsetMs`, `sentAt`.

## 7. Mapping to the existing state machine

| Evidence (from the owning agent, for the current `dispatchToken`) | Transition | Lock |
|---|---|---|
| V4 fails right before the send | X10 (existing) | Released (fenced) |
| `NOT_STARTED` `EXPIRED`, `BUSY`, `ABANDONED`, `CLOCK_SKEW`, `PREDATES_JOURNAL`, `TARGET_ACTIVE`, or valid `NEVER_SEEN` | **X14** → `WAITING_LOCK` (retry with a new dispatch; the existing budget ends in X7) | Released (fenced), same transaction |
| `NOT_STARTED` `REJECTED_*` or `STALE_FENCING` | **X11** `FAILED` (configuration or protocol error, no retry) | Released (fenced) |
| Send failed definitively before `notAfter` (permission, missing queue) and the agent answers `NEVER_SEEN` | X11 `FAILED` `AGENT_DISPATCH_FAILED` | Released (fenced) |
| `FINISHED` exit 0 / 10–40 / 50 | X12 / X13 / X14 (existing exit-code table) | Released (fenced) |
| `FINISHED` exit 70 or `timedOut`, `LOST` | X16 `UNKNOWN_TARGET_STATE` | **Hold** |
| No closing evidence by `hardDeadlineAt` | X16 (reconciler, existing rule; `execStartedAt` may be absent) | **Hold** |

**State-machine change, explicit:** X11 and X14 accept new trigger causes from agent evidence (today X14 is triggered only by exit 50 and X11 only before exec). No state and no transition is added. Justification: "proved never started" must free the target and retry, which is exactly X14's effect; a configuration rejection is exactly X11's. The reconciler's X16 rule is relaxed to apply without `execStartedAt` for `sqs-agent` (silence cannot prove that nothing started).

Every apply is a conditional write on `executionId` + `dispatchToken` + `status = DEPLOYING` + `seq > lastEventSeq`, in one transaction with the fenced lock update. Duplicates and late events are no-ops on state and go to `lateEvents[]`.

## 8. Dispatch protocol

1. Lock acquired with the existing short lease (fencing token `N`); S2; V4.
2. **X9 transaction** (existing, extended): execution → `DEPLOYING`, `dispatchToken`, `commandId`, `dispatchState = PENDING_SEND`, `notAfter`, `hardDeadlineAt = notAfter + timeoutSeconds + killGrace + skew + margin`; `highestDispatched`; **lock → `PINNED`**, conditional on `owner = executionId`, `fencingToken = N` and the short lease still valid. If the short lease expired first, the transaction fails and nothing is dispatched.
3. `SendMessage` (dedup id = `commandId`). 4. Conditional `dispatchState = SENT`. The handler returns.

| Failure | Recovery |
|---|---|
| Crash before 2 | Nothing written; the short lease expires (existing) |
| Crash between 2 and 3 | Reconciler: `PENDING_SEND` older than 30 s and `now < notAfter − margin` → re-send the same command (FIFO dedup within 5 min; the agent journal after that). Later → `AGENT_QUERY` |
| Send succeeded, 4 lost | Same: duplicate removed by FIFO dedup or the journal. Events, not `SENT`, are authoritative |
| Send rejected | Bounded retries; then `AGENT_QUERY`; `NEVER_SEEN` → X11 `AGENT_DISPATCH_FAILED` |

## 9. Locks, deadlines and holds

### 9.1 Lifecycle
| Phase | Lock |
|---|---|
| Lock wait (`WAITING_LOCK`) | Existing short lease (180 s), acquisition condition unchanged |
| X9 | `PINNED`: no expiry, no TTL, owner + `N` |
| Closing evidence (§7, "Released") | One transaction: execution transition + lock `mode = LEASE`, `leaseExpiresAt = now`, TTL restored, conditional on `owner = executionId` and `fencingToken = N` |
| X16 | Same transaction keeps the lock pinned and sets `hold = true`, `holdReason` |
| Hold release | Fenced transaction (`owner`, `N`, `hold = true`) by (a) never-started evidence (`NOT_STARTED` except `REJECTED_*`, or `NEVER_SEEN`) for the held `commandId` from the owning agent, recorded as an automatic resolution with the agent as actor; or (b) the existing operator resolution, which now also releases the hold. A late `FINISHED` (any exit code) is recorded as evidence and notified, but releases the hold only through (b) |

A fencing token is never reused: the lock item is never deleted (existing rule) and a pinned or held lock has no TTL.

### 9.2 Why no event delay can free a target
The lock has no time expiry after X9, so a delayed, lost or unprocessed `ACCEPTED`, `HEARTBEAT` or `FINISHED`, an Executor restart or an agent disconnection only **delays** the release. The reconciler never releases a pinned lock by time; at `hardDeadlineAt` it only moves the execution to X16 with a hold. `hardDeadlineAt` is computed at X9 from values the agent enforces (start before `notAfter`, kill at `timeout + killGrace`), so after it no process of that command can exist **if the agent honors its contract**; even then the target stays held (AP-3) until evidence or an operator says otherwise.

### 9.3 Evidence queries
For an execution in `DEPLOYING` without events after `notAfter + skew + margin`, or in X16 with a hold, the reconciler sends `AGENT_QUERY` (exponential backoff, at most one outstanding). Because the query is in the command's FIFO group, the agent processes any pending copy of the command first (it becomes `EXPIRED`), then answers from its journal. A lost or recreated journal can never produce false evidence: `NEVER_SEEN` requires `issuedAt > journalEpoch` (§6), else `NO_RECORD`.

## 10. Agent

### 10.1 Catalog (`/etc/cicd-agent/catalog.json`, root-owned 0644; config `/etc/cicd-agent/agent.json`)

```json
{
  "agentId": "<AGENT_ID>",
  "stage": "dev",
  "maxParallel": 3,
  "maxPending": 20,
  "resources": { "docker-engine": 1, "db-migrations": 1 },
  "targets": {
    "reporting-tool-dev": {
      "scriptId": "deploy-reporting-tool-dev",
      "path": "/opt/cicd/scripts/deploy-reporting-tool-dev.sh",
      "arguments": "standard",
      "runAs": "<DEPLOY_USER>",
      "timeoutSeconds": 1800,
      "killGraceSeconds": 30,
      "resources": ["docker-engine"],
      "scriptRoleArn": "<TARGET_SCRIPT_ROLE_ARN or absent>"
    }
  }
}
```

A new application or environment is a new catalog entry, a script and (optionally) a script role. No agent code change.

### 10.2 Validation before any acceptance
Schema; `commandId` not already journaled (else duplicate: never re-run); `issuedAt` not before `journalEpoch` (`PREDATES_JOURNAL`); `SenderId` role id = Executor role id (agent config); `agentId` = self; `targetId` in catalog with that `scriptId`; `args` match the catalog argument mode; `now ≤ notAfter`; clock offset to AWS (measured by the SDK on every call) ≤ skew, else `NOT_STARTED CLOCK_SKEW`; fencing rule (§10.4).

### 10.3 Journal states and failure windows (persisted, fsync on every change)

| Agent state | Meaning | If the agent stops here | Message in SQS |
|---|---|---|---|
| (in memory) `RECEIVED` | Not yet accepted | Restart: message becomes visible again and is processed normally | Not deleted |
| `ACCEPTED` | Validated, slot reserved, target claimed (§10.4) | Restart: never started → `NOT_STARTED ABANDONED` (never starts it later) | Deleted right after the journal write; a redelivery finds the entry and only re-sends its last event |
| `STARTING` | Written **immediately before** `spawn` | Restart: may have started → `LOST` (process group was killed with the agent) | Deleted |
| `STARTED` (`pid`) | Running | Restart: `LOST` | — |
| `FINISHED` (exit code, `CICD_RESULT`, timing) | Ended | Restart: re-sends `FINISHED` from the outbox; uploads pending logs | — |
| `CLOSED` | `FINISHED`/`NOT_STARTED`/`LOST` delivered and logs uploaded or failed | Pruned after 30 days (journal retention ≥ 30 days) | — |

Order on the agent: validate → wait for slot (extending the message visibility) → journal `ACCEPTED` (+ target claim) → `DeleteMessage` → journal `STARTING` → `spawn` → journal `STARTED`. `ACCEPTED`/`STARTED` events are sent through the outbox **without blocking the start** (connectivity does not delay a deploy; the lock is already pinned). If `notAfter` passes before `STARTING`, the command is `NOT_STARTED EXPIRED`.

**Real guarantees:** a command **starts at most once**; a run that was interrupted is reported `LOST` (unknown effect, target held); a command that never started is reported `NOT_STARTED` and retried with a new dispatch; nothing is lost silently, because silence leads to a query and, without an answer, to X16 with a hold. **Exactly-once execution of side effects cannot be guaranteed** across crashes (a run killed mid-way has an unknown effect); the system guarantees *at most once per command* plus *explicit unknown with a blocked target*.

### 10.4 Agent-side exclusivity and fencing (`/var/lib/cicd-agent/targets/<targetId>.json`, fsync)
`{ highestFencingToken, activeCommandId }`, updated atomically with the `ACCEPTED` journal write. A command may be accepted only if `activeCommandId` is empty (or is this command) and `fencingToken > highestFencingToken`; equal tokens are accepted only for the same `commandId`. A lower token is `NOT_STARTED STALE_FENCING`. `activeCommandId` is cleared only when the command reaches `FINISHED`, `NOT_STARTED` or `LOST`. These files survive restarts; a new agent installation starts from the highest token seen on its first command (the central lock guarantees monotonic tokens).

### 10.5 Execution
`spawn("/usr/bin/sudo", ["-n", "-u", runAs, "--", path, ...args], { shell: false, detached: true })` with an environment allowlist (`PATH`, `LANG`, plus the script role's temporary credentials when configured); timeout → `SIGTERM` to the process group, `SIGKILL` after `killGraceSeconds`. systemd `KillMode=control-group`: if the agent dies, its scripts die with it.

### 10.6 Concurrency on multi-application servers

| Layer | Purpose | Behavior |
|---|---|---|
| Central lock per target | One run per target platform-wide | Unchanged; independent targets never wait for each other |
| FIFO `MessageGroupId = targetId` | Order per target (command, re-sends, queries) | SQS FIFO does not deliver the next message of a group while one is in flight. The agent holds an in-flight command only while waiting for a slot, so only **that target's** messages wait; other targets' groups are delivered in parallel |
| `maxParallel` per agent | Protect the host | Counts running scripts |
| Named `resources` with capacities | Shared critical resources (Docker engine, migrations, a proxy reload) | A command needs a free unit of **every** resource it declares; reserved all-or-nothing (no deadlock) |
| `maxPending` | Bound the in-flight commands kept waiting | When reached, the agent stops receiving until a slot frees (messages stay in SQS) |
| Script `flock` (AC-03) | Last line of defense | Unchanged (exit 50 → X14) |

Scheduling: pending commands are started in arrival order **among those whose resources are free** (a long Docker deploy does not block an application that needs no Docker); a command waiting longer than half its start window gets priority to avoid starvation. A command that cannot obtain its resources before `notAfter` is `NOT_STARTED BUSY` (X14: central retry). `MessageGroupId = targetId` plus `maxParallel` alone would not be enough: without named resources two different targets sharing Docker could run together; without the "start whichever is free" rule one waiting command would idle the agent.

### 10.7 Operating system (multi-application servers)

| Item | Rule |
|---|---|
| Agent user | `cicd-agent`, no login shell, not in `docker` |
| Privilege | `sudoers` with exact script paths only, one line per catalog script: `cicd-agent ALL=(<DEPLOY_USER>) NOPASSWD: /opt/cicd/scripts/deploy-reporting-tool-dev.sh` |
| Deploy users | One per application or environment where possible; only the deploy user is in `docker` when its script needs it |
| Files | Catalog, config and scripts root-owned, not writable by `cicd-agent` or deploy users; state under `/var/lib/cicd-agent` (0700) |
| systemd | `Restart=on-failure`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/cicd-agent`, `PrivateTmp=yes`, `TimeoutStopSec` ≥ longest timeout + kill grace, `KillMode=control-group`, journald |

## 11. Security and IAM

### 11.1 Agent identity (the agent uses the SDK default credential chain; the mechanism is configuration)
EC2: instance profile. On premises: IAM Roles Anywhere, one certificate per server (subject = `agentId`), trust condition on the subject, AWS signing helper as `credential_process`. Fallback only if Roles Anywhere is not feasible: one IAM user per agent whose only permission is `sts:AssumeRole` on its agent role. Never a shared credential.

### 11.2 Agent role (one per agent, from `agent-stack.yaml`)
`sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes` on **its** command queue; `sqs:SendMessage` on the results queue; `s3:PutObject` on `logs/<project>/<environment>/<targetId>/*` of its catalog targets; `sts:AssumeRole` on the script roles of its catalog targets. Nothing else.

### 11.3 Script roles (one per target that needs AWS, from `target-script-role.yaml`)
The target's own secrets, ECR repositories and other services its script needs. Trusted only by the agent roles that serve the target; session name = execution id (CloudTrail). Credentials are passed only to that script's process. DEV and PROD targets use different script roles.

### 11.4 Authenticity without signatures
Only the Executor role may send to a command queue (queue policy with explicit deny for every other principal). `SenderId` is set by SQS from the authenticated caller; the agent checks it. Only agent roles may send to the results queue; the Executor maps `SenderId` → `AGENT#<agentId>.roleId` and refuses events for executions or targets that agent does not serve. Limitation: whoever holds the Executor role credentials can forge commands, and a signing key usable by the same role would add nothing; the control is protecting the Executor identity (AP-9).

### 11.5 Executor role (additions)
`sqs:SendMessage` on the command queues of its stage (name prefix); `ReceiveMessage`/`DeleteMessage`/`ChangeMessageVisibility` on the results queue. No S3 read.

## 12. Logs in S3

| Item | Design |
|---|---|
| Bucket | One per platform stage in the platform stack: Block Public Access, bucket-owner-enforced, SSE-S3, TLS-only policy; lifecycle per environment prefix: DEV 90, STAGING 180, PROD 365 days |
| Keys | `logs/<project>/<environment>/<targetId>/<executionId>/<dispatchToken>/stdout.log.gz`, `stderr.log.gz`, `meta.json` (agent, script, commit, request, start, end, duration, exit code, timeout, signal, `CICD_RESULT`) |
| Capture | Streamed to 0600 files, 20 MB cap each (truncation marked), redaction of known secret patterns, gzip; uploaded after `FINISHED`, `LOST` (partial output kept) and timeouts |
| Upload failure | Retried from the outbox with backoff, across restarts; never delays `FINISHED`; `LOG_UPLOADED` with `status = FAILED` after 24 h of retries; the local copy is kept 7 days |
| Access | IAM role or SSO permission set with `s3:GetObject` on `logs/*` (optionally per project prefix). Notifications carry an **AWS console link**: access is checked by IAM at click time |

## 13. Notifications
Executor only. Messages carry project, environment, commit, duration, result or cause, and the log link; `STARTED`, hold placed and hold released are new kinds. `CICD_NOTIFICATIONS_DISABLED=true` stays in force until the owner restores Slack.

## 14. Infrastructure and scale

| Template | One per | Contains |
|---|---|---|
| Platform stack (existing, extended) | Platform stage | Results FIFO queue + DLQ + policy, log bucket + policy + lifecycle, Executor permissions, alarms (DLQs, oldest message, stale agent, holds) |
| `agent-stack.yaml` (new) | Agent (server × platform stage) | Command FIFO queue + DLQ + policy, agent role, identity binding |
| `target-script-role.yaml` (new, optional) | Target that needs AWS | Script role |

About 45 targets on a few servers: one agent stack per server and stage, one script role per target that needs AWS. Tags: `Project=ONECGIAR-CICD-Platform`, `Stage`, `AgentId` or `TargetId`.

## 15. SSH coexistence (AP-8)
`transport: ssh` keeps its synchronous path. Its only change is the hold rule: an SSH X16 keeps the lock (pinned + hold) instead of letting the lease expire, because an SSH script ignores `HUP` and may keep running. Removal of the SSH path needs a later review and authorization.

## 16. Failure scenarios

| # | Scenario | Execution | Lock | Agent | Recovery | Target exclusivity |
|---|---|---|---|---|---|---|
| 1 | Executor fails after X9, before the send | `DEPLOYING`, `PENDING_SEND` | Pinned | — | Reconciler re-sends the same command before `notAfter − margin`; later query → `NEVER_SEEN` → X14 retry | Pinned lock |
| 2 | Command delivered, `SENT` not written | `DEPLOYING`, `PENDING_SEND` | Pinned | Runs it once | Re-send removed by FIFO dedup or the journal; events close normally | Pinned lock + journal |
| 3 | `ACCEPTED` sent, Executor does not process it | `DEPLOYING` | Pinned | Runs | Events wait in SQS; closing is applied when the Executor processes them; nothing expires | Pinned lock (no time expiry) |
| 4 | Agent stops before `spawn` (`ACCEPTED`, no `STARTING`) | `DEPLOYING` | Pinned | Restart: `NOT_STARTED ABANDONED` | X14 retry with a new dispatch | Released only on that proof |
| 5 | Agent stops during the deploy | `DEPLOYING` → X16 | Hold | Restart: `LOST` (process group killed with the agent) | Operator resolution (logs uploaded with the partial output) | Hold |
| 6 | Agent loses AWS connectivity during the deploy | `DEPLOYING`; X16 + hold if `hardDeadlineAt` passes first | Pinned / hold | Script continues; timeout enforced; events kept in the outbox | When back: events applied (or recorded as late evidence) | Pinned / hold |
| 7 | Script ends, `FINISHED` cannot be sent | `DEPLOYING`; X16 + hold after `hardDeadlineAt` | Pinned / hold | `FINISHED` journaled, re-sent with backoff | Applied normally if before the deadline; otherwise late evidence + operator | Pinned / hold |
| 8 | Result arrives after X16 | `UNKNOWN_TARGET_STATE` (terminal) | Hold | — | Recorded in `lateEvents[]`, notified; never-started evidence releases the hold automatically, `FINISHED` through the operator | Hold until then |
| 9 | Second command for the same target with another `dispatchToken` | Possible only after the previous one was closed with proof (the lock was pinned); or a stale re-send | Pinned by the new owner | Accepts only a higher fencing token and only with no active command; a stale one is `NOT_STARTED STALE_FENCING` | — | Central lock + agent target state + script `flock` |
| 10 | Two applications share Docker | Independent executions | Independent | `resources: ["docker-engine"]` capacity 1 serializes them; the other targets keep running | `BUSY` → X14 only if the wait reaches `notAfter` | Different targets; shared resource serialized by the agent |
| 11 | Executor restarts with several deploys running | All `DEPLOYING` in DynamoDB | All pinned | Unaffected | Results queue buffers events; the consumer resumes; the reconciler re-sends or queries | Pinned locks |
| 12 | Log upload fails or is interrupted | Closed normally (upload never delays `FINISHED`) | Released per the result | Outbox retries across restarts; `LOG_UPLOADED FAILED` after 24 h; local copy 7 days | Notification shows "logs pending/failed" | — |

## 17. Timing values (AP-7, configurable)
`notAfter` 5 min, heartbeat 60 s, `killGrace` 30 s, skew 60 s, margin 120 s. Review: all safe because no lock depends on them any more. Adjustments: `killGrace` is a **per-script** catalog value with 30 s as default (some container shutdowns need longer); the Executor must use the same value in `hardDeadlineAt`, so the command carries `killGraceSeconds` and the agent refuses a catalog value larger than the command's (`REJECTED_CONFIG`). The skew check uses the SDK's measured clock offset to AWS, never `SentTimestamp` (queue waiting time is not skew).

## 18. Tests without real servers
Unit (validation, journal states, target state file, scheduler with resources, outbox, applier rules, lock pin/hold/release, reconciler), contract (shared schemas, templates), local integration with Executor and agent processes on DynamoDB Local + ElasticMQ FIFO (`SenderId` injected; the real behavior is checked in AWS at E5), and every scenario of §16 plus duplicates, out-of-order events, stale fencing, clock skew and the 24 h TTL rule. Whole current suite as regression, including SSH.

## 19. Plan

| Stage | Content | Acceptance | Checkpoint | Hours (min / probable / max) |
|---|---|---|---|---|
| E0 | This document approved; design, requirements and tasks updated | Owner approval; reviewer PASS | Owner | 8 / 14 / 24 |
| E1 | Schemas, registry records, admin tool support, contract tests | Contract tests green; existing records valid | Local commit | 10 / 16 / 24 |
| E2 | Executor async path: outbox dispatch, results consumer and applier, lock pin/hold/release and TTL rule, X11/X14 causes, reconciler (re-send, query, deadlines), evidence resolution, SSH X16 hold | Unit + integration green; §16 Executor-side scenarios; SSH suite green | Local commit | 60 / 90 / 130 |
| E3 | `agent/` package: config, catalog, validation, journal states, target state, scheduler with resources, outbox, spawn via sudo, timeouts, S3 upload, queries, systemd unit, packaging | Unit + local §16 scenarios green | Local commit | 50 / 75 / 110 |
| E4 | Templates: platform additions, `agent-stack.yaml`, `target-script-role.yaml` | `sam validate --lint` + contract tests | Change sets only with authorization | 14 / 22 / 32 |
| E5 | AWS resources for one agent; agent on a disposable host or the DEV server with a no-op script | Round trip, duplicates, restart, expiry, query in AWS | Authorization (AWS, server, identity) | 16 / 30 / 55 |
| E6 | Reporting Tool DEV on `sqs-agent` | First real deploy `SUCCEEDED`, version `VERIFIED`, logs in S3 | Explicit authorization | 12 / 22 / 40 |
| E7 | Notifications with links, Slack restored, runbooks, onboarding guide | Each outcome gives the right message and link | Owner | 10 / 16 / 26 |
| | **Total** | | | **180 / 285 / 441** |

Revision 2 adds about 25 probable hours (E2 +15, E3 +10). Critical path: E0 → E1 → E2 → E5 → E6; E3 and E4 in parallel after E1.

## 20. Decisions

**Approved by the owner (2026-10-10):** AP-1 FIFO queues for commands and results; AP-2 per-target script roles, agent identity separate, no shared permanent credentials; AP-3 UNKNOWN keeps the target blocked until evidence or an authorized operator; AP-4 one agent per server and platform stage; AP-5 EC2 instance profile, IAM Roles Anywhere on premises, one identity per agent (CA and inventory in the infrastructure phase); AP-6 log retention 90/180/365 days, SSE-S3, private bucket, IAM/SSO access, logs from the MVP, links in notifications; AP-7 timing values above, configurable; AP-8 SSH kept during the transition, removal only after a later review; AP-9 Executor hosting decided before STAGING, design independent of the workstation, temporary credentials through a role.

**Still open:**

| # | Decision | Recommendation |
|---|---|---|
| OP-1 | A late `FINISHED` with exit 0 after X16: release the hold automatically (the script ended and succeeded) or only through the operator | Operator only in the MVP (AP-3 wording); revisit after E5 |
| OP-2 | Operator tooling for holds (CLI command on the existing operator role vs a new event) | Reuse `TARGET_RESOLUTION_RECORDED` and the operator CLI |

## 21. Spec impact once approved
Design §1.2, §5.1 (execution, lock and agent items, lock TTL rule), §6.3 (target record), §6.4–§6.6 (agent, logs, notifications), §7.2–§7.5 (dispatch, X11/X14 causes, X16 hold, lock lifecycle), §11, DD-09 (pinned lock and hold), new DD for the agent; requirements FR-11, FR-12, FR-14, FR-15, NFR-01, NFR-04; tasks E0–E7; `docs/STATUS.md`.

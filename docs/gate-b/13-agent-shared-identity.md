<!-- @akili-spec changes/cicd-executor-poc architecture-change-04 §11, AP-5 (amended by the owner, 2026-10-13), E5 -->
# 13. Shared agent identity: one IAM user, one queue per agent (AC-04 E5)

**Answer first.**
- **Identity.** One IAM user per platform stage, `cicd-agents`, shared by every agent (owner decision, 2026-10-13;
  it replaces the per-agent identities of AP-5 for the agents). Its access key lives in the Secrets Manager secret
  `cicd/agents/credentials`. The owner copies it into each server's `config/agent.env`; **the agent never reads
  Secrets Manager**.
- **Queues.** One FIFO command queue per agent (`agent-stack.yaml`, `IdentityMode=shared-iam-user`). One results
  queue and one log bucket per stage (`template.yaml`, `EnableAgentTransport=true`).
- **Each agent consumes only its own queue.** It refuses to start with any command queue but
  `cicd-agent-<stage>-<agentId>-cmd.fifo`, and every existing check stays: Executor sender, `agentId`, catalog target
  and `scriptId`, argument vector, fencing, `notAfter`, journal.
- **The central Executor is not modified.** Its role keeps its policy; the queues' own policies grant it the right to
  send commands and consume results. No GitHub Actions, DynamoDB or deploy-path change.
- **Status:** prepared and tested locally. No AWS resource exists; each AWS step needs the owner's authorization.

## 1. What changed

| Item | Before | Now |
|---|---|---|
| Agent identity | One role per agent (instance profile, instance role or Roles Anywhere) | Also `shared-iam-user`: no agent role, the stage's shared user consumes the queue |
| Credentials on the server | Temporary only | One long-lived access key of the shared user, in `config/agent.env` (0600) |
| Executor permissions for AC-04 | Two statements added to `ExecutorRole` | `AllowExecutorSend` in each command queue policy, `AllowExecutorConsume` in the results queue policy; `ExecutorRole` unchanged |
| Agent configuration | Any FIFO URL | `commandQueueUrl` must end with the agent's own queue name (loopback emulator URLs exempt) |
| New template | — | `infra/sam/agent-shared-identity.yaml`: user, access key, secret |

The role modes still exist and are unchanged for servers that may use them later.

## 2. Permissions

**Shared user `cicd-agents`** (`agent-shared-identity.yaml`): no console password, no managed policy, no group. Its
only policy:

| Sid | Actions | Resource |
|---|---|---|
| `ConsumeAgentCommandQueues` | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility` | `cicd-agent-<Stage>-*-cmd.fifo` (never a DLQ, the results queue or another stage) |
| `SendAgentResults` | `sqs:SendMessage` | `cicd-agent-results-<Stage>.fifo` (not its DLQ) |
| `PutAgentLogs` | `s3:PutObject` | `cicd-agent-logs-<Stage>-<AWS_ACCOUNT_ID>-<AWS_REGION>/logs/*` |

These are exactly the agent's SDK calls. The user is tagged `CicdAgentStage=<Stage>`.

**Resource policies:**

| Resource | Allows | Denies |
|---|---|---|
| Each command queue | The Executor role to send | Sending by anyone but the Executor role; consuming by anyone but the shared user (or the agent role in a role mode) |
| Results queue | The Executor role to consume | Sending by principals without `CicdAgentStage=<Stage>`; consuming by anyone but the Executor role |
| Log bucket | Nothing | Any request without TLS; any upload that is not SSE-S3 |

Same account: a queue policy grant alone authorizes the Executor role, so its own policy needs no change.

## 3. Each agent consumes only its own queue

IAM cannot tell the agents apart: the shared key may read every command queue of the stage. The separation is in the
agent:

1. **At start** (`src/agent/config.ts`): `commandQueueUrl` must end with `/cicd-agent-<stage>-<agentId>-cmd.fifo`,
   built from the same `agent.json`. Any other queue, DLQ or stage: `agent refused to start`.
2. **It polls only that URL** (`src/agent/main.ts`); there is no queue discovery.
3. **Per command**, unchanged: only the Executor role may command (SQS `SenderId`), the command's `agentId` must be
   its own (`REJECTED_AGENT`), the target and `scriptId` must be in its catalog, plus the argument vector, fencing,
   `notAfter` and the journal.

A wrongly configured agent therefore cannot start; a command that still reached the wrong agent is refused, never run.

## 4. Risk of the shared key (accepted by the owner)

| With the key, anyone can | Nobody can, even with the key |
|---|---|
| Read or delete commands of every agent of the stage (lost commands: denial of service) | Send a command to any agent: only the Executor role may, and every agent checks the sender |
| Send results as any agent; the Executor cannot tell agents apart by `SenderId` | Run anything on a server, read DynamoDB or secrets, reach the deploy queue, change IAM |
| Upload objects under `logs/` of the stage's bucket | Read the logs, or write outside `logs/` |

- A leak from **one** server (any root or `docker` group member can read `agent.env`) exposes the transport of
  **all** agents of the stage. Rotate at once (§8).
- A rotation updates every server.
- The key is long-lived: rotate it every 90 days and whenever someone with server access leaves.

## 5. Server layout and `.env`

| Path under `<AGENT_HOME>` | Mode | Content |
|---|---|---|
| `releases/<release>/`, symlink `current` | read-only | The agent artifact (12 §2.1) |
| `config/agent.json`, `config/catalog.json` | 0600 | Agent configuration; the catalog lists only authorized scripts |
| `config/agent.env` | **0600** | Credentials and settings (`infra/agent/agent.env.example`) |
| `bin/start-agent.sh`, `bin/stop-agent.sh` | 0700 | From `infra/agent/bin/` |
| `node` (optional symlink) | — | A Node.js 22 installation, for example nvm's, when the default `node` is another version |
| `scripts/`, `data/`, `logs/` | 0700 | Catalog scripts, agent state, operational log |

`config/agent.env`:

```bash
AWS_ACCESS_KEY_ID=<from cicd/agents/credentials>
AWS_SECRET_ACCESS_KEY=<from cicd/agents/credentials>
AWS_REGION=<AWS_REGION>
AWS_EC2_METADATA_DISABLED=true
CICD_AGENT_HOME=<AGENT_HOME>
NODE_ENV=production
```

`bin/start-agent.sh` refuses to start unless Node.js is 22 and `agent.env` exists with mode 0600. It then starts
`node --env-file=config/agent.env` in a clean environment with `HOME=<AGENT_HOME>`. The credentials:
- never appear on a command line;
- never reach the deploy scripts, which get only `PATH` and `LANG`;
- are never read from `~/.aws`.

`bin/stop-agent.sh` sends `SIGTERM` to that one process and waits for its drain.

## 6. AWS steps (each one authorized separately)

Before every step: `aws sts get-caller-identity` must print the platform account. A profile of another account must
never be used.

| Step | Command (outline) | Expected change set |
|---|---|---|
| A0 | `sam deploy` of `template.yaml`, every current stack parameter (`AdditionalCiRoleArns` included) + `EnableAgentTransport=false`, `--no-execute-changeset` | **No changes** |
| A1 | Same with `EnableAgentTransport=true` | 8 `Add` (11 §2); **no `Modify`**, `ExecutorRole` included |
| U | `aws cloudformation deploy --template-file infra/sam/agent-shared-identity.yaml --stack-name cicd-agents-identity-<Stage> --capabilities CAPABILITY_NAMED_IAM --parameter-overrides Stage=<Stage> --no-execute-changeset` | 3 `Add`: `AgentsUser`, `AgentsAccessKey`, `AgentsCredentialsSecret` |
| G | `aws cloudformation deploy --template-file infra/sam/agent-stack.yaml --stack-name cicd-agent-<Stage>-<AGENT_ID> --parameter-overrides Stage=<Stage> AgentId=<AGENT_ID> ExecutorRoleArn=<ExecutorRoleArn> ResultsQueueArn=<AgentResultsQueueArn> IdentityMode=shared-iam-user SharedAgentUserArn=<AgentsUserArn> --no-execute-changeset` | 5 `Add`: `CommandDlq`, `CommandQueue`, `CommandQueuePolicy`, 2 alarms; no IAM resource |

One G stack per server. Nothing changes in the platform stack or the shared identity when a server is added.

**Stop** on any `Remove`, any `Modify` of an existing resource, or a name that already exists.

## 7. Filling `agent.env` (owner)

On the server, create the empty file with the right mode first:

```bash
install -m 0600 /dev/null <AGENT_HOME>/config/agent.env
```

Then either option:

1. **Paste by hand.** Read the secret in the AWS console (Secrets Manager, `cicd/agents/credentials`, "Retrieve
   secret value"), open `agent.env` in an editor on the server and type the six lines of §5.
2. **From the workstation, without printing the values** (PowerShell):

   ```powershell
   $s = aws secretsmanager get-secret-value --secret-id cicd/agents/credentials --region <AWS_REGION> --query SecretString --output text | ConvertFrom-Json
   $tmp = Join-Path $env:TEMP "agent.env"
   [IO.File]::WriteAllText($tmp, "AWS_ACCESS_KEY_ID=$($s.AWS_ACCESS_KEY_ID)`nAWS_SECRET_ACCESS_KEY=$($s.AWS_SECRET_ACCESS_KEY)`nAWS_REGION=<AWS_REGION>`nAWS_EC2_METADATA_DISABLED=true`nCICD_AGENT_HOME=<AGENT_HOME>`nNODE_ENV=production`n")
   Remove-Variable s
   scp $tmp <AGENT_USER>@<SERVER>:<AGENT_HOME>/config/agent.env
   Remove-Item $tmp
   ```

`scp` into the existing file keeps its 0600 mode. Then check it with `stat -c '%a %U' <AGENT_HOME>/config/agent.env`,
which must print `600 <AGENT_USER>`.

## 8. Rotation

1. Update stack U with `KeySerial` raised by one. The change set must show only `AgentsAccessKey` (replacement) and
   `AgentsCredentialsSecret` (modify).
2. When it completes, the old key no longer exists. Agents still holding it back off (`poll failed`) and lose
   nothing: commands wait in SQS for 4 days and results in each agent's outbox.
3. On every server, refill `agent.env` (§7), then run `bin/stop-agent.sh` and `bin/start-agent.sh`.

## 9. First no-op test

1. Install the agent (12 §2) with `bin/` from this change.
2. Set `agent.json`:
   - `commandQueueUrl`: output `CommandQueueUrl` of stack G;
   - `resultsQueueUrl` and `logBucket`: outputs of the platform stack;
   - `executorRoleId`: platform output `ExecutorRoleId`.
3. Run `bin/start-agent.sh`; the log shows `agent started` and no `poll failed`.
4. On the workstation, under the Executor profile, use `Read-Results` (12 §6.1). It shows `AGENT_HEARTBEAT`, whose
   `sender` is the shared user's id.
5. Send one no-op command (12 §7). Expected: `ACCEPTED`, `STARTED`, `FINISHED exit=0`, `LOG_UPLOADED`.
6. Run `bin/stop-agent.sh`.

## 10. Executor integration (later; not implemented)

The test of §9 does not involve the running Executor. For the Executor to consume results and record them in
DynamoDB:

| Change | Where | Why |
|---|---|---|
| Accept the shared user's unique id (`AIDA…`) as the agent record's `roleId` | `schemas/agent-record.schema.json` (pattern `^AROA…`), then a new Executor build | An IAM user's SQS `SenderId` is its user id, not a role id |
| Accept that every agent of the stage has the same `roleId` | Documentation of the sender check (`SENDER_NOT_THE_TARGET_AGENT`) | The check then proves "an agent of this stage", not "this agent" (§4) |
| `CICD_AGENT_RESULTS_QUEUE_URL` and `CICD_AGENT_LOG_BUCKET` in the Executor environment, then a restart | Executor configuration | Enables the results consumer and the `sqs-agent` dispatch |
| Agent record and `sqs-agent` target record | Registry (DynamoDB), `tools/target-registry` | The Executor resolves the target to its agent and queue |

No IAM change is needed for the Executor: the queue policies already grant it.

## 11. Cleanup

- Delete G per server.
- Delete U: this removes the user and its key. The secret is scheduled for deletion and its name stays reserved
  during the recovery window.
- Revert A1 as in 11 §7.

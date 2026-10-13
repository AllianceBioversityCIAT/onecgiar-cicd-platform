<!-- @akili-spec changes/cicd-executor-poc architecture-change-04 §10, §11.1, §19 (E5), §23 -->
# 12. Agent on an existing TEST server: install, validate, remove (AC-04 E5)

**Answer first.**
- **Roles.** The owner runs every command on a TEST server they choose and administer; Claude prepares and analyzes.
  No compute is created anywhere.
- **What runs.** One small Node.js 22 process under its own user and directory, with a catalog of **one no-op
  script**. It opens no port, starts no service and never touches Docker, PM2 or the applications.
- **Stages without AWS.** Stages 1–5 run without AWS: the agent starts, idles and stops.
- **Stages that need AWS.** Stages 6–8 need the central AWS resources of
  [11-agent-transport-e5.md](11-agent-transport-e5.md), and **each needs the owner's separate authorization**.

| Stage | Needs AWS | What it proves |
|---|---|---|
| 0 Collect data, safety checklist | No | The server fits; nothing will be touched |
| 1 Check requirements (read-only), baseline snapshot | No | Node.js 22 possible, clock, egress, disk |
| 2 Install in `/opt/cicd-agent` | No | Own user, own directory, no `npm install` |
| 3 Start with Node.js, no AWS access | No | Starts, backs off, writes only its own files |
| 4 Resource use | No | Idle CPU about 0, RSS about 50–70 MB |
| 5 Applications unchanged | No | Same processes, containers, ports |
| 6 Connect to SQS | **Yes** | Identity, heartbeat, `SenderId` |
| 7 Run the no-op script | **Yes** | One command, one run, logs in S3 |
| 8 Results, logs, deduplication, recovery | **Yes** | FIFO deduplication, journal, fencing, `notAfter`, `LOST` recovery |
| 9 Stop and restart only the agent | No / Yes | Drain, clean exit |
| 10 Remove | No (+ AWS cleanup) | Server back to its state before stage 2 |

Validated locally on Windows (not on Linux):
- the artifact recipe of stage 2 starts with no AWS access: `agent started`, back-off 5→10→20→40 s, RSS about
  52 MB, exit 0 on stop;
- a dry run of `make-message.mjs` → the real agent → `noop-deploy.sh` (bash) gave `ACCEPTED`, `STARTED`,
  `FINISHED SUCCESS`, `LOG_UPLOADED`, then a re-sent `FINISHED` for a redelivery and a query, and `STALE_FENCING`
  for a reused token. All events were schema-valid.

## 0. Values the owner provides, and data to collect from the server

**Values** (the guide never invents them):

| Variable | Meaning | Example shape |
|---|---|---|
| `<TEST_HOST>` | The TEST server and how the owner reaches it (SSH, SSM, console) | owner's choice |
| `<ADMIN_USER>` | The owner's account on it with root through `sudo` | — |
| `<AGENT_ID>` | Agent id, 2–40 of `a-z0-9-` | `test-<server>-dev` |
| `<AGENT_USER>` | The agent's OS user | `cicd-agent` |
| `<RELEASE>` | Platform commit packaged | `c28f0d3` (E4) |
| `<NODE_VERSION>` | Node.js 22 LTS version for a private runtime, if needed | `22.x.y`, at least two weeks old |
| `<ARCH>` | `x64` or `arm64` (from `uname -m`) | — |
| `<AWS_REGION>`, `<AWS_ACCOUNT_ID>` | The platform account and region | — |
| `<EXECUTOR_PROFILE>` | Owner's local AWS CLI profile that assumes the Executor role | `cicd-executor-pilot` |
| `<APP_HEALTH_COMMANDS>` | Read-only checks of the server's applications (for example `curl -fsS <URL>`) | owner's choice |

**Data to collect in stage 1** (send the outputs for analysis):

| # | Item | Why |
|---|---|---|
| D1 | OS, version, `uname -m`, glibc (`ldd --version`) | Official Node.js 22 builds need glibc ≥ 2.28 |
| D2 | `node --version` and its path, if any | Reuse it if it is 22.x; never upgrade it (applications may depend on it) |
| D3 | EC2 or not; if EC2: instance id, existing instance profile role ARN, IMDSv2 setting | Chooses the identity mode (§6.1) |
| D4 | Free space on `/opt`, and its mount options (`noexec`?) | About 250 MB are needed; the agent and its script run from `/opt` |
| D5 | Clock sync status | Commands are refused (`CLOCK_SKEW`) beyond 60 s of skew |
| D6 | Outbound HTTPS to SQS, S3 and STS in the region, with no proxy | The agent has no proxy support |
| D7 | PM2: daemons and their users; Docker: present or not | Baseline only; nothing is changed |
| D8 | Whether creating a system user is allowed on this server | Isolation (stage 2) |
| D9 | `<APP_HEALTH_COMMANDS>` | Before/after comparison |

## Safety checklist (all must hold before stage 2)

- [ ] The server is TEST, not PROD, and the owner can restore it.
- [ ] Nothing in this guide restarts or stops Docker, PM2, systemd units or applications. The commands that **must
      not be run** are `docker system prune`, any `docker`/`pm2` command that writes, `pm2 kill`, `pm2 update`,
      `pm2 save`, `pm2 restart all`, `systemctl` on any unit, firewall commands and `chmod`/`chown` outside
      `/opt/cicd-agent`.
- [ ] No inbound port is opened; the agent listens on nothing (checked in stage 5).
- [ ] No `npm install` and no build on the server: the artifact arrives complete.
- [ ] The catalog has exactly one entry, the no-op script, `"runAs": "self"`; no sudoers rule is added.
- [ ] Credentials are temporary only (§6.1). No access keys of an IAM user.
- [ ] `/opt/cicd-agent` and the user `<AGENT_USER>` do not exist yet (`ls -ld /opt/cicd-agent; getent passwd <AGENT_USER>`
      both print nothing).
- [ ] The baseline snapshot of stage 1 is saved.
- [ ] Stages 6–8 start only after the AWS authorization of [11](11-agent-transport-e5.md).

## 1. Check requirements (read-only) and take a baseline

On the server, as `<ADMIN_USER>`. Nothing here changes the server.

```bash
mkdir -p ~/cicd-agent-e5 && cd ~/cicd-agent-e5
{ cat /etc/os-release; uname -m; ldd --version | head -1; } > d1-os.txt
{ command -v node && node --version; } > d2-node.txt 2>&1
findmnt -no TARGET,OPTIONS --target /opt > d4-opt-mount.txt; df -h /opt >> d4-opt-mount.txt
{ timedatectl 2>/dev/null || date -u; chronyc tracking 2>/dev/null; } > d5-clock.txt
for h in sqs.<AWS_REGION>.amazonaws.com s3.<AWS_REGION>.amazonaws.com sts.<AWS_REGION>.amazonaws.com; do
  printf '%s ' "$h"; curl -sS -o /dev/null -m 10 -w '%{http_code}\n' "https://$h/" || echo FAILED
done > d6-egress.txt
env | grep -i _proxy >> d6-egress.txt || true
ps -eo user,pid,args | grep '[P]M2 v' > d7-pm2-daemons.txt || true
command -v docker > d7-docker.txt 2>&1 || true
# Baseline (repeat in stage 5 and after stage 10):
ps -eo user,pid,ppid,pcpu,rss,etime,args --sort=user > base-ps.txt
ss -lntup 2>/dev/null > base-listen.txt || ss -lntu > base-listen.txt
sudo docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > base-docker.txt 2>/dev/null || true
<APP_HEALTH_COMMANDS> > base-apps.txt 2>&1
```

**On EC2 (D3).** Read-only; IMDSv2 token first:

```bash
T=$(curl -sS -m 3 -X PUT http://instance-data/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
curl -sS -m 3 -H "X-aws-ec2-metadata-token: $T" http://instance-data/latest/meta-data/iam/info > d3-ec2.txt 2>&1 || echo "not EC2 or no profile" > d3-ec2.txt
```

`instance-data` resolves to the metadata address on EC2. Use the documented link-local address if it does not
resolve.

**PM2 baseline.** List applications **only for a user that already has a running daemon** (D7). On any other user,
`pm2` would start a new daemon:

```bash
sudo -u <PM2_USER> pm2 jlist > base-pm2-<PM2_USER>.json
```

**Expected:**
- D1 glibc ≥ 2.28;
- D4 `/opt` without `noexec`, at least 250 MB free;
- D5 synchronized;
- D6 an HTTP code for each host, for example `404`; any code shows TLS works. `FAILED` or a proxy variable is a
  blocker;
- the baseline files are not empty.

**Failure:** glibc < 2.28 (official Node.js 22 cannot run), `noexec` on `/opt` (use another root-owned directory and
adapt every path), no egress, or a proxy: stop and report.

## 2. Install (no `npm install` on the server)

### 2.1 Build the artifact on the owner's workstation (PowerShell)

```powershell
$REL = "<RELEASE>"; $BUILD = "<BUILD_DIR>"; $STAGE = "<STAGE_DIR>\cicd-agent-$REL"
git -C D:\executor_component worktree add $BUILD $REL        # clean checkout; the working copy is untouched
Set-Location "$BUILD\executor"; npm ci --no-audit --no-fund; npm run build
New-Item -ItemType Directory -Force "$STAGE\dist" | Out-Null
Copy-Item -Recurse dist\src "$STAGE\dist\src"; Copy-Item package.json, package-lock.json $STAGE
Copy-Item -Recurse ..\schemas "$STAGE\schemas"
New-Item -ItemType Directory -Force "$STAGE\pilot" | Out-Null
Copy-Item ..\infra\agent\pilot\noop-deploy.sh "$STAGE\pilot\noop-deploy.sh"
Copy-Item -Recurse ..\infra\agent\bin "$STAGE\bin"; Copy-Item ..\infra\agent\agent.env.example $STAGE   # 13 §5
Set-Location $STAGE; npm ci --omit=dev --ignore-scripts --no-audit --no-fund
Remove-Item -Recurse -Force node_modules\.bin                   # Windows shims, useless on Linux
Set-Location ..; tar -czf "cicd-agent-$REL.tar.gz" "cicd-agent-$REL"
(Get-FileHash "cicd-agent-$REL.tar.gz" -Algorithm SHA256).Hash   # note it: <ARTIFACT_SHA256>
git -C D:\executor_component worktree remove $BUILD            # after copying the artifact
```

`<RELEASE>` is a commit: everything in the artifact comes from it. `make-message.mjs` runs in the owner's working
copy (`D:\executor_component`, after `npm run build` in `executor\`).

The production dependencies are plain JavaScript (`--ignore-scripts` skips the optional native helper of `ssh2`,
which the agent does not load), so the Windows-built tree runs on Linux.

**Private Node.js 22**, only if D2 is not 22.x. Download on the workstation from `https://nodejs.org/dist/v<NODE_VERSION>/`
the file `node-v<NODE_VERSION>-linux-<ARCH>.tar.gz` and `SHASUMS256.txt`, and check:
`(Get-FileHash node-v<NODE_VERSION>-linux-<ARCH>.tar.gz -Algorithm SHA256).Hash` must equal its line in
`SHASUMS256.txt`.

Copy the artifact (and the Node.js tarball) to `/tmp` on the server with the owner's usual method.

### 2.2 Create the user and the directory (server, root)

```bash
sudo -i                                                    # every 2.x command runs as root
AGENT_USER=<AGENT_USER>; H=/opt/cicd-agent; REL=<RELEASE>
NOLOGIN=$(command -v nologin || echo /usr/sbin/nologin)
useradd --system --no-create-home --home-dir "$H" --shell "$NOLOGIN" "$AGENT_USER"
install -d -o root -g root -m 0755 "$H" "$H/releases" "$H/bin" "$H/scripts"
install -d -o root -g "$AGENT_USER" -m 0750 "$H/config"
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "$H/data"
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0750 "$H/logs"
```

If D8 forbids a new user, stop: the agent must not share an application's user.

### 2.3 Unpack the release and Node.js (server, root)

```bash
echo "<ARTIFACT_SHA256>  /tmp/cicd-agent-$REL.tar.gz" | sha256sum -c -        # must print OK
tar -xzf "/tmp/cicd-agent-$REL.tar.gz" -C "$H/releases"
chown -R root:root "$H/releases/cicd-agent-$REL"
find "$H/releases/cicd-agent-$REL" -type d -exec chmod 0755 {} +; find "$H/releases/cicd-agent-$REL" -type f -exec chmod 0644 {} +
ln -sfn "$H/releases/cicd-agent-$REL" "$H/current"
install -o root -g root -m 0755 "$H/current/pilot/noop-deploy.sh" "$H/scripts/noop-deploy.sh"
grep -c $'\r' "$H/scripts/noop-deploy.sh"                                     # must print 0 (no CRLF)
# Only with a private Node.js:
mkdir "$H/node" && tar -xzf /tmp/node-v<NODE_VERSION>-linux-<ARCH>.tar.gz -C "$H/node" --strip-components=1
chown -R root:root "$H/node"
"$H/node/bin/node" --version                                                  # v22.x
```

### 2.4 Configuration (server, root)

`$H/config/agent.json` (root:`<AGENT_USER>` 0640). The queue and bucket names are the ones E4 will create, so the
file is written once:

```json
{
  "agentId": "<AGENT_ID>",
  "stage": "dev",
  "region": "<AWS_REGION>",
  "commandQueueUrl": "https://sqs.<AWS_REGION>.amazonaws.com/<AWS_ACCOUNT_ID>/cicd-agent-dev-<AGENT_ID>-cmd.fifo",
  "resultsQueueUrl": "https://sqs.<AWS_REGION>.amazonaws.com/<AWS_ACCOUNT_ID>/cicd-agent-results-dev.fifo",
  "executorRoleId": "<EXECUTOR_ROLE_ID>",
  "logBucket": "cicd-agent-logs-dev-<AWS_ACCOUNT_ID>-<AWS_REGION>",
  "stateDir": "/opt/cicd-agent/data",
  "maxParallel": 1,
  "heartbeatSeconds": 60
}
```

`<EXECUTOR_ROLE_ID>` is the platform stack output `ExecutorRoleId` (it exists today). Until it is known, stages 3–5
can use `AROAEXAMPLEEXAMPL0001`.

`$H/config/catalog.json` (root:`<AGENT_USER>` 0640), exactly one no-op entry:

```json
{
  "agentId": "<AGENT_ID>",
  "targets": {
    "pilot-noop-test": {
      "scriptId": "pilot-noop",
      "path": "/opt/cicd-agent/scripts/noop-deploy.sh",
      "arguments": "standard",
      "runAs": "self",
      "timeoutSeconds": 300,
      "killGraceSeconds": 10,
      "resources": []
    }
  }
}
```

`$H/config/agent.env` (root:`<AGENT_USER>` 0640). For stages 3–5 it blocks **every** AWS credential source, so the
agent cannot reach AWS:

```bash
CICD_AGENT_HOME=/opt/cicd-agent
NODE_ENV=production
AWS_REGION=<AWS_REGION>
AWS_EC2_METADATA_DISABLED=true
AWS_CONFIG_FILE=/opt/cicd-agent/config/no-aws
AWS_SHARED_CREDENTIALS_FILE=/opt/cicd-agent/config/no-aws
```

`$H/bin/start-agent.sh` (root:root 0755):

```bash
#!/usr/bin/env bash
# Starts the CI/CD agent in the background as the calling user (run it as <AGENT_USER>). Touches nothing else.
set -euo pipefail
H=/opt/cicd-agent
NODE="${H}/node/bin/node"; [[ -x "${NODE}" ]] || NODE="$(command -v node)"
set -a; . "${H}/config/agent.env"; set +a
cd "${H}"
nohup setsid "${NODE}" "${H}/current/dist/src/agent/main.js" >>"${H}/logs/agent.log" 2>&1 </dev/null &
```

```bash
chown root:"$AGENT_USER" "$H/config/agent.json" "$H/config/catalog.json" "$H/config/agent.env"
chmod 0640 "$H/config/agent.json" "$H/config/catalog.json" "$H/config/agent.env"
chmod 0755 "$H/bin/start-agent.sh"
ls -laR "$H" | head -60                      # review: only data/ and logs/ belong to the agent user
```

**Expected:**
- `sha256sum` prints OK and Node prints `v22.x`;
- `/opt/cicd-agent` holds root-owned code, configuration and script; only `data/` and `logs/` are writable by the
  agent user.

**Failure:** a checksum mismatch (copy again) or CRLF in the script (convert it on the workstation).

## 3. Start with Node.js, without AWS

```bash
sudo -u <AGENT_USER> /opt/cicd-agent/bin/start-agent.sh
sleep 20; tail -n 20 /opt/cicd-agent/logs/agent.log
pgrep -a -u <AGENT_USER> -f /opt/cicd-agent/current/dist/src/agent/main.js
ls /opt/cicd-agent/data
```

**Expected:**
- the log shows `{"level":"info","message":"agent started",...}`, then `poll failed; retrying` lines with
  `Could not load credentials from any providers` and `retryInMs` growing 5000 → 10000 → 20000 → 40000 → 60000;
- one process;
- `data/` holds `journal outbox output targets meta.json`.

**Failure:**
- `agent refused to start`: the `problems` list names the file and field;
- a module error: the artifact is incomplete, so rebuild it;
- any line showing a successful AWS call: the credential sources are not blocked, so stop the agent (stage 9).

## 4. Resource use

```bash
for i in 1 2 3 4 5 6; do ps -o pid,rss,pcpu,etime,nlwp,args -u <AGENT_USER> | tail -n +2; sleep 10; done
ls /proc/$(pgrep -u <AGENT_USER> -f agent/main.js)/fd | wc -l
```

**Expected:** RSS about 50–70 MB and stable; `%CPU` 0.0 (a poll every ≤ 60 s while it backs off); a few dozen file
descriptors; one Node.js process and no child process.

**Failure:** RSS growing at every sample, `%CPU` that stays above 1, or child processes: stop the agent (stage 9) and
send the samples.

## 5. Applications unchanged

```bash
cd ~/cicd-agent-e5
ps -eo user,pid,ppid,pcpu,rss,etime,args --sort=user > now-ps.txt
ss -lntup 2>/dev/null > now-listen.txt || ss -lntu > now-listen.txt
sudo docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > now-docker.txt 2>/dev/null || true
<APP_HEALTH_COMMANDS> > now-apps.txt 2>&1
diff base-listen.txt now-listen.txt; diff base-docker.txt now-docker.txt; diff base-apps.txt now-apps.txt
grep -v ' <AGENT_USER> ' now-ps.txt | wc -l; grep -v ' <AGENT_USER> ' base-ps.txt | wc -l
```

**Expected:**
- no difference in listening sockets (the agent opens none), containers or application checks. Container status
  times naturally change ("Up 3 hours" becoming "Up 4 hours"), the names and images must not;
- application processes are the same; only the `<AGENT_USER>` lines are new.

**Failure:** any new listening socket, or any application change: stop the agent and report (stage 9, then 10).

## 6. Connect to SQS (only after the AWS authorization)

Prerequisites, from [11](11-agent-transport-e5.md):
- the platform change set A1 executed;
- the agent stack for `<AGENT_ID>` deployed;
- `agent.json` values confirmed against the stack outputs:

  | `agent.json` field | Stack output |
  |---|---|
  | `commandQueueUrl` | `CommandQueueUrl` |
  | `resultsQueueUrl` | `AgentResultsQueueUrl` |
  | `logBucket` | `AgentLogBucketName` |
  | `executorRoleId` | `ExecutorRoleId` |

### 6.1 Identity

**Owner decision (2026-10-13): the agents use the shared identity of [13](13-agent-shared-identity.md)** (one IAM
user per stage, key in `config/agent.env`, `bin/start-agent.sh`). The per-agent modes below stay available.

| Mode | When (D3) | Server change | AWS change (authorization) | Notes |
|---|---|---|---|---|
| **A. Existing instance role** (`ec2-instance-role`) | EC2 **with** an instance profile | One config file | Agent stack with `InstanceRoleArn` = that role | Nothing on the instance changes. On a shared server every process can use the instance role and therefore assume the agent role (see 11 §4) |
| **B. New instance profile** (`ec2-instance-profile`) | EC2 **without** a profile | None | Agent stack, then associate its instance profile with the instance | Gives every process on the host the agent role's credentials |
| **C. Roles Anywhere** (`roles-anywhere`) | Not EC2, or the strongest isolation | Signing helper binary + certificate | Agent stack + one trust anchor (self-managed CA; **no AWS Private CA**) | Key readable only by the agent user |
| **D. Owner-issued session** (`ec2-instance-role` with `InstanceRoleArn` = the owner's role, **pilot only**) | Any server, first short test | One env file, replaced hourly | Agent stack whose trust names the owner's role | Temporary credentials (≤ 1 h) the owner obtains with `aws sts assume-role`; nothing persistent; the stack is deleted after the test |

Recommendation: **A** if D3 shows an instance profile; otherwise **D** for the first short test, and **C** for
anything longer. B changes the instance's AWS configuration and exposes the agent role to every process.

`agent.env` per mode. Remove the three no-AWS lines of stage 2.4, then add:

```bash
# A
AWS_CONFIG_FILE=/opt/cicd-agent/config/aws-config
AWS_SHARED_CREDENTIALS_FILE=/opt/cicd-agent/config/no-aws
AWS_PROFILE=cicd-agent
# B
AWS_SHARED_CREDENTIALS_FILE=/opt/cicd-agent/config/no-aws
# C
AWS_CONFIG_FILE=/opt/cicd-agent/config/aws-config
AWS_SHARED_CREDENTIALS_FILE=/opt/cicd-agent/config/no-aws
AWS_PROFILE=cicd-agent
# D (values from: aws sts assume-role --role-arn <AGENT_ROLE_ARN> --role-session-name e5-<AGENT_ID> --duration-seconds 3600)
AWS_EC2_METADATA_DISABLED=true
AWS_ACCESS_KEY_ID=<TEMPORARY>
AWS_SECRET_ACCESS_KEY=<TEMPORARY>
AWS_SESSION_TOKEN=<TEMPORARY>
```

`/opt/cicd-agent/config/aws-config` (root:`<AGENT_USER>` 0640):

```ini
# A
[profile cicd-agent]
role_arn = <AGENT_ROLE_ARN>
credential_source = Ec2InstanceMetadata
role_session_name = <AGENT_ID>
region = <AWS_REGION>
# C (signing helper copied, root-owned, from the official IAM Roles Anywhere download; check its checksum)
[profile cicd-agent]
credential_process = /opt/cicd-agent/bin/aws_signing_helper credential-process --certificate /opt/cicd-agent/config/pki/agent.crt --private-key /opt/cicd-agent/config/pki/agent.key --trust-anchor-arn <TRUST_ANCHOR_ARN> --profile-arn <ROLES_ANYWHERE_PROFILE_ARN> --role-arn <AGENT_ROLE_ARN>
region = <AWS_REGION>
```

For C, generate the key **on the server**; it never leaves it. The owner's CA signs the request, and the certificate
needs CN = `<AGENT_ID>`, `digitalSignature` and `CA:FALSE`:

```bash
install -d -o root -g <AGENT_USER> -m 0750 /opt/cicd-agent/config/pki
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=<AGENT_ID>" \
  -keyout /opt/cicd-agent/config/pki/agent.key -out ~/cicd-agent-e5/agent.csr
chown root:<AGENT_USER> /opt/cicd-agent/config/pki/agent.key; chmod 0640 /opt/cicd-agent/config/pki/agent.key
```

Restart only the agent (stage 9), then watch the log and, on the workstation, the results queue.

**Workstation profile** (owner's local AWS config, never committed):

```ini
[profile <EXECUTOR_PROFILE>]
role_arn = <EXECUTOR_ROLE_ARN>
source_profile = <AWS_PROFILE_ADMIN>
role_session_name = e5-owner
region = <AWS_REGION>
```

The central Executor does not consume the results queue while `CICD_AGENT_*` are unset, so the owner reads it under
the Executor role (the queue policy allows no one else). Read and acknowledge results with this snippet
(PowerShell; also used in stages 7–8):

```powershell
$REGION = "<AWS_REGION>"; $EXECUTOR_PROFILE = "<EXECUTOR_PROFILE>"
$RESULTS_QUEUE_URL = "<AgentResultsQueueUrl>"; $CMD_QUEUE_URL = "<CommandQueueUrl>"
function Read-Results {
  $r = aws sqs receive-message --queue-url $RESULTS_QUEUE_URL --max-number-of-messages 10 --wait-time-seconds 10 `
       --visibility-timeout 30 --message-system-attribute-names SenderId --region $REGION --profile $EXECUTOR_PROFILE | ConvertFrom-Json
  foreach ($m in $r.Messages) {
    $b = $m.Body | ConvertFrom-Json
    $kind = if ($b.phase) { $b.phase } else { $b.type }
    "{0,-22} {1,-14} seq={2,-3} reason={3} exit={4} log={5} sender={6}" -f $b.executionId, $kind, $b.seq, $b.reason, $b.exitCode, $b.log.status, $m.Attributes.SenderId
    aws sqs delete-message --queue-url $RESULTS_QUEUE_URL --receipt-handle $m.ReceiptHandle --region $REGION --profile $EXECUTOR_PROFILE
  }
}
Read-Results
```

AWS CLI versions without `--message-system-attribute-names` take `--attribute-names SenderId` instead.

**Expected:**
- the log has no `poll failed` after start;
- within 60 s, `Read-Results` prints an `AGENT_HEARTBEAT` line whose `sender` starts with the agent stack output
  `AgentRoleId`.

**Failure:**
- `AccessDenied` in the log: identity or stack parameters, or a missing `CicdAgentStage` tag;
- `QueueDoesNotExist`: wrong URL;
- no heartbeat: egress or credentials;
- `CLOCK_SKEW` later: clock (D5).

**Negative checks** (workstation):
- `aws sqs send-message` to `$CMD_QUEUE_URL` with the **admin** profile must fail with `AccessDenied`: only the
  Executor may send;
- `aws sqs receive-message` on `$RESULTS_QUEUE_URL` with the admin profile must fail as well.

## 7. Run the no-op script once

On the workstation, in `<REPO>` (built):

```powershell
$OUT = "<WORK_DIR>\e5-messages"; $BUCKET = "<AgentLogBucketName>"
$C = @("--agent","<AGENT_ID>","--target","pilot-noop-test","--script","pilot-noop","--bucket",$BUCKET,"--project","cicd-pilot","--environment","test","--out",$OUT)
node infra/agent/pilot/make-message.mjs command @C --execution pilot-noop-test-1 --fencing 1
# run the printed "aws sqs send-message ..." line, then:
Read-Results
```

**Expected** (`Read-Results`, possibly over two calls):

```
pilot-noop-test-1   ACCEPTED   seq=1
pilot-noop-test-1   STARTED    seq=2
pilot-noop-test-1   FINISHED   seq=3  exit=0
pilot-noop-test-1   LOG_UPLOADED seq=4 log=UPLOADED
```

Every line's `sender` is the agent role id. Three objects are written under
`logs/cicd-pilot/test/pilot-noop-test/pilot-noop-test-1/<dispatchToken>/`:

```powershell
aws s3api list-objects-v2 --bucket $BUCKET --prefix logs/cicd-pilot/test/pilot-noop-test/ --query "Contents[].Key" --profile <AWS_PROFILE_ADMIN>
aws s3api head-object --bucket $BUCKET --key <KEY_OF_stdout.log.gz> --query ServerSideEncryption --profile <AWS_PROFILE_ADMIN>   # "AES256"
```

On the server:
- `cat /opt/cicd-agent/data/output/*/stdout.log` shows exactly one `noop: start` and `nothing is deployed`;
- `ls /opt/cicd-agent/data/journal` shows one entry.

**Failure:**
- `NOT_STARTED` with a reason: `REJECTED_*` is a configuration mismatch, `CLOCK_SKEW` is the clock, `PREDATES_JOURNAL`
  means a command older than the agent's first start;
- `FINISHED` with exit ≠ 0: read `stdout.log`;
- `LOG_UPLOADED` with `FAILED`: S3 permission or prefix.

## 8. Results, logs, deduplication, fencing and recovery

Run the tests in this order: fencing tokens must keep increasing. Every message is built with `make-message.mjs`
(`@C` from stage 7).

| # | Action | Expected |
|---|---|---|
| T2 | Re-run **the same** `send-message` line of T1 within 5 min | SQS absorbs it: no new event, no new journal entry |
| T3 | Same file, deduplication id with a suffix: `--message-deduplication-id "<commandId>-redelivery"` (a redelivery after the window) | One `FINISHED seq=5` re-sent; **no** new `STARTED`; still one `noop: start` |
| T4 | `command @C --execution pilot-noop-test-2 --fencing 1` (token already used) | `NOT_STARTED reason=STALE_FENCING`; script not run |
| T5 | Stop the agent (stage 9). Then `command @C --execution pilot-noop-test-3 --fencing 2 --not-after-seconds 60` and send it. Wait 2 min, start the agent | `NOT_STARTED reason=EXPIRED`; script not run (no new `data/output` directory) |
| T6 | `query --from <OUT>\command-pilot-noop-test-1.json --number 1 --out $OUT`, send it | `FINISHED` re-sent with a new `seq` |
| T7 | As root, set `SLEEP_SECONDS=60` in `/opt/cicd-agent/scripts/noop-deploy.sh`. Send `--execution pilot-noop-test-4 --fencing 3`. After `STARTED`, `kill -9 $(pgrep -u <AGENT_USER> -f agent/main.js)`; check that the script still runs (`ps -u <AGENT_USER> -o pid,args`); start the agent | Log: `a script of the previous agent process is still running: stopping it`; the script is gone; `LOST` then `LOG_UPLOADED` (partial output); never re-run |
| T8 | Still at 60 s: send `--execution pilot-noop-test-5 --fencing 4`; after `STARTED`, stop the agent (stage 9) | Log `agent stopping: draining`; `FINISHED exit=0` after about 60 s; then `agent stopped {"finished":1,"interrupted":0}` and the process exits by itself |
| T9 | `command @C --execution pilot-noop-test-6 --fencing 5 --not-after-seconds 60`, **do not send it**. Wait 3 min; `query --from …-6.json --number 1`, send the query | `NEVER_SEEN` (evidence: the command can no longer run). Sending the command afterwards gives no run (the journal holds a tombstone) |
| T10 | Set `SLEEP_SECONDS=5` back | — |
| T11 | S3: `aws s3api list-objects-v2 --bucket $BUCKET --prefix logs/ --endpoint-url http://s3.<AWS_REGION>.amazonaws.com --profile <AWS_PROFILE_ADMIN>` | `AccessDenied` (HTTPS only) |

T12 (mode D only, with the agent's temporary credentials on the workstation): `aws s3 cp` of a small file to another
prefix gives `AccessDenied`; to its own prefix without `--sse AES256` gives `AccessDenied`.

**Failure:** any second `STARTED` for one execution, a run after `EXPIRED`, `STALE_FENCING` or `NEVER_SEEN`, or a
script still alive after T7. Stop and send `logs/agent.log`, `data/journal/*.json` and the `Read-Results` output.

## 9. Stop and restart only the agent

```bash
pkill -TERM -u <AGENT_USER> -f /opt/cicd-agent/current/dist/src/agent/main.js
while pgrep -u <AGENT_USER> -f /opt/cicd-agent/current/dist/src/agent/main.js >/dev/null; do sleep 2; done
tail -n 5 /opt/cicd-agent/logs/agent.log                  # "agent stopped"
sudo -u <AGENT_USER> /opt/cicd-agent/bin/start-agent.sh   # restart
```

`pkill` matches only the agent user's Node.js process running the agent entry point. Idle, the agent exits within
seconds. With a script running, it waits for it: at most its timeout plus kill grace, 310 s here.

**Optional, PM2.** Use PM2 only if the server already has a **root** PM2 daemon that is itself supervised. The agent
then runs as `<AGENT_USER>` through `uid`/`gid` (`infra/agent/pm2.ecosystem.example.cjs`, copied to
`/opt/cicd-agent/config/` with the stage 6 environment variables in `env`).

| Action | Command |
|---|---|
| Start | `pm2 start /opt/cicd-agent/config/pm2.ecosystem.config.cjs` |
| Stop | `pm2 stop cicd-agent` |
| Remove | `pm2 delete cicd-agent` |

Use only the name `cicd-agent`. **Never** `pm2 save`: it would rewrite that daemon's saved list. **Never** `restart all`,
`kill` or `update`. Direct mode is preferred for this test.

## 10. Remove (rollback at any stage)

Server, as root:

```bash
pkill -TERM -u <AGENT_USER> -f /opt/cicd-agent/current/dist/src/agent/main.js || true
while pgrep -u <AGENT_USER> >/dev/null; do sleep 2; done
tar -czf ~/cicd-agent-e5/evidence.tar.gz -C /opt/cicd-agent logs data config/agent.json config/catalog.json
shred -u /opt/cicd-agent/config/agent.env 2>/dev/null || rm -f /opt/cicd-agent/config/agent.env
rm -rf /opt/cicd-agent
userdel <AGENT_USER>; getent group <AGENT_USER> && groupdel <AGENT_USER>
rm -f /tmp/cicd-agent-*.tar.gz /tmp/node-v*-linux-*.tar.gz
```

The evidence archive excludes `agent.env`, which may hold mode-D credentials.

Then repeat the stage 5 snapshot and compare it with the baseline:
- no `<AGENT_USER>` process;
- no difference in listening sockets, containers or application checks;
- `getent passwd <AGENT_USER>` prints nothing.

**Mode cleanup:**
- A: nothing on the server.
- B: disassociate the instance profile (AWS, authorization).
- C: delete the key with the directory, and revoke the certificate at the owner's CA.
- D: the credentials expire within an hour.

AWS cleanup follows [11](11-agent-transport-e5.md) §7.

**Rollback during installation:** stop at the failing stage and run this section. Nothing outside `/opt/cicd-agent`,
the user and `/tmp` was changed.

# Server agent: installation and operation (architecture-change-04, E3)

**Status: prepared, not installed on any server.** Installation, identity and AWS resources are E4–E5 and need the
owner's authorization.

The agent is one small, long-running Node.js 22 process per server and platform stage. It needs **no systemd unit,
no PM2 and no other supervisor**. It behaves the same run directly or under an existing supervisor. It receives
commands from its SQS queue, validates them, runs catalog scripts and reports results. Locks, fencing and
reconciliation stay in the central Executor.

## Layout

| Path | Owner and mode | Content |
|---|---|---|
| `/opt/cicd-agent/package.json`, `node_modules/` (production only), `dist/`, `schemas/` | root, read-only | The build: `npm ci --omit=dev` and `npm run build` of `executor/`, plus a copy of the repository's `schemas/` |
| `/opt/cicd-agent/config/agent.json`, `catalog.json` | root, 0644 | From `agent.example.json` and `catalog.example.json` |
| `/opt/cicd-agent/data/` | `cicd-agent`, 0700 | Journal, target state, outbox, captured output (`stateDir`) |
| `/opt/cicd-agent/logs/` | `cicd-agent`, 0750 | Operational logs (JSON lines), when run directly or under PM2 |
| `/opt/cicd-agent/node/` (optional) | root, read-only | A Node.js 22 used only by the agent, if the server's default `node` is another version |

`CICD_AGENT_HOME` (default `/opt/cicd-agent`) locates `config/`; `CICD_AGENT_CONFIG` and `CICD_AGENT_CATALOG`
override the two files. Nothing outside these directories is written.

## Minimum requirements and permissions

- **Operating system.** Linux and Node.js 22. Nothing else is installed or changed system-wide.
- **User.** A dedicated `cicd-agent` system user with no login shell. It is **not** in the `docker` group and has
  **no** general sudo.
- **Scripts.** Each catalog entry runs one root-owned script, in one of two ways:
  - `"runAs": "<deploy user>"` runs it through `sudo -n -u <deploy user>`. This needs exactly one rule per script
    (`sudoers.example`). The deploy user holds the Docker or PM2 access its application needs.
  - `"runAs": "self"` runs it as `cicd-agent` itself, without sudo, for servers where no sudo rule is wanted. The
    script then has only the agent user's permissions and can write the agent's own `data/`, so use it only for
    scripts that need no other privileges.
- **AWS credentials.** Temporary credentials only, never static keys. The agent's own AWS resources and role come from
  one `infra/sam/agent-stack.yaml` stack per agent (see "AWS identity" below). Per-target script roles are assumed per
  run (AP-2).
- **Network.** Outbound HTTPS to SQS, S3 and STS in the platform region. No inbound port: the agent listens on nothing.

## AWS identity (agent-stack.yaml `IdentityMode`)

| Mode | Server | What the agent uses |
|---|---|---|
| `ec2-instance-profile` | EC2 instance **without** an instance profile | Attach the stack's `InstanceProfileName`; the default credential chain picks it up |
| `ec2-instance-role` | EC2 instance that **already has** an instance profile (it is never replaced, so its applications keep their permissions) | The agent assumes the agent role from the instance role (below) |
| `roles-anywhere` | On premises | One X.509 certificate per server, CN = `agentId`, private key readable by `cicd-agent` only; `aws_signing_helper` as `credential_process` (below) |

`/opt/cicd-agent/.aws/config` (owned by root, readable by `cicd-agent`), with `AWS_PROFILE=cicd-agent` and
`AWS_CONFIG_FILE` pointing to it in the agent's environment:

```ini
# ec2-instance-role
[profile cicd-agent]
role_arn = <AGENT_ROLE_ARN>
credential_source = Ec2InstanceMetadata
region = <AWS_REGION>

# roles-anywhere
[profile cicd-agent]
credential_process = /opt/cicd-agent/bin/aws_signing_helper credential-process --certificate /opt/cicd-agent/pki/agent.crt --private-key /opt/cicd-agent/pki/agent.key --trust-anchor-arn <TRUST_ANCHOR_ARN> --profile-arn <ROLES_ANYWHERE_PROFILE_ARN> --role-arn <AGENT_ROLE_ARN>
region = <AWS_REGION>
```

On EC2, instance credentials are reachable by **every** process on the host, including the applications. In
`ec2-instance-role` mode any of them can also assume the agent role. Roles Anywhere, with a key only `cicd-agent`
can read, isolates the agent's identity better. IMDSv2 with a hop limit of 1 keeps containers away from instance
credentials. Changing that is a server setting, decided in E5.

## Running it

Directly, for a trial or behind any process manager:

```bash
sudo -u cicd-agent env CICD_AGENT_HOME=/opt/cicd-agent \
  /usr/bin/node /opt/cicd-agent/dist/src/agent/main.js >> /opt/cicd-agent/logs/agent.log 2>&1
```

A bare process is not restarted after a crash or a reboot. For continuous operation use a supervisor the server
already has:

- **An existing PM2 daemon that is itself supervised** (survives reboots): `pm2.ecosystem.example.cjs`.
  - Run the agent as `cicd-agent`. Use `uid`/`gid` when that daemon runs as root.
  - Running it inside a deploy user's PM2 daemon makes it run as that user: avoid.
- **systemd**: the optional reference unit `optional/cicd-agent.service`.

| Task | Direct | PM2 |
|---|---|---|
| Status | `pgrep -u cicd-agent -f agent/main.js` | `pm2 describe cicd-agent` |
| Logs | `logs/agent.log` | `pm2 logs cicd-agent`, or `logs/agent.*.log` |
| Stop or restart | `kill -TERM <pid>`, then start again | `pm2 stop|restart cicd-agent` |
| Update | Replace `dist/`, `node_modules/`, `schemas/`, then restart the agent | Same, then `pm2 restart cicd-agent` |

- **Liveness.** The central Executor also sees the agent: a heartbeat every `heartbeatSeconds`.
- **Updates and restarts.** They touch only the agent: no Docker, PM2 application or other service is restarted.
- **Log volume.** Logs are a few lines per deploy plus backed-off poll errors during outages. Rotate them with the
  server's `logrotate` (`copytruncate`) or PM2's own log settings.

## Stop and restart

`SIGTERM`, `SIGINT` or the IPC message `shutdown` (PM2 on Windows) trigger the same steps:

1. The agent stops receiving at once.
2. It returns every command still waiting for a slot to the queue (it was never journaled).
3. It starts nothing new.
4. It lets running scripts finish within `shutdownGraceSeconds` (default: the longest catalog timeout plus its kill
   grace).
5. It stops what is still running and reports it `LOST`, so the Executor keeps the target held.
6. It flushes its events and exits 0. With nothing running it exits at once.

A supervisor's kill timeout must exceed `shutdownGraceSeconds`, plus the longest `killGraceSeconds`, plus 60 s
(PM2 `kill_timeout`, systemd `TimeoutStopSec`).

An abrupt end (SIGKILL, crash, OOM) is safe. On its next start, before receiving anything, the agent:

- stops any script of the dead process that is still running, identified by pid **and** start time, so a recycled pid
  is never touched;
- reports it `LOST`;
- never runs it again.

Commands that waited in SQS are then validated as usual: identity, fencing, `notAfter`. Expired ones never run.

## What the agent guarantees, and what each deploy script must guarantee

| The agent guarantees | Every deploy script must |
|---|---|
| It never runs `docker`, `pm2` or any host command itself: only catalog scripts, by exact path, with the AC-03 argument vector | Act only on its own application (its container names, Compose project, PM2 app name, ports and directories) |
| Once a script exits on its own, nothing it leaves behind is ever signaled, so an application the script handed over is never stopped by the agent | Hand the application to its supervisor and end: `docker compose up -d` / `docker run -d`, `pm2 reload <app>` on a PM2 daemon with its own startup unit, `systemctl restart <app>` |
| Stopping, restarting or crashing the agent never stops Docker containers or PM2 applications (they are not its processes; under PM2 use `treekill: false`) | Never start a long-lived process itself: no `nohup app &`, and never a PM2 daemon on first use. The script refuses to deploy if the application's PM2 daemon is not running under its own supervisor |
| A script is signaled only on its timeout, on a stop after the grace, or after an abrupt agent end. The signal goes to the script's own process group, never to anything else | Exit promptly on `SIGTERM` (a script running as another user can be stopped only through sudo's relay of `SIGTERM`) |
| A run ends when the script exits. Leftover processes in its group or on its output are logged as a warning, never killed | Never run host-wide operations: `docker system prune`, `docker image prune -a`, `pm2 kill`, `pm2 delete all`, `pm2 update` |
| At most `maxParallel` scripts at once and one per target; named resources are exclusive | Declare in the catalog every resource it shares with other targets (below) |

The agent cannot inspect what a script does. Isolation of applications therefore depends on the scripts following the
right-hand column. The reference `deploy-container.sh` prunes only its own repository's images.

## Concurrency on a shared server

`maxParallel` (default 2) bounds concurrent scripts. There is no server-wide lock: two deploys run together unless they
name the same resource in the catalog.

| Shared thing | Resource (capacity 1) |
|---|---|
| One PM2 daemon (`pm2 save` writes one dump file) | `pm2-shared` on every target deployed through it |
| Migrations on the same database server | `db-migrations` |
| A port, a directory, or a container or Compose project name used by more than one target | `port-8080`, `shared-uploads` |

Pulls of different images and `docker compose up -d` of independent projects run in parallel. Their network, disk and
CPU use belongs to Docker and the scripts, not to the agent, and is bounded by `maxParallel`.

## Files here

| File | Purpose |
|---|---|
| `agent.example.json`, `catalog.example.json` | Configuration and catalog with placeholders |
| `sudoers.example` | One rule per script that runs as a deploy user |
| `pm2.ecosystem.example.cjs` | Running under an existing, supervised PM2 daemon |
| `optional/cicd-agent.service` | Optional systemd reference unit |

<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §3 (B1), §6; D-4; tools/gate-b/run-executor.ps1 -->
# 05. Run the Executor locally under Node 22

**Answer first.** You use a portable Node 22 unzipped inside `executor/.local/node22/`: no
installer, no PATH change, no system-wide Node change. You build with it, fill an env file,
set up an AWS profile that assumes the Executor role, check with `-DryRun`, then start. Stop with
Ctrl+C. The Executor under Node 22 has not been observed before; local evidence in B0 was on
Node 20.19.5.

Run from the repository root unless a step says otherwise (PowerShell 5.1).

## 1. Portable Node 22

1. Open `https://nodejs.org/dist/latest-v22.x/` and download the Windows x64 zip `node-v22.<MINOR>.<PATCH>-win-x64.zip` of the current 22.x LTS, plus `SHASUMS256.txt` from the same folder. Save both under `$env:USERPROFILE\Downloads`.
2. Verify the checksum:

   ```powershell
   $zip = "$env:USERPROFILE\Downloads\node-v22.<MINOR>.<PATCH>-win-x64.zip"
   (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
   Select-String -Path "$env:USERPROFILE\Downloads\SHASUMS256.txt" -Pattern "node-v22.<MINOR>.<PATCH>-win-x64.zip"
   ```

   Expected: the hash printed by the first command equals the hash at the start of the line printed by the second.

   **Stop if** they differ. Delete the download and fetch it again. Do not unzip.

3. Optional but better: verify the signature of `SHASUMS256.txt` too. Download `SHASUMS256.txt.sig` (or `.asc`), import the Node.js release keys (listed in the `nodejs/release-keys` repository), then `gpg --verify SHASUMS256.txt.sig SHASUMS256.txt`. Expected: `Good signature`. Skip if you have no `gpg`; the checksum above still catches a corrupted download but not a tampered checksum file.
4. Unzip into the project-local folder:

   ```powershell
   New-Item -ItemType Directory -Force executor/.local | Out-Null
   Expand-Archive -Path $zip -DestinationPath executor/.local/node-extract
   Move-Item executor/.local/node-extract/node-v22.<MINOR>.<PATCH>-win-x64 executor/.local/node22
   Remove-Item executor/.local/node-extract
   & executor/.local/node22/node.exe --version
   ```

   Expected: `v22.<MINOR>.<PATCH>`.

   **Stop if** the version does not start with `v22.`.

## 2. Install and build with that Node (nothing persists)

The folder is put first on `PATH` for this one PowerShell process only and restored in `finally`. Use `npm.cmd` explicitly so a script-execution policy cannot block `npm.ps1`.

```powershell
Set-Location executor
$node22 = (Resolve-Path .local\node22).Path
$savedPath = $env:Path
try {
  $env:Path = "$node22;$env:Path"
  node --version
  npm.cmd ci
  npm.cmd run build
} finally {
  $env:Path = $savedPath
}
Set-Location ..
```

Expected: `v22.x`, a successful `npm ci` (no `EBADENGINE` warning), a silent `tsc` build, and the file `executor/dist/src/main/index.js`.

**Stop if** `npm ci` fails or `node --version` is not `v22`. Share the output (do not retry with another Node).

You can run the offline definitions check the same way: `npm.cmd run definitions:check -- --root .local/definitions` inside the same `try` block (see [04](04-definitions-and-target.md)).

## 3. AWS profile that assumes the Executor role

No static key goes into any env file. Edit `~/.aws/config` (`%USERPROFILE%\.aws\config`) and add:

```ini
[profile <EXECUTOR_PROFILE_NAME>]
role_arn = <EXECUTOR_ROLE_ARN>
source_profile = <AWS_PROFILE_ADMIN>
region = <AWS_REGION>
```

- `<EXECUTOR_ROLE_ARN>` is the stack output `ExecutorRoleArn`.
- `source_profile` must run as the principal you gave the stack as `ExecutorTrustedPrincipalArn`. Prefer an SSO source profile and sign in first: `aws sso login --profile <AWS_PROFILE_ADMIN>`. An expired SSO session stops the Executor from refreshing its role session.

Check the assumption (a read-only identity call):

```powershell
aws sts get-caller-identity --profile <EXECUTOR_PROFILE_NAME>
```

Expected: an `Arn` of the form `arn:aws:sts::<AWS_ACCOUNT_ID>:assumed-role/<EXECUTOR_ROLE_NAME>/<SESSION>`.

**Stop if** it fails with `AccessDenied`. The source principal is not the stack's trusted principal; share the error text.

### Unset leftover static credentials in your shell

The AWS SDK credential chain gives **environment variables priority over the profile**. The launcher prints `run-executor: warning: inherited AWS_ACCESS_KEY_ID is ignored and removed from the Executor environment (static keys are not allowed).` and strips them for the Executor process, but your other commands in the same shell (the `aws` CLI checks, `executor-ssh-probe`) would still use them instead of the profile. Check and clear them:

```powershell
Get-ChildItem Env: | Where-Object Name -like 'AWS_*' | Select-Object Name
Remove-Item Env:AWS_ACCESS_KEY_ID, Env:AWS_SECRET_ACCESS_KEY, Env:AWS_SESSION_TOKEN -ErrorAction SilentlyContinue
```

Expected: no `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or `AWS_SESSION_TOKEN` listed afterwards (`AWS_PROFILE`, `AWS_REGION` are fine).

## 4. The env file

```powershell
Copy-Item docs/gate-b/executor/executor.env.example executor/.local/executor.env
```

Edit `executor/.local/executor.env` (ignored by Git). Format: `KEY=VALUE`, one per line, no expansion.

| Key | Value |
|---|---|
| `AWS_PROFILE` | `<EXECUTOR_PROFILE_NAME>`. **Required**: the launcher refuses to run when it is missing or empty |
| `AWS_REGION` | `<AWS_REGION>` |
| `CICD_QUEUE_URL`, `CICD_TABLE_NAME` | Stack outputs `DeployQueueUrl`, `ExecutionsTableName` |
| `CICD_EXECUTOR_PRINCIPAL_REF`, `CICD_SCHEDULER_PRINCIPAL_REF`, `CICD_OPERATOR_PRINCIPAL_REF` | Logical `<PLACEHOLDER>` refs whose secrets hold the role ids ([02](02-secrets.md)) |
| `CICD_PLATFORM_SLACK_CHANNEL_REF`, `CICD_PLATFORM_SLACK_TOKEN_REF` | Logical refs for the platform notifications |
| `CICD_SECRET_ID_PREFIX` | The stack's `SecretIdPrefix`, exactly (e.g. `cicd-poc/dev/`) |
| `CICD_LOGS_URL_TEMPLATE` (contains `{executionId}`), `CICD_RUNBOOK_URL` | Any HTTPS URLs you control (links shown in Slack) |
| `CICD_DEFINITIONS_ROOT` | **Absolute** path of `executor\.local\definitions` ([04](04-definitions-and-target.md)) |
| `CICD_HEALTHCHECK_PATH` | Recommended on Windows: an absolute path such as `<REPO_ROOT>\executor\.local\cicd-executor.health` (the default `/tmp/...` may not be writable) |
| `CICD_DYNAMODB_ENDPOINT` | **Leave unset.** It points the Executor at a local emulator; the launcher refuses it |

**Stop if** any value you entered is a real secret value, a role id or an ARN where a logical ref is expected.

## 5. Dry run

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/gate-b/run-executor.ps1 -DryRun
```

Optional launcher flags: `-EnvFile`, `-NodePath`, `-ExecutorDir` (defaults are under `executor/.local/`), `-AllowLocalEndpoint` (do not use against AWS).

Expected, one per line: `run-executor (dry run): nothing is started`, `node: <path> (v22.x)`, `cwd: <executor dir>`, `command: <path> dist/src/main/index.js`, `env file: <path>`, `env (values redacted):` followed by `  KEY=<set>` or `  KEY=<empty>` for every key. Nothing is started.

**Stop if** it prints a line starting `run-executor:` (exit code 2). Examples: `run-executor: refusing to run: Node major 22 is required, found '<version>' at <path>`; `run-executor: refusing to run: AWS_PROFILE is missing or empty in the env file (...)`; `run-executor: refusing to run: AWS_ACCESS_KEY_ID is in the env file; static AWS keys are not allowed (...)`; `run-executor: refusing to run: CICD_DYNAMODB_ENDPOINT is set ...`; `run-executor: env file not found: <path> (...)`; `run-executor: <path>/dist/src/main/index.js is missing. Run 'npm ci && npm run build' ...`. The message names the cause. Fix and repeat.

## 6. Start

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/gate-b/run-executor.ps1
```

Expected, in the console (JSON lines): a line with the message `executor started` and `"deployments":<N>` with N equal to your number of definitions, then a heartbeat roughly every minute. There is no separate "definitions validated" line: startup validation succeeded when `executor started` appears. A refusal prints `executor refused to start: <message>` and exits 1.

Do not pipe the launcher through `tee` or another process: it can interfere with Ctrl+C delivery to Node and the ordered stop. Keep the console scrollback if you need a record, and copy the relevant lines (sanitized) afterwards.

**Stop if** the process exits with a refusal. Use the troubleshooting list below.

## 7. Stop (ordered shutdown)

In the Executor console press **Ctrl+C** once (SIGINT). On Windows there is no SIGTERM to a PowerShell launcher, so Ctrl+C in that console is the way to stop it (on POSIX, Ctrl+C or SIGTERM to the launcher process both reach Node). Expected: a line `executor stopping`, the consumers stop taking new messages, in-flight handlers finish within their bound, logs flush, and the process exits with code 0. Closing the window or killing the process instead leaves any in-flight message on the queue for redelivery (safe, but not the ordered stop).

## 8. Metrics and liveness in the workstation run

The Executor writes its metrics in CloudWatch EMF format to **stdout**. In this run stdout is **not shipped to CloudWatch Logs**, so the three EMF-based alarms have no data:

| Alarm | Effect during B1 |
|---|---|
| `cicd-<STAGE>-executor-heartbeat-missing` | No `ExecutorHeartbeat` datapoints: it treats missing data as breaching, so it may show `ALARM` or `INSUFFICIENT_DATA` even while the Executor runs. This is expected, not a failure |
| `cicd-<STAGE>-rejected-unauthorized-sender` | No data; stays `OK`/`INSUFFICIENT_DATA` even if a request is rejected |
| `cicd-<STAGE>-executions-past-deadline` | No data |

Observe liveness from the console log (heartbeat lines) and the healthcheck file's modification time (`CICD_HEALTHCHECK_PATH`) instead. The SQS-based alarms (DLQ not empty, oldest message age) do work, because AWS publishes those metrics itself.

## 9. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Could not load credentials` / `CredentialsProviderError` | Profile missing, SSO session expired (`aws sso login`), or the source principal cannot assume the role. Test with `aws sts get-caller-identity --profile <EXECUTOR_PROFILE_NAME>` |
| Runs as the wrong identity | Static `AWS_ACCESS_KEY_ID` etc. in the parent shell win over the profile for every command except the launcher (which strips them with a warning). Clear them (section 3) |
| `Region is missing` / wrong endpoint | `AWS_REGION` empty or different from the stack region |
| `executor refused to start: ... <PLACEHOLDER> ...` naming a logical ref | The secret for that ref does not exist or is not readable under `CICD_SECRET_ID_PREFIX`. Create it ([02](02-secrets.md)); check the prefix equals the stack's `SecretIdPrefix` and ends with `/` |
| `AccessDeniedException` on a secret | The secret is outside the prefix, or the prefix differs from the stack parameter |
| `invalid Executor configuration: ...` | A required variable is empty or a ref is not in `<UPPER_SNAKE>` form; all problems are listed at once |
| `executor refused to start: N definition file(s) cannot be loaded` or `... definition validation issue(s)`, followed by one line per file with the reason | The Executor refuses to start on any unparsable or invalid definition file, the duplicate of a `deploymentId`, a file without `deploymentId` (other than the target registry), or any entry under `deployment-definitions/` that is not a regular directory or a lowercase `.yaml`/`.yml` file (README, `.bak`, `.YAML`, symbolic links). Each line names the file (relative to the definitions root) and the reason, never its content. Fix that file and start again; run `definitions:check` as the preflight |
| Definitions refused at startup for a value `definitions:check` accepted (unsafe value, migration command with line breaks) | Fix the definition; `definitions:check` does not catch every case (limitation K-3). The startup validation is the authority |
| `refusing to run: Node major 22 is required` | Wrong binary; check `executor/.local/node22/node.exe --version` |
| `RequestTimeTooSkewed` / `SignatureDoesNotMatch` | System clock off by more than about five minutes. Resync Windows time |
| Timeouts or connection errors behind a proxy | The AWS SDK does not honor `HTTPS_PROXY` by itself; Node 22.21 and later documents `NODE_USE_ENV_PROXY=1` (verify in the Node docs for your version). The Executor has no proxy code. Put the variables in `executor.env` if you need them |
| `heartbeat tick failed: healthcheck write` | The healthcheck path is not writable; set `CICD_HEALTHCHECK_PATH` |
| `ResourceNotFoundException` for the table | Wrong `CICD_TABLE_NAME` or region |
| Nothing consumed | Wrong `CICD_QUEUE_URL`, or the Executor role is not the one in the queue policy |

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

## 3. Dedicated Executor principal (SR-3)

**Answer first.** The workstation-hosted Executor does NOT run as you or as an administrator. It runs as a dedicated IAM user, `<EXECUTOR_WORKSTATION_USER>` (recommended name `cicd-poc-dev-executor-local`), that has no console password, no groups, no managed policies and ONE inline policy: `sts:AssumeRole` on `<EXECUTOR_ROLE_ARN>` (stack output `ExecutorRoleArn`). That user's ARN is the value of the stack parameter `ExecutorTrustedPrincipalArn`. Its single access key lives only in an isolated credentials file under `executor/.local/aws/`, and the launcher refuses to start unless the env file points the AWS SDK at those isolated files.

Everything below is executed by **you (the owner)**, with an administrator profile `<AWS_PROFILE_ADMIN>`, and only after you decide to do B1. Claude does not run any of it. No command prints the secret access key.

### 3.1 Order of operations (why it is split)

IAM rejects a trust-policy principal that does not exist, so the user must exist **before** `sam deploy`. The inline policy needs `ExecutorRoleArn`, which exists only **after** the deploy. Therefore:

1. Create the user (no policy, no key).
2. Deploy the stack ([01](01-aws-sam.md)) with `ExecutorTrustedPrincipalArn` = the user ARN.
3. Attach the inline policy with the real role ARN.
4. Create the access key straight into the isolated credentials file.
5. Verify read-only, then verify the assumption.

Until step 3 the user can do nothing at all; until step 4 it has no credential.

### 3.2 Step 1: create the user (before the deploy)

```powershell
$u = "<EXECUTOR_WORKSTATION_USER>"
aws iam create-user --user-name $u --tags Key=Project,Value=ONECGIAR-CICD-Platform --profile <AWS_PROFILE_ADMIN>
aws iam get-user --user-name $u --query "User.Arn" --output text --profile <AWS_PROFILE_ADMIN>
```

Expected: a user JSON, then `arn:aws:iam::<AWS_ACCOUNT_ID>:user/<EXECUTOR_WORKSTATION_USER>`. Use that value as `ExecutorTrustedPrincipalArn` in your local `samconfig.toml` ([01](01-aws-sam.md)) and run the deploy.

**Stop if** `create-user` fails with `EntityAlreadyExists` and you did not create the user: inspect it (`get-user`, `list-attached-user-policies`, `list-user-policies`, `list-access-keys`) before reusing it.

### 3.3 Step 3: attach the minimum inline policy (after the deploy)

Read `ExecutorRoleArn` from the stack outputs ([01](01-aws-sam.md)). Write the policy to a file (PowerShell 5.1 mangles inline JSON passed to native programs, and the file is UTF-8 without BOM):

```powershell
New-Item -ItemType Directory -Force executor/.local/aws | Out-Null
$policy = '{"Version":"2012-10-17","Statement":[{"Sid":"AssumeExecutorRoleOnly","Effect":"Allow","Action":"sts:AssumeRole","Resource":"<EXECUTOR_ROLE_ARN>"}]}'
[System.IO.File]::WriteAllText((Join-Path $PWD "executor/.local/aws/executor-user-policy.json"), $policy, (New-Object System.Text.UTF8Encoding $false))
aws iam put-user-policy --user-name $u --policy-name AssumeExecutorRoleOnly --policy-document file://executor/.local/aws/executor-user-policy.json --profile <AWS_PROFILE_ADMIN>
```

The exact policy (this is the whole permission set of the user):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeExecutorRoleOnly",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "<EXECUTOR_ROLE_ARN>"
    }
  ]
}
```

### 3.4 Step 4: create the access key into the isolated file (never echoed)

The key is captured in a variable, written straight into the credentials file, and the variable is cleared. The file is created empty and locked to your Windows user **before** the secret is written, so it is never readable by others, not even briefly. Nothing is printed.

```powershell
$credFile = Join-Path $PWD "executor/.local/aws/credentials"
[System.IO.File]::WriteAllText($credFile, "", (New-Object System.Text.UTF8Encoding $false))
icacls $credFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
$k = (aws iam create-access-key --user-name $u --profile <AWS_PROFILE_ADMIN> --output json | Out-String | ConvertFrom-Json).AccessKey
$text = "[cicd-executor-source]`r`naws_access_key_id = $($k.AccessKeyId)`r`naws_secret_access_key = $($k.SecretAccessKey)`r`n"
[System.IO.File]::WriteAllText($credFile, $text, (New-Object System.Text.UTF8Encoding $false))
$k = $null; $text = $null
icacls $credFile
```

Expected: no key material on the console; `icacls` lists only your user with `(R,W)` (no `Everyone`, `Users` or `Authenticated Users`). Do not run `create-access-key` without the capture: the secret is shown only once.

**Stop if** `icacls` shows any other principal, or `create-access-key` fails with `LimitExceeded` (the user already has two keys: `list-access-keys`, then delete the one you do not recognize).

### 3.5 The isolated AWS config

Create `executor/.local/aws/config` (ignored by Git through `.local/`):

```ini
[profile cicd-executor]
role_arn = <EXECUTOR_ROLE_ARN>
source_profile = cicd-executor-source
region = us-east-1
role_session_name = cicd-executor-workstation
duration_seconds = 3600

[profile cicd-executor-source]
region = us-east-1
```

`[cicd-executor-source]` holds the keys in `executor/.local/aws/credentials` (step 4); the config only names the region for that source profile. `duration_seconds = 3600` must not exceed the ExecutorRole's maximum session duration (the SDK refreshes the role session before it expires).

In `executor/.local/executor.env` set (**absolute** paths):

```
AWS_CONFIG_FILE=<REPO_ROOT>\executor\.local\aws\config
AWS_SHARED_CREDENTIALS_FILE=<REPO_ROOT>\executor\.local\aws\credentials
AWS_PROFILE=cicd-executor
```

The launcher enforces an allow-list, not just "not the default file". It refuses (exit 2, naming the rule and never a value) unless all of these hold:

- Both paths are **absolute** (a relative path would be re-resolved after the launcher changes directory) and contain no `..` segment. The launcher passes the **resolved** absolute path to the Executor.
- Both files exist, are **under `<executor-dir>\.local\aws\`**, and are not the default `~/.aws/config` / `~/.aws/credentials`.
- No path component from `.local` down is a symbolic link, junction or other reparse point, and each file has **exactly one hard link** (so a link cannot make an isolated name point at a file that holds other credentials). Method: PowerShell checks `LinkType` and the `ReparsePoint` attribute per component and counts names with `fsutil hardlink list` (ships with Windows, no elevation needed); Bash checks `-L` per component (Git Bash reports junctions as links) and `stat -c %h`.
- The **logical** path as written in the env file must start with `<executor-dir>/.local/aws/` (a physical path reached through a link is not accepted), and neither `<executor-dir>/.local` nor `<executor-dir>/.local/aws` may be a link.
- No key appears twice in the env file (a later empty `AWS_PROFILE=` could otherwise override the validated one and send the SDK to `[default]`). The launcher exports the validated `AWS_PROFILE` and the resolved file paths explicitly.
- The config has `[profile <AWS_PROFILE>]` with `role_arn` and `source_profile`, and the **whole** config contains none of `credential_process`, `credential_source`, `web_identity_token_file`, any `sso_*` key or an `sso-session` section.
- The `role_arn` of that profile equals the env-file key `CICD_EXECUTOR_ROLE_ARN` **exactly** (set it to the stack output `ExecutorRoleArn`; it must look like `arn:aws:iam::<AWS_ACCOUNT_ID>:role/<EXECUTOR_ROLE_NAME>`). Otherwise a config could name a more powerful role and still pass. The launcher uses this value only for the check and does **not** pass it to the Executor: it is not a secret, but the Executor's configuration surface stays unchanged (the role it assumes comes from the profile alone).
- The credentials file may contain **only** the keys `aws_access_key_id` and `aws_secret_access_key` (any other key, such as `credential_process`, `role_arn`, `aws_session_token` or `sso_*`, is refused, naming the key and never a value), and it has no section named like `AWS_PROFILE`, so the role profile can never carry static keys itself. The parse is a plain INI read; nothing in the files is evaluated.
- The child process never receives `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN` or `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` (the launcher removes them and warns when they are inherited), and always gets `AWS_EC2_METADATA_DISABLED=true`.

### 3.6 Step 5: verify (read-only)

The first four commands use your administrator profile and only read.

```powershell
aws iam list-attached-user-policies --user-name $u --profile <AWS_PROFILE_ADMIN>
aws iam list-groups-for-user --user-name $u --profile <AWS_PROFILE_ADMIN>
aws iam list-user-policies --user-name $u --profile <AWS_PROFILE_ADMIN>
aws iam get-user-policy --user-name $u --policy-name AssumeExecutorRoleOnly --profile <AWS_PROFILE_ADMIN>
```

Expected: `AttachedPolicies` empty; `Groups` empty; `PolicyNames` exactly `["AssumeExecutorRoleOnly"]`; `get-user-policy` shows only `sts:AssumeRole` on `<EXECUTOR_ROLE_ARN>`.

Simulate the identity policy (read-only; it evaluates only the user's policies, not the role trust policy):

```powershell
$src = "arn:aws:iam::<AWS_ACCOUNT_ID>:user/<EXECUTOR_WORKSTATION_USER>"
aws iam simulate-principal-policy --policy-source-arn $src --action-names sts:AssumeRole --resource-arns <EXECUTOR_ROLE_ARN> --query "EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]" --output table --profile <AWS_PROFILE_ADMIN>
aws iam simulate-principal-policy --policy-source-arn $src --action-names sts:AssumeRole --resource-arns arn:aws:iam::<AWS_ACCOUNT_ID>:role/<ANY_OTHER_ROLE_NAME> --query "EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]" --output table --profile <AWS_PROFILE_ADMIN>
aws iam simulate-principal-policy --policy-source-arn $src --action-names secretsmanager:GetSecretValue --resource-arns arn:aws:secretsmanager:<AWS_REGION>:<AWS_ACCOUNT_ID>:secret:<ANY_SECRET_NAME> --query "EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]" --output table --profile <AWS_PROFILE_ADMIN>
aws iam simulate-principal-policy --policy-source-arn $src --action-names sqs:SendMessage --resource-arns <DEPLOY_QUEUE_ARN> --query "EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]" --output table --profile <AWS_PROFILE_ADMIN>
aws iam simulate-principal-policy --policy-source-arn $src --action-names iam:CreateAccessKey iam:ListUsers --resource-arns "*" --query "EvaluationResults[].[EvalActionName,EvalResourceName,EvalDecision]" --output table --profile <AWS_PROFILE_ADMIN>
```

Expected: `allowed` only for the first command (`sts:AssumeRole` on `<EXECUTOR_ROLE_ARN>`); `implicitDeny` for every other row.

**Stop if** any other row says `allowed`: an extra policy or group grants more than intended; find it and remove it before starting the Executor.

Then verify the assumption with the isolated files (set for this PowerShell process only, then cleared):

```powershell
$env:AWS_CONFIG_FILE = (Resolve-Path executor/.local/aws/config).Path
$env:AWS_SHARED_CREDENTIALS_FILE = (Resolve-Path executor/.local/aws/credentials).Path
aws sts get-caller-identity --profile cicd-executor
Remove-Item Env:AWS_CONFIG_FILE, Env:AWS_SHARED_CREDENTIALS_FILE
```

Expected: an `Arn` of the form `arn:aws:sts::<AWS_ACCOUNT_ID>:assumed-role/<EXECUTOR_ROLE_NAME>/cicd-executor-workstation`.

In the other Gate B guides, `<EXECUTOR_PROFILE_NAME>` means this profile, `cicd-executor`: any command that uses it (for example the negative checks in [07](07-verification.md) or the SSH probe in [06](06-target-validation.md)) must run with `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` set to the isolated files exactly as above, because the profile does not exist in `~/.aws/config`.

**Stop if** it fails with `AccessDenied`: the user ARN is not the stack's `ExecutorTrustedPrincipalArn`, or the inline policy names a different role ARN. Share the error text.

### 3.7 How the AWS SDK for JavaScript v3 uses these files

- `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` are the documented environment variables that relocate the shared config and credentials files; the SDK v3 honors them when loading profiles (AWS SDKs and Tools Reference Guide, "Shared config and credentials files"; the SDK for JavaScript v3 Developer Guide, "Setting credentials in Node.js"). Confirmed in the installed code: `@smithy/core` (`getConfigFilepath`, `getCredentialsFilepath`) reads exactly these two variables.
- A profile with `role_arn` + `source_profile` is resolved by the `fromIni` provider inside the default credential provider chain (`@aws-sdk/credential-provider-ini`), which calls `sts:AssumeRole` with the source keys, `role_session_name` and `duration_seconds`.
- The default chain treats role credentials as expiring and re-resolves them before they expire (the chain checks the `expiration` of the cached credentials), so a long-running Executor keeps working without restarting; it needs the source key to stay valid for the whole run.

### 3.8 Residual risk (read this)

- **Isolation is at the configuration level, not at the operating-system level.** The Executor process runs as your Windows user, so that same user can still read your `~/.aws` files and every other file you can. The launcher's allow-list (3.5) stops the Executor from silently picking up administrator credentials through the default files, a relative path, a link, a credential helper or an alternative credential source; it does not stop code running as you from reading anything you can read, and it does not stop you from editing the launcher or the files. It is a guard against mistakes, not a security boundary. The checks also read the files before the Executor starts: a file replaced between the check and the start is not detected (accepted for a single-owner workstation).
- **The launcher checks prevent accidents, not tampering.** Both launchers refuse links, junctions and hard links on the isolated files (see the rule list in 3.5), but a person or process running as you can still change the files after the check, or copy administrator keys into them. Keep only the dedicated principal's key there.
- **Avoid long-lived plaintext administrator keys on this workstation.** If `<AWS_PROFILE_ADMIN>` is an IAM user with a static key in `~/.aws/credentials`, prefer an SSO profile (`aws sso login`) for it instead.
- **The dedicated key's effective power equals the ExecutorRole's:** the queue, the table and the secrets under the stack's secret prefix, **including the SSH private key**. Treat `executor/.local/aws/credentials` like that key.
- **Delete it after B2** (and whenever the workstation is retired or the file is exposed), see the teardown below. A static key is exactly what a temporary PoC should not leave behind.

### 3.9 Rotation and teardown (after B2)

Rotate at any time by creating a second key, updating the file as in 3.4, verifying, then deleting the old key (`aws iam list-access-keys --user-name $u`, `aws iam delete-access-key --user-name $u --access-key-id <OLD_ACCESS_KEY_ID>`). To retire the principal after B2 (delete the user only after the stack no longer lists it as `ExecutorTrustedPrincipalArn`, or the next deploy that still names it would fail):

```powershell
aws iam delete-access-key --user-name $u --access-key-id <ACCESS_KEY_ID> --profile <AWS_PROFILE_ADMIN>
aws iam delete-user-policy --user-name $u --policy-name AssumeExecutorRoleOnly --profile <AWS_PROFILE_ADMIN>
aws iam delete-user --user-name $u --profile <AWS_PROFILE_ADMIN>
Remove-Item executor/.local/aws/credentials, executor/.local/aws/executor-user-policy.json
```

`<ACCESS_KEY_ID>` comes from `aws iam list-access-keys --user-name $u`. A deleted trust principal makes the role trust show an opaque principal id and stops working: that is the intended end state.

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
| `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` | **Absolute** paths of `executor/.local/aws/config` and `executor/.local/aws/credentials` (section 3). **Required**: the launcher refuses to run when either is missing, does not exist, or is the default `~/.aws` file (SR-3) |
| `AWS_PROFILE` | `cicd-executor` (the profile in the isolated config). **Required**: the launcher refuses to run when it is missing or empty |
| `CICD_EXECUTOR_ROLE_ARN` | Stack output `ExecutorRoleArn`. **Required** launcher guard (section 3.5); not passed to the Executor |
| `AWS_REGION` | `<AWS_REGION>` |
| `CICD_QUEUE_URL`, `CICD_TABLE_NAME` | Stack outputs `DeployQueueUrl`, `ExecutionsTableName` |
| `CICD_REGISTRY_TABLE_NAME` | Stack output `RegistryTableName` (Target Registry, AC-02 V1; available after the owner deploys the R-2 template) |
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

**Stop if** it prints a line starting `run-executor:` (exit code 2). Examples: `run-executor: refusing to run: Node major 22 is required, found '<version>' at <path>`; `run-executor: refusing to run: AWS_PROFILE is missing or empty in the env file (...)`; `run-executor: refusing to run: AWS_CONFIG_FILE is missing or empty in the env file (...)` (same for `AWS_SHARED_CREDENTIALS_FILE`); `run-executor: refusing to run: AWS_CONFIG_FILE points to a file that does not exist: <path>`; `run-executor: refusing to run: AWS_SHARED_CREDENTIALS_FILE points to the default ~/.aws/credentials; use the isolated file ...`; `run-executor: refusing to run: AWS_ACCESS_KEY_ID is in the env file; static AWS keys are not allowed (...)`; `run-executor: refusing to run: CICD_DYNAMODB_ENDPOINT is set ...`; `run-executor: env file not found: <path> (...)`; `run-executor: <path>/dist/src/main/index.js is missing. Run 'npm ci && npm run build' ...`. The message names the cause. Fix and repeat.

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
| `Could not load credentials` / `CredentialsProviderError` | Profile missing, SSO session expired (`aws sso login`), or the source principal cannot assume the role. Test with section 3.6 (`aws sts get-caller-identity --profile cicd-executor` with the isolated files) |
| Runs as the wrong identity | Static `AWS_ACCESS_KEY_ID` etc. in the parent shell win over the profile for every command except the launcher (which strips them with a warning). Clear them (the subsection below section 3) |
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

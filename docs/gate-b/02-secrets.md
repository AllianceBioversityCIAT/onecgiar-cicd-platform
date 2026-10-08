<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §6; design DD-23, DD-25; adapters/secrets-manager-provider -->
# 02. Secrets Manager entries

**Answer first.** The stack creates no secret values. You create each secret with
`aws secretsmanager create-secret --secret-string file://...`, reading the value from a
protected local file, never from the command line. Then you confirm each one exists with
`describe-secret`. The Executor reads secrets only under the prefix you set.

Run from the repository root. Use `--profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>` on every `aws` command below (omitted from the examples for brevity: add them).

## Naming rule

```text
secret id = CICD_SECRET_ID_PREFIX + logical ref name without the angle brackets
```

Example with the prefix `cicd-poc/dev/`: the ref `<EXAMPLE_SLACK_TOKEN_REF>` is the secret `cicd-poc/dev/EXAMPLE_SLACK_TOKEN_REF`.

- `CICD_SECRET_ID_PREFIX` (Executor environment) **must equal** the stack parameter `SecretIdPrefix`. The Executor role can read nothing outside that prefix.
- Application secrets (the application's own runtime secrets) must **never** be stored under the prefix; the Executor never reads them (NFR-01).
- What each ref must hold is in the table of [`examples/definitions/README.md`](examples/definitions/README.md). This document does not duplicate it; it only shows the commands.

## Protect the value files first

Values go through short-lived local files under `executor/.local/` (already ignored by Git). Create the folder and restrict it to your user:

```powershell
New-Item -ItemType Directory -Force executor/.local/secrets-tmp | Out-Null
icacls "executor\.local\secrets-tmp" /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
```

Expected: `Successfully processed 1 files`.

Helper that writes a value **without a BOM and without a trailing newline** (the provider returns the stored string unchanged, so a stray BOM or newline would become part of the value). Paste it once per PowerShell session:

```powershell
function Write-SecretFile([string]$Path, [string]$Value) {
  [System.IO.File]::WriteAllText((Join-Path $PWD $Path), $Value, (New-Object System.Text.UTF8Encoding $false))
}
```

For a secret value you type interactively (never echoed, never in history):

```powershell
$s = Read-Host "Value" -AsSecureString
Write-SecretFile "executor/.local/secrets-tmp/value.txt" ([System.Net.NetworkCredential]::new("", $s).Password)
```

**CLI history hygiene.** Do not put a secret value in a command argument or an environment variable. Only non-sensitive text (names, the file path) appears on the command line. PowerShell history (`(Get-PSReadLineOption).HistorySavePath`) records what you type, so the `Read-Host` form above keeps values out of it.

## Commands per kind

Replace `<PREFIX>` with your `SecretIdPrefix` and `<REF_NAME>` with the ref name without angle brackets.

### 1. Connection identity (JSON)

```powershell
$h = Read-Host "Target host"
$p = Read-Host "SSH port (22)"; if ([string]::IsNullOrWhiteSpace($p)) { $p = "22" }
$u = Read-Host "Deploy user"
Write-SecretFile "executor/.local/secrets-tmp/connection.json" ('{"host":"' + $h + '","port":' + $p + ',"user":"' + $u + '"}')
aws secretsmanager create-secret --name "<PREFIX><REF_NAME>" --secret-string file://executor/.local/secrets-tmp/connection.json
```

Shape: `{host, port?, user}`; port optional, default 22; no credential inside. Expected output: JSON with `ARN`, `Name`, `VersionId`.

### 2. Host key (public key line or lines)

Obtain the key out of band and compare it with `ssh-keyscan` output first (procedure in [06](06-target-validation.md)). Save the public key line(s) into `executor/.local/secrets-tmp/hostkey.txt` (one OpenSSH public key line per host key, e.g. `ssh-ed25519 <BASE64_KEY>`), then:

```powershell
aws secretsmanager create-secret --name "<PREFIX><REF_NAME>" --secret-string file://executor/.local/secrets-tmp/hostkey.txt
```

### 3. SSH private key (never on the command line)

Copy the key you generated for the dedicated deploy user to `executor/.local/secrets-tmp/ssh-key` (key only; passwords are not supported, gap G-1). A trailing newline is harmless: the SSH library trims the key before parsing, and the key is never a script argument. Either form works (the K-4 README is consistent: the "no final newline" rule is for every other value).

```powershell
aws secretsmanager create-secret --name "<PREFIX><REF_NAME>" --secret-string file://executor/.local/secrets-tmp/ssh-key
```

### 4. Slack token and channel id

```powershell
$s = Read-Host "Slack bot token" -AsSecureString
Write-SecretFile "executor/.local/secrets-tmp/value.txt" ([System.Net.NetworkCredential]::new("", $s).Password)
aws secretsmanager create-secret --name "<PREFIX><REF_NAME>" --secret-string file://executor/.local/secrets-tmp/value.txt
```

Repeat the same pattern for the channel id ref (plain text, not a secret credential, but stored the same way).

### 5. Role IDs (identifier secrets)

Values are the **role IDs** from the stack outputs `CiRoleId`, `ExecutorRoleId`, `OperatorRoleId`, `SchedulerRoleId` (not ARNs). Read one without printing the rest:

```powershell
$id = aws cloudformation describe-stacks --stack-name cicd-poc-dev --query "Stacks[0].Outputs[?OutputKey=='CiRoleId'].OutputValue" --output text
Write-SecretFile "executor/.local/secrets-tmp/value.txt" $id.Trim()
aws secretsmanager create-secret --name "<PREFIX><REF_NAME>" --secret-string file://executor/.local/secrets-tmp/value.txt
```

Map each output to its ref:

| Stack output | Referenced as |
|---|---|
| `CiRoleId` | The deployment definition's `allowedSenderRef` (startup validation until R-6) and `CICD_CI_PRINCIPAL_REF` ([05](05-run-executor-node22.md); AC-02 V1: the request path authorizes `DEPLOY_REQUESTED` by this reference) |
| `ExecutorRoleId` | `CICD_EXECUTOR_PRINCIPAL_REF` |
| `SchedulerRoleId` | `CICD_SCHEDULER_PRINCIPAL_REF` |
| `OperatorRoleId` | `CICD_OPERATOR_PRINCIPAL_REF` |

A recreated role gets a new role ID, so refresh the secret after any role replacement (rotation below).

### 6. Image repository URI

```powershell
Write-SecretFile "executor/.local/secrets-tmp/value.txt" "<ECR_REGISTRY_HOST>/<ECR_REPOSITORY>"
aws secretsmanager create-secret --name "<PREFIX><REF_NAME>" --secret-string file://executor/.local/secrets-tmp/value.txt
```

(Use your real registry host in the value only; the placeholder form above is for this document.)

### 7. All other refs

Ports (`host:container`), health URLs, container names, external deployers JSON, source-binding values (repository, workflow reference, Environment name): same pattern, one secret each, values as listed in the K-4 table. The source-binding `workflowRef` value must equal what the request carries; its exact form is pinned at B2 (gap G-4, P-G11).

## Rotation: new value for an existing secret

If you already removed the value folder, recreate it with its ACL first (see "Protect the value files first"):

```powershell
New-Item -ItemType Directory -Force executor/.local/secrets-tmp | Out-Null
icacls "executor\.local\secrets-tmp" /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
```

Then (paste the `Write-SecretFile` helper again in a new session) write the new value with `Write-SecretFile` (or the `Read-Host` form) and run:

```powershell
aws secretsmanager put-secret-value --secret-id "<PREFIX><REF_NAME>" --secret-string file://executor/.local/secrets-tmp/value.txt
```

Expected: JSON with a new `VersionId`. Most refs are read at startup (see the Access column of the K-4 table), so **restart the Executor** after changing one.

## Verify existence

```powershell
aws secretsmanager describe-secret --secret-id "<PREFIX><REF_NAME>" --query "{Name:Name,Deleted:DeletedDate}" --output json
```

Expected: the name and `"Deleted": null`. Run it for every ref in the K-4 table. The Executor performs the same existence check at startup and refuses to start naming the missing logical ref.

**Stop if** any `describe-secret` returns `ResourceNotFoundException`. Create it before starting the Executor.

## Clean up the value files

```powershell
Remove-Item -Recurse -Force executor/.local/secrets-tmp
```

Run this after the last secret is created (and after every rotation). The secret values now live only in Secrets Manager.

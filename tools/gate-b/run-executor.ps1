# @akili-spec changes/cicd-executor-poc gate-b-plan K-6
# Owner-run launcher (Windows PowerShell 5.1+): loads an env file, selects the portable
# Node 22 binary and runs `node dist/src/main/index.js` from executor/. It adds no logic
# to the Executor. The env is applied to this process only and restored afterwards.
# -DryRun prints the resolved command with redacted values and starts nothing.
[CmdletBinding()]
param(
  [string]$EnvFile,
  [string]$NodePath,
  [string]$ExecutorDir,
  [switch]$AllowLocalEndpoint,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

function Stop-Run([string]$Message) {
  [Console]::Error.WriteLine("run-executor: $Message")
  exit 2
}

if (-not $ExecutorDir) { $ExecutorDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'executor' }
if (-not $EnvFile) { $EnvFile = Join-Path $ExecutorDir '.local\executor.env' }
if (-not $NodePath) { $NodePath = Join-Path $ExecutorDir '.local\node22\node.exe' }
$mainJs = 'dist/src/main/index.js'

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
  Stop-Run "env file not found: $EnvFile (copy docs/gate-b/executor/executor.env.example to executor/.local/executor.env)"
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  Stop-Run "Node binary not found: $NodePath (see docs/gate-b/05-run-executor-node22.md)"
}

$nodeVersion = ((& $NodePath --version 2>$null) | Out-String).Trim()
if ($nodeVersion -notmatch '^v22\.') {
  $shown = if ($nodeVersion) { $nodeVersion } else { 'unknown' }
  Stop-Run "refusing to run: Node major 22 is required, found '$shown' at $NodePath"
}

if (-not (Test-Path -LiteralPath (Join-Path $ExecutorDir $mainJs) -PathType Leaf)) {
  Stop-Run "$(Join-Path $ExecutorDir $mainJs) is missing. Run 'npm ci && npm run build' in executor/ with the portable Node first."
}

# Simple env-file parser: KEY=VALUE, comments and blank lines ignored, optional surrounding quotes stripped.
$vars = [ordered]@{}
foreach ($raw in [System.IO.File]::ReadAllLines($EnvFile)) {
  $line = $raw.Trim()
  if ($line -eq '' -or $line.StartsWith('#')) { continue }
  $idx = $line.IndexOf('=')
  if ($idx -lt 1) { Stop-Run "invalid env line (expected KEY=VALUE): $line" }
  $key = $line.Substring(0, $idx).Trim()
  $val = $line.Substring($idx + 1).Trim()
  if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { Stop-Run "invalid env key: $key" }
  if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
    $val = $val.Substring(1, $val.Length - 2)
  }
  # A repeated key would let a later empty value override a validated one: refuse any duplicate.
  if ($vars.Contains($key)) { Stop-Run "refusing to run: duplicate key $key in the env file (each key may appear only once)." }
  $vars[$key] = $val
}

foreach ($forbidden in 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN') {
  if ($vars.Contains($forbidden)) {
    Stop-Run "refusing to run: $forbidden is in the env file; static AWS keys are not allowed (use AWS_PROFILE with role_arn + source_profile)."
  }
}
if (-not $vars.Contains('AWS_PROFILE') -or $vars['AWS_PROFILE'] -eq '') {
  Stop-Run 'refusing to run: AWS_PROFILE is missing or empty in the env file (use a profile with role_arn + source_profile that assumes the Executor role).'
}
# The expected Executor role (stack output ExecutorRoleArn). It is used ONLY to validate the isolated
# config and is deliberately not passed to the Executor: it is not a secret, but the Executor
# configuration surface stays unchanged (the role it assumes comes from the profile alone).
$expectedRoleArn = if ($vars.Contains('CICD_EXECUTOR_ROLE_ARN')) { $vars['CICD_EXECUTOR_ROLE_ARN'] } else { '' }
if (-not $expectedRoleArn) {
  Stop-Run 'refusing to run: CICD_EXECUTOR_ROLE_ARN is missing or empty in the env file (set it to the ExecutorRoleArn stack output; SR-3).'
}
if ($expectedRoleArn -cnotmatch '^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$') {
  Stop-Run 'refusing to run: CICD_EXECUTOR_ROLE_ARN is not a well-formed IAM role ARN.'
}
# SR-3: the Executor must run with an ISOLATED AWS config and credentials file (the dedicated
# principal), never the default %USERPROFILE%\.aws files that may hold administrator credentials.
# Allow-list: absolute path, under <executor-dir>\.local\aws\, no symbolic link / junction / reparse
# point on any component from .local down, and exactly one hard link.
function Test-IsolatedAwsFile([string]$Key, [string]$DefaultName) {
  $value = if ($vars.Contains($Key)) { $vars[$Key] } else { '' }
  if (-not $value) {
    Stop-Run "refusing to run: $Key is missing or empty in the env file (the Executor must use the isolated AWS files under executor/.local/aws/; see docs/gate-b/05-run-executor-node22.md)."
  }
  if ($value -notmatch '^([A-Za-z]:[\\/]|\\\\)') {
    Stop-Run "refusing to run: $Key must be an absolute path (a relative path would be resolved against another directory)."
  }
  if ($value -match '(^|[\\/])\.\.([\\/]|$)') {
    Stop-Run "refusing to run: $Key must not contain '..' segments."
  }
  if (-not (Test-Path -LiteralPath $value -PathType Leaf)) {
    Stop-Run "refusing to run: $Key points to a file that does not exist: $value"
  }
  $full = [System.IO.Path]::GetFullPath($value)
  if ($env:USERPROFILE) {
    $default = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE ".aws\$DefaultName"))
    if ($full -ieq $default) {
      Stop-Run "refusing to run: $Key points to the default %USERPROFILE%\.aws\$DefaultName; use the isolated file under executor/.local/aws/ (SR-3)."
    }
  }
  $execFull = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ExecutorDir).ProviderPath).TrimEnd('\')
  $localDir = "$execFull\.local"
  $allowed = "$localDir\aws"
  if (-not $full.StartsWith("$allowed\", [System.StringComparison]::OrdinalIgnoreCase)) {
    Stop-Run "refusing to run: $Key is outside <executor-dir>\.local\aws\ (allow-list rule, SR-3)."
  }
  $current = $localDir
  $parts = @('') + @($full.Substring($localDir.Length).TrimStart('\').Split('\'))
  foreach ($part in $parts) {
    if ($part -ne '') { $current = "$current\$part" }
    $item = Get-Item -LiteralPath $current -Force
    # PowerShell reports a multiply-linked file as LinkType 'HardLink'; that case is judged by the hard-link count below.
    if (($item.LinkType -and $item.LinkType -ne 'HardLink') -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      Stop-Run "refusing to run: $Key passes through a symbolic link, junction or reparse point (no links allowed under .local, SR-3)."
    }
  }
  # Hard-link count through fsutil (ships with Windows, works without elevation): it lists every
  # name of the file, so exactly one line means a single link. Failure to count is a refusal.
  $names = @(& fsutil.exe hardlink list $full 2>$null | Where-Object { $_ -and $_.Trim() })
  if ($LASTEXITCODE -ne 0 -or $names.Count -ne 1) {
    Stop-Run "refusing to run: $Key does not have exactly one hard link (or the count could not be determined, SR-3)."
  }
  return $full
}

# Simple INI parse, no evaluation: every line is data. Returns objects with Section and Key
# (Key is '[section]' for a header line).
function Read-IniKeys([string]$Path) {
  $sec = ''
  foreach ($raw in [System.IO.File]::ReadAllLines($Path)) {
    $t = $raw.Trim([char]0xFEFF, ' ', "`t")
    if ($t -eq '' -or $t.StartsWith('#') -or $t.StartsWith(';')) { continue }
    if ($t.StartsWith('[') -and $t.EndsWith(']')) {
      $sec = ($t.Substring(1, $t.Length - 2).Trim() -replace '\s+', ' ')
      [pscustomobject]@{ Section = $sec; Key = '[section]'; Value = '' }
    }
    elseif ($t.Contains('=')) {
      [pscustomobject]@{ Section = $sec; Key = $t.Substring(0, $t.IndexOf('=')).Trim().ToLowerInvariant(); Value = $t.Substring($t.IndexOf('=') + 1).Trim() }
    }
  }
}

$awsProfile = $vars['AWS_PROFILE']
$configReal = Test-IsolatedAwsFile 'AWS_CONFIG_FILE' 'config'
$credsReal = Test-IsolatedAwsFile 'AWS_SHARED_CREDENTIALS_FILE' 'credentials'

$targetSection = "profile $awsProfile"
$foundProfile = $false; $hasRole = $false; $hasSource = $false; $roleMismatch = $false
foreach ($e in (Read-IniKeys $configReal)) {
  if ($e.Key -in 'credential_process', 'credential_source', 'web_identity_token_file' -or $e.Key.StartsWith('sso_')) {
    Stop-Run "refusing to run: the isolated AWS config contains '$($e.Key)' (forbidden: credentials must come only from role_arn + source_profile, SR-3)."
  }
  if ($e.Key -eq '[section]' -and $e.Section.StartsWith('sso-session')) {
    Stop-Run 'refusing to run: the isolated AWS config contains an sso-session section (forbidden, SR-3).'
  }
  if ($e.Key -eq '[section]' -and $e.Section -ceq $targetSection) { $foundProfile = $true }
  if ($e.Section -ceq $targetSection -and $e.Key -eq 'role_arn') {
    $hasRole = $true
    if ($e.Value -cne $expectedRoleArn) { $roleMismatch = $true }
  }
  if ($e.Section -ceq $targetSection -and $e.Key -eq 'source_profile') { $hasSource = $true }
}
if (-not $foundProfile) { Stop-Run "refusing to run: the isolated AWS config has no [profile $awsProfile] section named by AWS_PROFILE." }
if (-not $hasRole) { Stop-Run "refusing to run: the [profile $awsProfile] section of the isolated AWS config has no role_arn." }
if (-not $hasSource) { Stop-Run "refusing to run: the [profile $awsProfile] section of the isolated AWS config has no source_profile." }
if ($roleMismatch) { Stop-Run "refusing to run: the role_arn of [profile $awsProfile] in the isolated AWS config is not exactly CICD_EXECUTOR_ROLE_ARN (the profile must assume only the Executor role, SR-3)." }
foreach ($e in (Read-IniKeys $credsReal)) {
  if ($e.Key -eq '[section]') {
    if ($e.Section -ceq $awsProfile -or $e.Section -ceq $targetSection) {
      Stop-Run 'refusing to run: the isolated credentials file contains a section named like AWS_PROFILE (the role profile must not carry static keys, SR-3).'
    }
  }
  elseif ($e.Key -notin 'aws_access_key_id', 'aws_secret_access_key') {
    # Allow-list: a source-key file holds ONLY the two static key fields.
    Stop-Run "refusing to run: the isolated credentials file contains '$($e.Key)' (only aws_access_key_id and aws_secret_access_key are allowed, SR-3)."
  }
}
# The child receives the RESOLVED absolute paths and credentials only through the role profile.
$vars['AWS_PROFILE'] = $awsProfile
$vars.Remove('CICD_EXECUTOR_ROLE_ARN')
$vars['AWS_CONFIG_FILE'] = $configReal
$vars['AWS_SHARED_CREDENTIALS_FILE'] = $credsReal
$vars['AWS_EC2_METADATA_DISABLED'] = 'true'
$altCredVars = 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'
foreach ($alt in $altCredVars) {
  if ([Environment]::GetEnvironmentVariable($alt, 'Process')) {
    [Console]::Error.WriteLine("run-executor: warning: inherited $alt is ignored and removed from the Executor environment (only the isolated role profile may supply credentials).")
  }
  if ($vars.Contains($alt)) { $vars.Remove($alt) }
}
if ($vars.Contains('CICD_DYNAMODB_ENDPOINT') -and $vars['CICD_DYNAMODB_ENDPOINT'] -ne '' -and -not $AllowLocalEndpoint) {
  Stop-Run 'refusing to run: CICD_DYNAMODB_ENDPOINT is set and would point the Executor at a local emulator instead of AWS (pass -AllowLocalEndpoint to override).'
}

$staticKeys = 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'
foreach ($inherited in $staticKeys) {
  if ([Environment]::GetEnvironmentVariable($inherited, 'Process')) {
    [Console]::Error.WriteLine("run-executor: warning: inherited $inherited is ignored and removed from the Executor environment (static keys are not allowed).")
  }
}

if ($DryRun) {
  Write-Output 'run-executor (dry run): nothing is started'
  Write-Output "node: $NodePath ($nodeVersion)"
  Write-Output "cwd: $ExecutorDir"
  Write-Output "command: $NodePath $mainJs"
  Write-Output "env file: $EnvFile"
  Write-Output 'env (values redacted):'
  foreach ($k in $vars.Keys) {
    $state = if ($vars[$k] -ne '') { '<set>' } else { '<empty>' }
    Write-Output "  $k=$state"
  }
  exit 0
}

# Apply the env to this process only and restore it afterwards (nothing persists).
$saved = @{}
$savedLocation = Get-Location
try {
  foreach ($k in ($staticKeys + $altCredVars)) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $null, 'Process')
  }
  foreach ($k in $vars.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process')
  }
  Set-Location -LiteralPath $ExecutorDir
  & $NodePath $mainJs
  $code = $LASTEXITCODE
}
finally {
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  Set-Location -LiteralPath $savedLocation.Path
}
exit $code

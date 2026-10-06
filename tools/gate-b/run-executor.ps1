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
  foreach ($k in $staticKeys) {
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

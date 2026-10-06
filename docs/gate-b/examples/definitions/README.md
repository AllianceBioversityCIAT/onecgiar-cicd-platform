# Example definitions (Gate B, K-4)

A generic, parameterized Deployment Definition and Target Registry entry. You copy them into a
**local, gitignored** definitions root, replace the sample ids, and store the real values in
Secrets Manager under the logical ref names. Nothing real is ever committed (publication
policy, DD-23).

## Layout

| File | Purpose |
|---|---|
| `deployment-definitions/example/app-dev.yaml` | One deployment, two artifact units, `deployScript: deploy-container.sh` |
| `deployment-definitions/targets/dev.yaml` | Target Registry entry (connection, host key, credential, lockKey, window policy) |

One deployment per `lockKey` (DD-27): do not point two deployments at the same lockKey.

## Copy into a local definitions root

The Executor, started with `CICD_DEFINITIONS_ROOT`, reads `deployment-definitions/`, `schemas/` and
`deploy-scripts/` from that root, so copy all three. `executor/.local/` is already gitignored.

PowerShell, from the repository root:

```powershell
$dst = "executor/.local/definitions"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Recurse -Force docs/gate-b/examples/definitions/deployment-definitions "$dst/"
Copy-Item -Recurse -Force schemas "$dst/"
Copy-Item -Recurse -Force deploy-scripts "$dst/"
```

bash, from the repository root:

```bash
dst=executor/.local/definitions
mkdir -p "$dst"
cp -r docs/gate-b/examples/definitions/deployment-definitions "$dst/"
cp -r schemas "$dst/"
cp -r deploy-scripts "$dst/"
```

Warning: re-running the copy commands overwrites any edits you made to the copies. Copy once, then edit.

Set `CICD_DEFINITIONS_ROOT` to the **absolute** path of `executor/.local/definitions`.

Then edit the copies: replace `example-app-dev` and `example-target-dev` with your own ids, and
rename the `<EXAMPLE_...>` refs if you wish (keep them in `<UPPER_SNAKE>` form and keep both files consistent).

## Check offline (no AWS, no network, no secrets)

From `executor/`:

```bash
npm run definitions:check -- --root .local/definitions
```

The tool only validates structure. If the root has no `schemas/`, it falls back to the repository's copy and prints a note.

## What each logical ref stores

The secret id is `CICD_SECRET_ID_PREFIX` + the ref name without angle brackets: with the prefix `cicd-poc/dev/`,
`<EXAMPLE_SLACK_TOKEN_REF>` is stored as `cicd-poc/dev/EXAMPLE_SLACK_TOKEN_REF`. The prefix must equal the stack parameter
`SecretIdPrefix` (the Executor role can read nothing else). "Read" means `GetSecretValue`; "Exists only" means `DescribeSecret` and the value is not read by the
definition service.

| Logical ref | Store in the secret | Access |
|---|---|---|
| `<EXAMPLE_DEV_TARGET>` (middle segment of `lockKey`) | Not a secret reference: a logical segment naming the target. Replace it with your own `<UPPER_SNAKE>` name; nothing is stored under it | None |
| `<EXAMPLE_DEV_CONNECTION_REF>` | Connection identity JSON: `{"host":"<TARGET_HOST>","port":22,"user":"<DEPLOY_USER>"}` (`user` is required; `port` is optional and must be a JSON number, e.g. `22`, not a string, otherwise it is ignored and 22 is used). No credential inside | Read at startup |
| `<EXAMPLE_DEV_HOST_KEY_REF>` | OpenSSH host public key lines of the form `<type> <base64>` only (e.g. `ssh-ed25519 <BASE64>`). Remove the hostname field that `ssh-keyscan` prints first: lines whose first token is not a key type are skipped, and the first deploy would fail with HOST_KEY_MISMATCH. Obtain it out of band | Read at startup |
| `<EXAMPLE_DEV_SSH_CREDENTIAL_REF>` | SSH private key (PEM or OpenSSH format). Key only: no password (spec gap G-1) | Exists only at startup; read by the SSH handler at deploy time |
| `<EXAMPLE_DEV_EXTERNAL_DEPLOYERS_REF>` | JSON array of strings naming the external deployers (only with `deployWindowPolicy: required`; the list must be non-empty) | Read at startup |
| `<EXAMPLE_SERVER_IMAGE_REPOSITORY_REF>`, `<EXAMPLE_CLIENT_IMAGE_REPOSITORY_REF>` | Image repository as `<registry>/<path>`: no scheme, no tag, no digest (the Executor appends `@<digest>`) | Read at startup |
| `<EXAMPLE_SERVER_PORT_REF>`, `<EXAMPLE_CLIENT_PORT_REF>` | Host:container port mapping | Read at startup |
| `<EXAMPLE_SERVER_CONTAINER>`, `<EXAMPLE_CLIENT_CONTAINER>` | Real container name (a placeholder form is resolved; a lowercase id is used literally) | Read at startup |
| `<EXAMPLE_SERVER_HEALTH_URL_REF>`, `<EXAMPLE_CLIENT_HEALTH_URL_REF>` | Health check URL | Read at startup |
| `<EXAMPLE_REPO_REF>`, `<EXAMPLE_WORKFLOW_REF>`, `<EXAMPLE_GITHUB_ENVIRONMENT_REF>` | Source binding, exact forms compared by strict equality: repository `<owner>/<repo>` (`github.repository`); workflow `<owner>/<repo>/.github/workflows/<file>@<ref>` (the caller's `github.workflow_ref`); GitHub Environment name | Read at startup |
| `<EXAMPLE_CI_ROLE_REF>` (`allowedSenderRef`) | CI role ID: stack output `CiRoleId` | Read at startup |
| `<EXAMPLE_SLACK_CHANNEL_REF>` | Slack channel identifier | Read at startup |
| `<EXAMPLE_SLACK_TOKEN_REF>` | Slack bot token | Exists only at startup; read when notifying |
| `<EXAMPLE_SERVER_RUNTIME_SECRET_REF>` (`runtimeSecretRefs`, `envSecretRef`) | The application's runtime secret, owned by the application | **Never read by the Executor**; passed through unresolved to the target (OD-Q5 open) |

Platform principal refs are set in the Executor environment, not in these files (see the local run kit env example):

| Environment variable | Secret holds | Access |
|---|---|---|
| `CICD_EXECUTOR_PRINCIPAL_REF` | Executor role ID: stack output `ExecutorRoleId` | Read at startup |
| `CICD_SCHEDULER_PRINCIPAL_REF` | Scheduler role ID: stack output `SchedulerRoleId` | Read at startup |
| `CICD_OPERATOR_PRINCIPAL_REF` | Operator role ID: stack output `OperatorRoleId` | Read at startup |
| `CICD_PLATFORM_SLACK_CHANNEL_REF` | Platform Slack channel identifier | Exists only at startup; read at notification time |
| `CICD_PLATFORM_SLACK_TOKEN_REF` | Platform Slack bot token | Exists only at startup; read at notification time |

Role IDs are the values of the stack outputs `*RoleId` (not ARNs).

## Store every value without a trailing newline

Startup refuses a trailing newline in values that become script arguments (container name, image repository, health URL); in source-binding values and role IDs it causes a silent mismatch at request time (the request is rejected). Save each value to a file without a final newline and pass it with `file://`:

```bash
printf '%s' '<VALUE>' > value.txt   # printf adds no newline
aws secretsmanager create-secret --name "<PREFIX><REF_NAME>" --secret-string file://value.txt
```

```powershell
[IO.File]::WriteAllText("$PWD\value.txt", '<VALUE>')   # no trailing newline; absolute path (.NET ignores $PWD for relative paths)
```

For multi-line values (host key lines) the last line must not be followed by a newline either. The private key is the exception: the SSH library trims it before parsing and it is never a script argument, so a trailing newline is harmless there (either form works). Delete `value.txt` afterwards: it may hold a plaintext private key.

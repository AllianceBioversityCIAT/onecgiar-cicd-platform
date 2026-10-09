<!-- @akili-spec changes/cicd-executor-poc design §5.3, §6.3, §11.2; architecture-change-02 AC2-4, V1-R2, V1-R3; tasks R-7 -->
# 09. Register a target (Target Registry tool)

**Answer first.** You add or change a target by writing one record to the Target Registry table with
`tools/target-registry`, using **your administrative profile**. The Executor is not changed or
redeployed: it reads the record with `GetItem` on the next request. The tool validates the record
against `schemas/target-record.schema.json`, checks that `credentialRef` lies under the Executor's
secret prefix, and writes conditionally on `version`, so it never overwrites a change it has not seen.

Run from the repository root, after `npm ci && npm run build` in `executor/`. Claude does not run any
of this; every command is yours.

## 1. Who may write

| Principal | Registry access |
|---|---|
| Your administrative profile `<AWS_PROFILE_ADMIN>` | `GetItem` and `PutItem` on `<REGISTRY_TABLE_NAME>` (your own IAM permissions; the stack grants none) |
| Executor role | `GetItem` only (task R-2) |
| CI role | None |

The tool refuses to run with the Executor profile (`cicd-executor`), with `AWS_PROFILE=cicd-executor`, or
with any of `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_CONFIG_FILE`,
`AWS_SHARED_CREDENTIALS_FILE`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`,
`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or `AWS_CONTAINER_CREDENTIALS_FULL_URI` set (they could supply
credentials other than `--profile`, or point at the Executor's isolated files), and it disables the instance
metadata fallback. Run it in a fresh shell, not in the Executor's.

Registry write access decides which host and script a target deploys to and, with option A, which
repository may deploy it (AC2-4). Keep it to the administrative profile.

## 2. Prepare the record file

Create `executor/.local/targets/<TARGET_ID>.json` (ignored by Git). The tool sets `schemaVersion`,
`version`, `updatedAt` and `updatedBy`; a file that sets any of them is refused.

```json
{
  "targetId": "<TARGET_ID>",
  "project": "<PROJECT>",
  "environment": "dev",
  "host": "<TARGET_HOST>",
  "port": 22,
  "user": "<DEPLOY_USER>",
  "hostKey": ["<HOST_KEY_LINE>"],
  "credentialRef": "<SECRET_ID_PREFIX><TARGET_ID>/ssh",
  "deployScript": "<ABSOLUTE_SCRIPT_PATH>",
  "deployWindowPolicy": "required",
  "scriptArguments": "standard",
  "sourceRepositoryId": "<GITHUB_REPOSITORY_ID>"
}
```

| Field | Where you get it |
|---|---|
| `hostKey` | The `ssh-keyscan` line compared out of band ([06](06-target-validation.md), step 1), without the host name column |
| `credentialRef` | The full name of the SSH private key secret you created under `<SECRET_ID_PREFIX>` ([02](02-secrets.md)) |
| `deployScript` | The absolute path where the target's administrator installed the deploy script |
| `deployWindowPolicy` | `required` when another deployer (for example a Jenkins job) still targets the same server |
| `scriptArguments` | Optional (architecture-change-03). `standard` (the default when omitted): the script receives `--target-id --execution-id --fencing-token --commit-sha [--artifact …]` and can deploy exactly the requested version. `none`: the script runs with no argument and decides itself what it deploys; the execution then records `versionGuaranteed: false`. Use `none` only for scripts whose source is fixed outside the request. A Docker target (`deploy-container.sh`) needs `standard` and at least one artifact in every request |
| `sourceRepositoryId` | `gh api repos/<GITHUB_ORG>/<APP_REPO> --jq .id` (the numeric id, not the name) |

## 3. Read the checklist and dry run (no AWS call)

```bash
tools/target-registry checklist
tools/target-registry put --file executor/.local/targets/<TARGET_ID>.json --updated-by <YOUR_NAME> \
  --secret-id-prefix <SECRET_ID_PREFIX> --dry-run
```

`<SECRET_ID_PREFIX>` is exactly the stack parameter `SecretIdPrefix` (the same value as the Executor's `CICD_SECRET_ID_PREFIX`).

Expected: the full record as JSON, the checklist, then `dry run: would create <TARGET_ID>; nothing was written` (or `would update <TARGET_ID> from version <N>`: check the target id before a real update).

**Stop if** it prints `invalid target record: ...` (the rule and field are named) or any checklist item is
not true yet.

## 4. Write

Create a new target:

```bash
tools/target-registry put --file executor/.local/targets/<TARGET_ID>.json --updated-by <YOUR_NAME> \
  --secret-id-prefix <SECRET_ID_PREFIX> --registry-table <REGISTRY_TABLE_NAME> --region <AWS_REGION> \
  --profile <AWS_PROFILE_ADMIN> --checklist-confirmed
```

Expected: `created <TARGET_ID> at version 1`, exit 0.

Change an existing target: read its version, edit the file, then write from that version:

```bash
tools/target-registry get --target-id <TARGET_ID> --registry-table <REGISTRY_TABLE_NAME> --region <AWS_REGION> --profile <AWS_PROFILE_ADMIN>
tools/target-registry put ... --expected-version <N> --checklist-confirmed
```

Expected: `updated <TARGET_ID> at version <N+1>`. Executions already accepted keep the snapshot they took;
only new requests see the change.

| Message | Meaning |
|---|---|
| `target <TARGET_ID> already exists; ...` | A create found a record: use `get` and `--expected-version` |
| `target <TARGET_ID> does not exist or its version is not <N>` | Someone changed it since you read it, or it does not exist. Read it again |
| `refusing to run: ...` | A wrong profile or an AWS variable in the environment (section 1) |
| `write failed: AccessDeniedException` | Your administrative profile lacks `PutItem` on the table |

There is no delete command. To remove a target, delete its item in the console with your administrative
profile; point-in-time recovery stays on.

## 5. Option A gate

Do not add a second repository to the CI role trust until the B2 positive and negative tests of P-R1 and
P-R2 pass, including the real SQS `SenderId` suffix ([07](07-verification.md)).

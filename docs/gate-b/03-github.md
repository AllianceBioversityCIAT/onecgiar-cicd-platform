<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §3 (B2), §6, §12; design DD-24, DD-29 -->
# 03. GitHub: Environment, values, caller workflow, OIDC checks (B2)

**Answer first.** In your chosen repository `<GITHUB_ORG>/<APP_REPO>` you create one Environment
`<GITHUB_ENVIRONMENT>` holding **no secrets** and exactly **five variables** (`CICD_ROLE_ARN` among them),
add the caller workflow on the bound branch, and trigger it with `workflow_dispatch`. AWS
authentication is OIDC only. **Never store an AWS access key or secret access key in GitHub (or
anywhere).** No application repository is changed by Claude; you pick the repository and branch.

## Value classification (plan section 12)

| Value | Class | Source | Notes |
|---|---|---|---|
| `CICD_ROLE_ARN` | Environment **variable** (not a secret) | Stack output `CiRoleArn` | Not a credential. It embeds the account id, so the role ARN and account id **will be visible in public workflow logs** (accepted, owner decision 2026-10-06): access is controlled by the OIDC trust conditions, not by hiding the ARN |
| `CICD_AWS_REGION` | Environment variable | `<AWS_REGION>` (your choice) | |
| `CICD_ECR_REPOSITORY` | Environment variable | Repository **name** only: last segment of stack output `CiEcrRepositoryArn` | No account id |
| `CICD_DEPLOY_QUEUE_NAME` | Environment variable | Stack output `DeployQueueName` | Name only; the URL is derived |
| `CICD_BOUND_REF` | Environment variable, **admin-only** | Your choice: the full ref `refs/heads/<BOUND_BRANCH>` | The one ref allowed to deploy; fail closed when empty. MUST equal the stack parameter `GitHubBoundRef` ([01](01-aws-sam.md)); a mismatch makes the role assumption fail closed |
| Account id, registry host, queue URL | **Derived after OIDC**, masked as log hygiene | `sts get-caller-identity`, registry login output, `sqs get-queue-url` | Never stored in GitHub |
| Environment name, deployment branch rules, branch protection, required reviewers | Repository / Environment **configuration** | You | Not values |
| `targetId`, `environment`, `units` | Caller workflow **inputs** | In the caller file | Non-sensitive. The AWS role session name is **not** an input: the reusable workflow derives it from `github.repository_id` (R-8) |

## 1. Read the numeric ids (read-only, needed by the stack)

```powershell
gh api repos/<GITHUB_ORG>/<APP_REPO> --jq .id
gh api users/<GITHUB_ORG> --jq .id
```

Expected: two integers: `<GITHUB_REPOSITORY_ID_DIGITS>` and `<GITHUB_OWNER_ID_DIGITS>` (stack parameters `GitHubRepositoryId`, `GitHubRepositoryOwnerId`). You may use the web UI or any other means instead of `gh`.

## 2. Create the Environment and its deployment branch rule

In the repository: **Settings, Environments, New environment**, name `<GITHUB_ENVIRONMENT>` (it must equal the stack parameter `GitHubEnvironment` exactly).

1. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the single branch `<BOUND_BRANCH>`.
2. Leave **Required reviewers** empty for DEV (production-like environments add them later).

Expected: the Environment page lists exactly one deployment branch rule.

**Stop if** the rule allows "All branches" or "Protected branches" only. Fix it before continuing.

CLI equivalent (optional; the UI is the reference):

```powershell
gh api --method PUT repos/<GITHUB_ORG>/<APP_REPO>/environments/<GITHUB_ENVIRONMENT> --input executor/.local/gate-b/environment.json
```

with a file `{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}` and then `gh api --method POST repos/<GITHUB_ORG>/<APP_REPO>/environments/<GITHUB_ENVIRONMENT>/deployment-branch-policies -f name=<BOUND_BRANCH> -f type=branch`.

## 3. Set the variables on the Environment (no secrets)

UI: Environment page, **Environment variables**. The Environment holds no secrets: GitHub holds no AWS credential of any kind (authentication is GitHub OIDC only). Or with `gh`:

```powershell
gh variable set CICD_ROLE_ARN --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO> --body "<CI_ROLE_ARN>"
gh variable set CICD_AWS_REGION --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO> --body "<AWS_REGION>"
gh variable set CICD_ECR_REPOSITORY --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO> --body "<ECR_REPOSITORY>"
gh variable set CICD_DEPLOY_QUEUE_NAME --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO> --body "<DEPLOY_QUEUE_NAME>"
gh variable set CICD_BOUND_REF --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO> --body "refs/heads/<BOUND_BRANCH>"
```

Verify:

```powershell
gh secret list --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO>
gh variable list --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO>
```

Expected: the secret list is empty and the variable list shows exactly the five variables (`CICD_ROLE_ARN`, `CICD_AWS_REGION`, `CICD_ECR_REPOSITORY`, `CICD_DEPLOY_QUEUE_NAME`, `CICD_BOUND_REF`).

**Stop if** you find any AWS access key or secret key stored anywhere in the repository or Environment, or any secret in the Environment. Remove it; the model is OIDC only. Never store AWS keys in GitHub.

`CICD_BOUND_REF` is admin-only: only repository admins can edit Environment variables, so keep the number of admins small and do not grant the admin role to people who push to the bound branch.

## 4. Decoy check for `CICD_BOUND_REF` (gap G-3, owner decision pending)

The precedence between Environment, repository and organization variables is unverified (P-G13). Until it is decided, confirm no same-named variable exists at the other levels:

```powershell
gh variable list --repo <GITHUB_ORG>/<APP_REPO>
gh variable list --org <GITHUB_ORG>
```

Expected: neither list contains `CICD_BOUND_REF`.

**Stop if** either list contains it. Do not delete anything you do not own; report it and pause B2.

## 5. Branch protection and the platform workflow

1. On `<BOUND_BRANCH>`: require a pull request before merging and restrict who can push (or require a review). Reason: only code on the bound branch can reach the Environment.
2. The platform repository `<GITHUB_ORG>/<PLATFORM_REPO>` must let the application repository call its reusable workflow: if it is private, **Settings, Actions, General, Access** must allow access from repositories in the organization (or owner).
3. The reusable workflow must exist at the commit `<PINNED_COMMIT_SHA>` you gave the stack.

## 6. Add the caller workflow

1. Copy [`github/caller-workflow.example.yml`](github/caller-workflow.example.yml) to `.github/workflows/<WORKFLOW_FILE>.yml` on `<BOUND_BRANCH>` of `<GITHUB_ORG>/<APP_REPO>`.
2. Replace every placeholder named in the file header: `<GITHUB_ORG>/<PLATFORM_REPO>`, `<PINNED_COMMIT_SHA>`, `<BOUND_BRANCH>`, `<OWNER_TARGET_ID>`, `<GITHUB_ENVIRONMENT>`, the units, and the lint/test step. Do not add `role-session-name` or any AWS step to the caller.
3. `<PINNED_COMMIT_SHA>` must be a full 40-hex commit SHA, never a tag or branch, and **must equal** the stack parameter `PinnedWorkflowSha`. Moving the pin means changing the stack (and the trust policy) in the same change. For the real run it is the platform commit that contains task R-8 (`role-session-name: ${{ github.repository_id }}`); during the section 7 probe it is the probe commit.
4. The caller passes no secrets (no `secrets:` key, no `secrets: inherit`).
5. **Platform repository as its own caller** (allowed for the PoC: the trust only needs `repository_id`, `repository_owner_id`, `sub`, `environment` and `ref` to name that repository, environment and bound branch): call the reusable workflow with the full `<GITHUB_ORG>/<PLATFORM_REPO>/.github/workflows/deploy-request.reusable.yml@<SHA>` form, never the local `./.github/workflows/...` form (a local call is not pinned to a SHA, so `job_workflow_ref` would not match). Use a dedicated bound branch (for example `refs/heads/<BOUND_BRANCH>` other than `main`) holding the caller, so `main` carries no caller workflow; trigger it with `push` to that branch (a `workflow_dispatch` run needs the workflow file on the default branch).

Expected: `workflow_dispatch` is available on the Actions tab for this workflow.

## 7. Session-name probe: P-R1, P-R2, P-G10, P-G11 (before the first real request)

The CI role trust compares exact strings and, with option A, requires the role session name to equal the token's `repository_id`. A denied `AssumeRoleWithWebIdentity` is **silent** (a generic "not authorized", no condition named), so this probe records the real claims and tests the session-name condition directly, with no image push and no SQS message.

The trust pins `deploy-request.reusable.yml` at one SHA, so the probe must live **at that same path** on a throwaway branch of the platform repository, and the stack is deployed with the probe commit as `PinnedWorkflowSha` first ([01](01-aws-sam.md)); afterwards the stack is updated to the real R-8 commit.

1. In `<GITHUB_ORG>/<PLATFORM_REPO>`, create the branch `<PROBE_BRANCH>` from the **published** `origin/main` (so pushing it publishes no unreviewed local commit), replace `.github/workflows/deploy-request.reusable.yml` on that branch with the file below, commit, push, and record the full commit SHA as `<PROBE_SHA>` (`git rev-parse HEAD`). Never merge this branch.

```yaml
name: b2-session-probe
on:
  workflow_call:
    inputs:
      targetId: { type: string, required: true }
      environment: { type: string, required: true }
      units: { type: string, required: true }
permissions: {}
jobs:
  probe:
    runs-on: ubuntu-24.04
    environment: ${{ inputs.environment }}
    permissions:
      id-token: write
    steps:
      - name: Claims, then one session name that must work and two that must be denied
        env:
          ROLE_ARN: ${{ vars.CICD_ROLE_ARN }}
          AWS_REGION: ${{ vars.CICD_AWS_REGION }}
          REPOSITORY_ID: ${{ github.repository_id }}
        run: |
          set -euo pipefail
          token="$(curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)"
          echo "::add-mask::$token"
          printf '%s' "$token" | jq -R 'split(".")[1] | gsub("-";"+") | gsub("_";"/") | . + ("=" * ((4 - length % 4) % 4)) | @base64d | fromjson | {aud,sub,repository_id,repository_owner_id,environment,job_workflow_ref,event_name,ref}'
          attempt() {
            if aws sts assume-role-with-web-identity --role-arn "$ROLE_ARN" --role-session-name "$1" \
                 --web-identity-token "$token" --query AssumedRoleUser.AssumedRoleId --output text > /dev/null 2> "$RUNNER_TEMP/err"; then
              echo "$2: ALLOWED"
            else
              echo "$2: DENIED $(grep -oE '\(([A-Za-z]+)\)' "$RUNNER_TEMP/err" | head -1)"
            fi
          }
          attempt "$REPOSITORY_ID" "session = repository_id"
          attempt "wrong-session" "session = wrong-session"
          attempt "$((REPOSITORY_ID + 1))" "session = another numeric id"
```

2. Deploy the stack with `PinnedWorkflowSha = <PROBE_SHA>` ([01](01-aws-sam.md), checkpoints A to D).
3. In the application repository, point the caller (section 6) at `@<PROBE_SHA>` and run it with **Run workflow** on `<BOUND_BRANCH>`. The caller is unchanged otherwise; the probe ignores its inputs, pushes nothing and sends nothing.

Expected in the `probe` job log: the claims JSON, then exactly

```text
session = repository_id: ALLOWED
session = wrong-session: DENIED (AccessDenied)
session = another numeric id: DENIED (AccessDenied)
```

| Result | Meaning | Action |
|---|---|---|
| ALLOWED, DENIED, DENIED | P-R1 (the session-name condition is evaluated for `AssumeRoleWithWebIdentity`) and P-R2 (the claim resolves as a policy variable) hold | Record it; continue with the claims check below |
| First line DENIED | A claim differs from the stack, or the policy variable does not resolve (P-R2) | Compare the claims with the table below first. If every claim matches, **stop**: option A fails; share the log, do not change the template |
| Second or third line ALLOWED | The session-name condition is not enforced (P-R1 fails) | **Stop.** Option A fails; share the log. Option B (SR-2) is evaluated; nothing is changed by assumption |

Compare the claims with the stack:

| Claim | Must equal |
|---|---|
| `sub` | Stack parameter `GitHubOidcSub` (P-G10; expected default form `repo:<GITHUB_ORG>/<APP_REPO>:environment:<GITHUB_ENVIRONMENT>`; repositories created, renamed or transferred after 2026-07-15 use the immutable form `repo:<GITHUB_ORG>@<OWNER_ID>/<APP_REPO>@<REPO_ID>:environment:<GITHUB_ENVIRONMENT>`) |
| `job_workflow_ref` | `<GITHUB_ORG>/<PLATFORM_REPO>/.github/workflows/deploy-request.reusable.yml@<ref form>` where `<ref form>` is what the probe shows for the SHA-pinned call (P-G11). The stack builds the value with the 40-hex SHA. If the probe shows a `refs/...` form instead, **stop** and share it: the template must change, do not guess |
| `ref` | Stack parameter `GitHubBoundRef`, which must equal `CICD_BOUND_REF` |
| `repository_id`, `repository_owner_id`, `environment`, `aud` | The matching stack parameters; `aud` is `sts.amazonaws.com` |

4. Afterwards: update the stack to `PinnedWorkflowSha = <R8_COMMIT_SHA>` (the platform `main` commit that contains task R-8; the changeset shows a single `Modify` on `CiRole`), point the caller back to `@<R8_COMMIT_SHA>`, and delete `<PROBE_BRANCH>`.

The output reveals repository identifiers and, through the role ARN, the account id: keep the log private and share it sanitized. The token itself is masked and the assumed credentials are discarded. Claude did not run this.

Option B (after a failure): list the denied attempts in CloudTrail (event history is regional):

```powershell
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity --max-results 10 --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected: events with an `errorCode` such as `AccessDenied` and no condition name. Use Option A to find which claim differs.

Record the observed `sub` and `job_workflow_ref` in your evidence notes. AC-02 V1: `ci.workflowRef` is recorded on the execution for audit only (V1-R2); it is not compared.

## 8. Trigger the run (B2 positive path)

Prerequisites: section 7 passed, the stack pins `<R8_COMMIT_SHA>`, the caller calls `@<R8_COMMIT_SHA>`, and the Executor is running ([05](05-run-executor-node22.md)).

The run goes through two stages. Neither opens SSH.

**Stage 1, no target record yet.** Do not register `<OWNER_TARGET_ID>` yet. Run the workflow (**Run workflow** on `<BOUND_BRANCH>`). Expected: `guard` and `push-and-send` green (bound ref, OIDC, build, push, one send), then the Executor rejects the request with `TARGET_UNKNOWN`: the CI sender was authorized, the registry was read, nothing was claimed or locked ([07](07-verification.md), B2).

**Stage 2, target registered with `deployWindowPolicy: required`.** Register the target with the tool ([09](09-target-registry.md)); its `sourceRepositoryId` is this repository's id (section 1). **Stop if** the record says `not-required` or a deploy window is open: an accepted request would then go on to a real SSH deployment. Run the workflow again. Expected: the request is **accepted** (the `SenderId` session suffix equals `sourceRepositoryId`, option A), an execution is created and ends `FAILED` with `DEPLOY_WINDOW_CLOSED` at the first window check, before any lock, credential read or SSH ([07](07-verification.md), B2).

1. Open the Actions tab, select the workflow, **Run workflow** on `<BOUND_BRANCH>`.
2. Watch the jobs: `ci`, then the reusable `guard`, then `push-and-send`.

Expected: all green. In the `push-and-send` log: bound ref check passes, OIDC succeeds (the role ARN and account id are visible in the log by design), the image is built and pushed, the request is sent.

**Public-safe log check (P-G14).** Search the whole job log for the registry host and the queue URL. The role ARN and the 12-digit account id are expected to appear (non-secret variable; accepted).

Masking of the registry host and queue URL is log hygiene only: both are built from the account id, which is already public with the role ARN (G-10). Record whether they appear masked (`***`); that is not a stop condition.

**Stop if** any credential-like value appears (an access key, a secret key, a token). Delete the run logs (repository, Actions, the run, Delete all logs), report it and do not continue.

If `sts:AssumeRoleWithWebIdentity` is denied: use section 7. If `guard` fails: the event was not `push` or `workflow_dispatch`, or an input is invalid. If `Enforce bound ref` fails: `CICD_BOUND_REF` is empty or not equal to `refs/heads/<BOUND_BRANCH>`.

## 9. Negative checks: untrusted triggers (B2)

Goal: `pull_request`, `pull_request_target` and `workflow_run` can neither assume the role nor enqueue a request. For each, use a **throwaway copy** of the caller with only the `on:` line changed to the trigger, run it, then delete the copy.

> **Warning.** `pull_request_target` and `workflow_run` read the workflow file from the **default branch**, so a throwaway branch cannot exercise them: the test file has to exist on the default branch for the trigger to fire. Remove it **immediately** after the test and never leave it there. `pull_request` can use a feature branch. Use a repository with nothing else deployable on its default branch if you can.


| Trigger | How to fire it | Expected |
|---|---|---|
| `pull_request` | Open a PR from a feature branch | `guard` fails with "event not allowed for deploy requests"; `push-and-send` never starts |
| `pull_request_target` | Same, with the file present on the default branch | Same |
| `workflow_run` | Add a trivial workflow that this one listens to, and run it | Same |

Then confirm no queue effect and no role assumption:

```powershell
aws sqs get-queue-attributes --queue-url <DEPLOY_QUEUE_URL> --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected: unchanged counts (the Executor consumes quickly, so also check that the Executor log shows no new request). What blocks each trigger differs. `pull_request` runs on a `refs/pull/...` ref, so the Environment deployment branch rule would also block it. For `pull_request_target` and `workflow_run`, `github.ref` is the default branch: if that is your bound branch, the branch rule and the bound-ref check pass and the `sub` keeps the environment form, so the **`guard` job is the only control** that stops them. That is why this negative test matters.

**Stop if** any of these runs reaches `push-and-send` or obtains AWS credentials. Disable the caller workflow and report it.

## 10. Negative check: a repository that is not the target's source (option A, B2)

Goal: a request from a repository other than the record's `sourceRepositoryId` is rejected with `TARGET_NOT_AUTHORIZED` and changes no target state. Only one repository is trusted by the CI role (do **not** add a second one before this section and section 7 pass), so the test changes the record's source instead of using another repository.

1. Read the record and note its `version` `<N>` and its `sourceRepositoryId` ([09](09-target-registry.md), `get`).
2. Note the target state before: `TARGET#<OWNER_TARGET_ID>` / `STATE` and `DEPLOYMENT#<OWNER_TARGET_ID>` / `SEQ` ([07](07-verification.md)).
3. Copy the record file to `executor/.local/targets/<OWNER_TARGET_ID>-srccheck.json`, set its `sourceRepositoryId` to the numeric id of **another real repository you own** (for example the platform repository: `gh api repos/<GITHUB_ORG>/<PLATFORM_REPO> --jq .id`), and write it from version `<N>`:

   ```bash
   tools/target-registry put --file executor/.local/targets/<OWNER_TARGET_ID>-srccheck.json --updated-by <YOUR_NAME> \
     --secret-id-prefix <SECRET_ID_PREFIX> --registry-table <REGISTRY_TABLE_NAME> --region <AWS_REGION> \
     --profile <AWS_PROFILE_ADMIN> --expected-version <N> --checklist-confirmed
   ```
4. Run the caller workflow once.
5. Restore the record: run the same `put` with the original file `executor/.local/targets/<OWNER_TARGET_ID>.json` and `--expected-version <N+1>`.

Expected: a `REJECT#MSG#<SQS_MESSAGE_ID>` item with reason `TARGET_NOT_AUTHORIZED`; no `DEDUPE#<OWNER_TARGET_ID>#<REQUEST_ID>` item for that run; `TARGET#…/STATE`, `DEPLOYMENT#…/SEQ` unchanged; no `LOCK#` or `WINDOW#` item; no execution. **Stop if** the request is accepted: option A is not enforced; share the evidence. Confirm step 5 with `get` (the original `sourceRepositoryId`, version `<N+2>`).

Delete every throwaway workflow afterward.

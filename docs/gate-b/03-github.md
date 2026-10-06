<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §3 (B2), §6, §12; design DD-24, DD-29 -->
# 03. GitHub: Environment, values, caller workflow, OIDC checks (B2)

**Answer first.** In your chosen repository `<GITHUB_ORG>/<APP_REPO>` you create one Environment
`<GITHUB_ENVIRONMENT>` holding exactly **one secret** (`CICD_ROLE_ARN`) and **four variables**,
add the caller workflow on the bound branch, and trigger it with `workflow_dispatch`. AWS
authentication is OIDC only. **Never store an AWS access key or secret access key in GitHub (or
anywhere).** No application repository is changed by Claude; you pick the repository and branch.

## Value classification (plan section 12)

| Value | Class | Source | Notes |
|---|---|---|---|
| `CICD_ROLE_ARN` | **Environment secret** (the only one) | Stack output `CiRoleArn` | Not a credential, but it embeds the account id; a secret is the only way GitHub masks it in logs |
| `CICD_AWS_REGION` | Environment variable | `<AWS_REGION>` (your choice) | |
| `CICD_ECR_REPOSITORY` | Environment variable | Repository **name** only: last segment of stack output `CiEcrRepositoryArn` | No account id |
| `CICD_DEPLOY_QUEUE_NAME` | Environment variable | Stack output `DeployQueueName` | Name only; the URL is derived |
| `CICD_BOUND_REF` | Environment variable, **admin-only** | Your choice: the full ref `refs/heads/<BOUND_BRANCH>` | The one ref allowed to deploy; fail closed when empty |
| Account id, registry host, queue URL | **Derived after OIDC**, masked before use | `sts get-caller-identity`, registry login output, `sqs get-queue-url` | Never stored in GitHub |
| Environment name, deployment branch rules, branch protection, required reviewers | Repository / Environment **configuration** | You | Not values |
| `deploymentId`, `environment`, `units` | Caller workflow **inputs** | In the caller file | Non-sensitive |

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

## 3. Set the secret and the variables on the Environment

UI: Environment page, **Environment secrets** and **Environment variables**. Or with `gh` (it prompts for the secret so the value never enters shell history):

```powershell
gh secret set CICD_ROLE_ARN --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO>
gh variable set CICD_AWS_REGION --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO> --body "<AWS_REGION>"
gh variable set CICD_ECR_REPOSITORY --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO> --body "<ECR_REPOSITORY>"
gh variable set CICD_DEPLOY_QUEUE_NAME --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO> --body "<DEPLOY_QUEUE_NAME>"
gh variable set CICD_BOUND_REF --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO> --body "refs/heads/<BOUND_BRANCH>"
```

Verify (names only, no values for the secret):

```powershell
gh secret list --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO>
gh variable list --env <GITHUB_ENVIRONMENT> --repo <GITHUB_ORG>/<APP_REPO>
```

Expected: one secret (`CICD_ROLE_ARN`) and four variables.

**Stop if** you find any AWS access key or secret key stored anywhere in the repository or Environment. Remove it; the model is OIDC only.

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
2. Replace every placeholder named in the file header: `<GITHUB_ORG>/<PLATFORM_REPO>`, `<PINNED_COMMIT_SHA>`, `<BOUND_BRANCH>`, `<OWNER_DEPLOYMENT_ID>`, `<GITHUB_ENVIRONMENT>`, the units, and the lint/test step.
3. `<PINNED_COMMIT_SHA>` must be a full 40-hex commit SHA, never a tag or branch, and **must equal** the stack parameter `PinnedWorkflowSha`. Moving the pin means changing the stack (and the trust policy) in the same change.
4. The caller passes no secrets (no `secrets:` key, no `secrets: inherit`).

Expected: `workflow_dispatch` is available on the Actions tab for this workflow.

## 7. P-G11 and P-G10: record the real claims

The CI role trust compares exact strings. If a claim differs, `AssumeRoleWithWebIdentity` is denied, and **the failure is silent**: the workflow step only reports a generic "not authorized", and no condition is named. Recording the real claims first avoids chasing it.

Option A (recommended, before the first real run): in a **private** sandbox, publish this throwaway reusable workflow in the platform repository as `.github/workflows/claims-probe.reusable.yml`, call it from a throwaway caller on `<BOUND_BRANCH>` with the same Environment and the same SHA-pinned form as the real caller, run it with `workflow_dispatch`, then delete both files.

```yaml
name: claims-probe
on:
  workflow_call:
    inputs:
      environment:
        type: string
        required: true
permissions: {}
jobs:
  probe:
    runs-on: ubuntu-24.04
    environment: ${{ inputs.environment }}
    permissions:
      id-token: write
    steps:
      - name: Print selected claims
        run: |
          set -euo pipefail
          token="$(curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)"
          printf '%s' "$token" | jq -R 'split(".")[1] | gsub("-";"+") | gsub("_";"/") | . + ("=" * ((4 - length % 4) % 4)) | @base64d | fromjson | {aud,sub,repository_id,repository_owner_id,environment,job_workflow_ref,event_name,ref}'
```

Expected: a JSON object. Compare with the stack:

| Claim | Must equal |
|---|---|
| `sub` | Stack parameter `GitHubOidcSub` (P-G10; expected default form `repo:<GITHUB_ORG>/<APP_REPO>:environment:<GITHUB_ENVIRONMENT>`) |
| `job_workflow_ref` | `<GITHUB_ORG>/<PLATFORM_REPO>/.github/workflows/deploy-request.reusable.yml@<ref form>` where `<ref form>` is what the probe shows for the SHA-pinned call (P-G11). The stack builds the value with the 40-hex SHA. If the probe shows a `refs/...` form instead, **stop** and share it: the template must change, do not guess |
| `repository_id`, `repository_owner_id`, `environment`, `aud` | The matching stack parameters; `aud` is `sts.amazonaws.com` |

The decoder pads the base64 itself and needs a jq with `@base64d` (1.6 or later, preinstalled on the Ubuntu runner). The output reveals repository identifiers: keep it private and share it only sanitized. Claude did not run this; it is a documented diagnostic.

Option B (after a failure): list the denied attempts in CloudTrail (event history is regional):

```powershell
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity --max-results 10 --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected: events with an `errorCode` such as `AccessDenied` and no condition name. Use Option A to find which claim differs.

Record the observed `sub`, `job_workflow_ref` and the source-binding `workflowRef` form (gap G-4: exact equality with the request's `ci.workflowRef`, `CONSISTENCY_MISMATCH` otherwise) in your evidence notes.

## 8. Trigger the run (B2 positive path)

**Stop if** your target definition says `deployWindowPolicy: not-required` or a deploy window is open: do not trigger the workflow (a real SSH deployment would follow; see [04](04-definitions-and-target.md)).

1. Open the Actions tab, select the workflow, **Run workflow** on `<BOUND_BRANCH>`.
2. Watch the jobs: `ci`, then the reusable `guard`, then `push-and-send`.

Expected: all green. In the `push-and-send` log: bound ref check passes, the role ARN's account segment is masked, OIDC succeeds, the image is built and pushed, the request is sent. Then in the Executor log: a message acknowledged and an execution accepted (see [07](07-verification.md)); with the window closed it ends `FAILED (DEPLOY_WINDOW_CLOSED)` and never opens SSH.

**Public-safe log check (P-G14).** Search the whole job log for your 12-digit account id, the registry host and the queue URL.

**Stop if** any of them appears unmasked. Delete the run logs (repository, Actions, the run, Delete all logs), report it and do not continue; Environment value visibility in a called workflow (P-G14) is exactly what this observes.

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

Delete every throwaway workflow afterward.

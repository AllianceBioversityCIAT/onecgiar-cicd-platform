<!-- @akili-spec changes/cicd-executor-poc gate-b-plan §6; infra/sam/template.yaml (DeletionPolicy) -->
# 08. Teardown (optional)

**Answer first.** Remove things in this order: stop the Executor, check the schedule is still
disabled, optionally purge the queues, delete the stack, delete the secrets with a recovery
window, remove the GitHub configuration, clean the target, then delete the local files. The OIDC
provider is **retained** when this stack created it; remove it by hand only if nothing else uses
it. Nothing here was run by Claude.

Use `--profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>` on every `aws` command (omitted below for brevity).

## 1. Stop the Executor

Press Ctrl+C in the Executor console ([05](05-run-executor-node22.md), section 7).

Expected: `executor stopping`, then the process exits.

**Stop if** the process does not exit within a minute. Close the window; any in-flight message stays on the queue and is deleted with it.

## 2. The schedule stays disabled

```powershell
aws scheduler get-schedule --name cicd-reconcile-dev --query State --output text
```

Expected: `DISABLED`. Do not enable it (blocked by G-8). The stack deletion removes it.

## 3. Optional: purge the queues

Only if you want to discard pending messages before deleting (deletion discards them anyway):

```powershell
aws sqs purge-queue --queue-url <DEPLOY_QUEUE_URL>
aws sqs purge-queue --queue-url <DLQ_URL>
```

Expected: no output. A queue can be purged once per 60 seconds.

## 4. Delete the stack

```powershell
sam delete --stack-name cicd-poc-dev --region <AWS_REGION> --profile <AWS_PROFILE_ADMIN>
```

Alternative with the CLI only:

```powershell
aws cloudformation delete-stack --stack-name cicd-poc-dev
aws cloudformation wait stack-delete-complete --stack-name cicd-poc-dev
```

Expected: the stack disappears. The queues, DLQ, state table `cicd-executions-<stage>` (`DeletionPolicy: Delete`), log group, alarms, schedule, roles and the optional probe repository (emptied on delete) are removed. The OIDC provider is **not** removed when this stack created it (`DeletionPolicy: Retain`); see section 9. The Target Registry table `cicd-registry-<stage>` (AC-02, task R-2) is also **retained** (`DeletionPolicy: Retain`): it holds configuration, and deleting it is a separate, deliberate owner action after confirming nothing needs its records. Before re-creating the stack with the same `Stage`, either delete the retained table or import it into the new stack (CloudFormation resource import); otherwise the create fails because `cicd-registry-<stage>` already exists.

**Stop if** the stack ends in `DELETE_FAILED`. List the cause:

```powershell
aws cloudformation describe-stack-events --stack-name cicd-poc-dev --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceStatusReason]" --output table
```

Share it before retrying. If you used your own ECR repository (`CiEcrRepositoryArn`), the images CI pushed (`ci-<unit>-<RUN_ID>-<ATTEMPT>` tags) remain in it; delete them yourself if wanted.

### The extra SAM stack (because `resolve_s3 = true`)

`sam deploy` created a second stack `aws-sam-cli-managed-default` with a staging bucket ([01](01-aws-sam.md), "Why `resolve_s3` stays"). Remove it only if **no other SAM project** in this account and region uses it:

```powershell
aws cloudformation describe-stacks --stack-name aws-sam-cli-managed-default --query "Stacks[0].Outputs" --output table
```

Take the bucket name from the output (the SAM source bucket, `<SAM_MANAGED_BUCKET>`) and check what it holds and whether it outlived its stack:

```powershell
aws s3 ls s3://<SAM_MANAGED_BUCKET> --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
aws s3 ls --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>
```

Expected: only your `cicd-poc-dev` template objects (second command: the bucket is listed). Empty it (S3 console "Empty bucket", which also removes object versions, or `aws s3 rm s3://<SAM_MANAGED_BUCKET> --recursive` plus deleting versions if versioning kept any), then delete the stack:

```powershell
aws cloudformation delete-stack --stack-name aws-sam-cli-managed-default
aws cloudformation wait stack-delete-complete --stack-name aws-sam-cli-managed-default
```

Expected: the stack and bucket disappear. If it fails because the bucket is not empty, empty it and retry. If the stack is already gone but the bucket remains (`aws s3 ls` still lists it), empty it as above and remove it with `aws s3 rb s3://<SAM_MANAGED_BUCKET> --profile <AWS_PROFILE_ADMIN> --region <AWS_REGION>`.

## 5. Delete the secrets (with a recovery window)

List what exists under your prefix, review it, then delete each one:

```powershell
aws secretsmanager list-secrets --filters Key=name,Values=<SECRET_ID_PREFIX> --query "SecretList[].Name" --output text
aws secretsmanager delete-secret --secret-id "<SECRET_ID_PREFIX><REF_NAME>" --recovery-window-in-days 7
```

Expected: a `DeletionDate` about 7 days ahead. Repeat per secret. During the recovery window the name cannot be reused (`aws secretsmanager restore-secret` undoes it). Use `--force-delete-without-recovery` only if you are sure and need the name immediately.

**Stop if** the list contains a name you did not create. Delete only your own.

## 6. Remove the GitHub configuration

In `<GITHUB_ORG>/<APP_REPO>`:

1. Remove the caller workflow file from `<BOUND_BRANCH>` (through your normal pull request) and any throwaway test or claims-probe workflow and branch. In `<GITHUB_ORG>/<PLATFORM_REPO>` remove `claims-probe.reusable.yml` if it still exists.
2. Delete the Environment. This also deletes its five variables (including `CICD_ROLE_ARN`): **Settings, Environments, `<GITHUB_ENVIRONMENT>`, Delete environment**, or `gh api --method DELETE repos/<GITHUB_ORG>/<APP_REPO>/environments/<GITHUB_ENVIRONMENT>`.
3. Revert any branch-protection change you made only for this run.
4. Verify: `gh secret list --repo <GITHUB_ORG>/<APP_REPO>` and `gh variable list --repo <GITHUB_ORG>/<APP_REPO>` show nothing from this kit.

## 7. The target

On `<TARGET_HOST>`, as the deploy user:

```bash
rm -f -- "${TMPDIR:-/tmp}/cicd-probe.lock" target-probe.sh
ls -d /tmp/cicd-* 2>/dev/null
```

Expected: the probe lock and script are gone; the `ls` lists leftover per-execution directories from B5 (if any); remove those you recognize. Also remove the per-`lockKey` local mutex file in the deploy user's directory, and stop and remove any container the B5 deployment started (the Executor never removes them).

Remove the deploy user's authorized key line that you added for the Executor (`~/.ssh/authorized_keys`), or delete the deploy user if it was created only for this run. Existing keys used by other tools are never touched.

## 8. Local files

Remove the local data and the profiles:

```powershell
Remove-Item -Recurse -Force executor/.local
```

This deletes the portable Node 22, the definitions root, `executor.env`, the local samconfig, any secret value files and logs. The isolated Executor AWS files under `executor/.local/aws/` go with it; first delete the dedicated Executor principal as in [05](05-run-executor-node22.md) section 3.9 (access key, inline policy, user). Remove the `[profile <OPERATOR_PROFILE_NAME>]` section from `~/.aws/config`, and any scratch host-key files. Confirm `git status` shows no changes from this run.

## 9. The GitHub OIDC provider

A retained provider has one consequence for redeploys: after a teardown (or a failed first create that made the provider), deploy again with `ExistingGitHubOidcProviderArn` set to the existing provider ARN (`aws iam list-open-id-connect-providers --profile <AWS_PROFILE_ADMIN>`), otherwise creating a second provider for the same URL fails ([01](01-aws-sam.md)).

- If you passed `ExistingGitHubOidcProviderArn`, the provider was never managed by the stack: **leave it**.
- If the stack created it, `DeletionPolicy: Retain` kept it so other roles relying on it keep working. Remove it **only if nothing else uses it**. Look for other roles that trust it:

  ```powershell
  aws iam list-roles --query "Roles[?contains(to_string(AssumeRolePolicyDocument), 'token.actions.githubusercontent.com')].RoleName" --output text
  ```

  Expected for safe removal: no output (the kit's CI role is already gone). If anything is listed, keep the provider. Otherwise:

  ```powershell
  aws iam delete-open-id-connect-provider --open-id-connect-provider-arn <OIDC_PROVIDER_ARN>
  ```

  A later redeploy of this stack with an empty `ExistingGitHubOidcProviderArn` then creates it again.

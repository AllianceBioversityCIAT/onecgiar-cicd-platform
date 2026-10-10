<!-- @akili-spec changes/cicd-executor-poc owner decision D2 (2026-10-10, multi-repository CI); design DD-24, DD-25 -->
# 10. Add a repository to the platform (multi-repository CI)

**Answer first.** Each repository gets **its own CI role** from `infra/sam/ci-repository-role.yaml`
(one stack per repository). The platform's own repository keeps the main stack's `CiRole` unchanged.
Adding a repository never replaces another one's authorization.

| Layer | Isolation |
|---|---|
| IAM trust (per role) | Exact `StringEquals` on `aud`, `repository_id`, `repository_owner_id`, `environment`, `ref`, `sub`, `job_workflow_ref` (reusable workflow at a pinned SHA) and `sts:RoleSessionName` = `repository_id` |
| Deploy queue policy | Only the platform roles plus the roles listed in `AdditionalCiRoleArns` may send; everyone else is denied |
| Executor sender check | `CICD_CI_REPOSITORY_BINDINGS`: a bound role is accepted only for its own `repository_id` (`SESSION_REPOSITORY_MISMATCH` otherwise) |
| Target check (unchanged) | The target record's `sourceRepositoryId` must equal the sender's `repository_id` |

All steps are owner actions with the administrative profile, after asserting the account is
`<AWS_ACCOUNT_ID>`. Nothing here has been executed.

## 1. Repository role stack (change set first)

```bash
aws cloudformation deploy --region <AWS_REGION> \
  --template-file infra/sam/ci-repository-role.yaml \
  --stack-name cicd-ci-<REPOSITORY_SLUG>-<STAGE> \
  --capabilities CAPABILITY_IAM --no-execute-changeset \
  --tags Project=ONECGIAR-CICD-Platform \
  --parameter-overrides \
    Stage=<STAGE> \
    GitHubRepositoryId=<GITHUB_REPOSITORY_ID> \
    GitHubRepositoryOwnerId=<GITHUB_OWNER_ID> \
    GitHubEnvironment=<CD_ENVIRONMENT> \
    GitHubOidcSub=<ENVIRONMENT_FORM_SUB> \
    GitHubBoundRef=refs/heads/<BOUND_BRANCH> \
    PlatformWorkflowRepository=<GITHUB_ORG>/<PLATFORM_REPO> \
    PinnedWorkflowSha=<PINNED_COMMIT_SHA_40_HEX> \
    GitHubOidcProviderArn=<OidcProviderArn output> \
    DeployQueueArn=<DeployQueueArn output>
```

Review the change set (one `AWS::IAM::Role` added), execute it, then read the outputs `RoleArn` and
`RoleId`. `GitHubOidcSub`: read the repository's OIDC subject template
(`gh api repos/<GITHUB_ORG>/<REPO>/actions/oidc/customization/sub`): classic form unless
`use_immutable_subject` is true.

## 2. Main stack: allow the role on the deploy queue

Update the main stack with **only** `AdditionalCiRoleArns=<RoleArn>[,<RoleArn>...]` (every other parameter
`UsePreviousValue`). Review the change set: the expected change is `Modify DeployQueuePolicy` only;
`CiRole` and every other resource must stay untouched. Execute, then read the queue policy back.

## 3. Executor binding

1. Create the secret `<SECRET_ID_PREFIX><CI_PRINCIPAL_REPOSITORY_NAME>` with the value `RoleId`.
2. Add to the Executor env file: `CICD_CI_REPOSITORY_BINDINGS=<GITHUB_REPOSITORY_ID>=<CI_PRINCIPAL_REPOSITORY_NAME>`
   (comma-separated for several repositories).
3. Restart the Executor; startup fails closed if the reference does not resolve or collides with another role.

## 4. Repository side

GitHub Environment `<CD_ENVIRONMENT>`: deployment branch `<BOUND_BRANCH>` only, no required reviewers
(owner decision D1), variables `CICD_BOUND_REF=refs/heads/<BOUND_BRANCH>`, `CICD_ROLE_ARN=<RoleArn>`,
`CICD_AWS_REGION`, `CICD_DEPLOY_QUEUE_NAME`, and `CICD_ECR_REPOSITORY` only if the caller sends `units`.
The caller calls the reusable workflow at exactly `<PINNED_COMMIT_SHA_40_HEX>`.

## 5. Target

Register the target with `sourceRepositoryId=<GITHUB_REPOSITORY_ID>` (runbook 09).

## Removing a repository

Remove its ARN from `AdditionalCiRoleArns`, its entry from `CICD_CI_REPOSITORY_BINDINGS`, then delete its
role stack. Other repositories are not affected.

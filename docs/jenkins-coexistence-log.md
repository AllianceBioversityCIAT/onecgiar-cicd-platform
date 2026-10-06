# Jenkins Coexistence Log — Template

<!-- @akili-spec changes/cicd-executor-poc design DD-21, §12, §12.1, §12.2; requirements FR-18; proposal §12 -->

Record of every deploy-test window opened against a target shared with Jenkins
(`deployWindowPolicy: required`, e.g. `<PRMS_REPORTING_DEV_TARGET>`). One row per window.
Append rows; do not edit or delete past rows — this is the audit trail FR-18 requires
("keep a record of each window").

**Publication policy:** job identifiers are logged as the opaque references already used in
the Target Registry (`externalDeployersRef`'s resolved list — e.g. `<JENKINS_JOB_ID>`), never
real Jenkins job names, and no host, account, or credential identifier appears in this file.

## When to add a row

- Every time a deploy window is opened and closed (design DD-21, `docs/runbook.md`'s
  "Deploy windows: open and close").
- Every time the §12.1 stale-mutex runbook procedure results in an operator intervention on a
  Jenkins-shared target, even outside a formally opened window (`docs/runbook.md`'s "Stale
  local mutex" decision table: "after any intervention, record it here").
- Every time a `UNKNOWN_TARGET_STATE` resolution is recorded with the operator CLI (`docs/runbook.md`
  §12.2 step 6): put the `executionId`, the observed digests (logical names only) and the actor
  in the Incidents column of the window it belongs to, or in a row of its own if no window is open.

## Log

| Target | Opened (UTC) | Opened by | Closed (UTC) | Close reason | Disabled jobs (`externalDeployers`) | Executions within the window | Migration state before / after | DB snapshot taken | Incidents |
|---|---|---|---|---|---|---|---|---|---|
| `prms-reporting-dev` | `<YYYY-MM-DDThh:mm:ssZ>` | `<operator>` | `<YYYY-MM-DDThh:mm:ssZ>` | `MANUAL` \| `EXPIRED` | `<JENKINS_JOB_ID>`, `<JENKINS_JOB_ID>`, … (must cover every entry the registry declares for this target) | `<executionId>`, `<executionId>`, … | Before: `<migration:check:ci output, read-only>` / After: `<migration:check:ci output, read-only>` | `yes (<snapshotRef>)` \| `no` | `none` \| free text (e.g. "stale mutex, no migration in progress, script terminated per §12.1") |

*(Delete this example row before the first real entry; keep the header. The example's Target
cell uses `prms-reporting-dev`, the registry's `targetId` — see Column notes.)*

## Column notes

| Column | Source |
|---|---|
| Target | The registry's `targetId` (e.g. `prms-reporting-dev`), not a raw hostname |
| Opened / Closed | When the `DEPLOY_WINDOW_OPEN_REQUESTED` / `*_CLOSE_REQUESTED` event was accepted, or when the reconciler auto-closed it |
| Opened by | The `openedBy` value required to open the window (design §7.7) |
| Close reason | `MANUAL` (operator closed it) or `EXPIRED` (reconciler closed it at `closesAt`, max 8 h after opening) — matches the `WINDOW` item's `closedReason` in DynamoDB |
| Disabled jobs | The exact `externalJobsDisabled[]` list supplied when opening; must cover every `externalDeployers` entry declared for that target or the window is rejected at open time |
| Executions within the window | Every `executionId` that attempted a deploy on this target while the window was open, whether it succeeded, failed, or was skipped |
| Migration state before / after | `migration:check:ci` run in **read-only mode** and its output recorded once before the first test in the window and once after each test (design §12 "Shared DEV DB", P-24 mitigation; FR-18's "record of each window") — procedural, not a technical guard: neither the distributed lock nor the local mutex cover concurrent migrations from Jenkins variants against the same DB |
| DB snapshot taken | Whether a DEV DB snapshot was taken before the first test in this window (design §12, P-24); `yes` with its reference, or `no` with a reason if the window had no migration-bearing test |
| Incidents | Anything abnormal: a stale-mutex intervention (§12.1), an `UNKNOWN_TARGET_STATE` resolution (§12.2), a `windowClosedDuringRun` notification, a discrepancy between DynamoDB's target state and the image actually running, etc. `none` if the window was uneventful |

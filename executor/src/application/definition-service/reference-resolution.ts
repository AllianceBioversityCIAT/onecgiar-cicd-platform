// @akili-spec changes/cicd-executor-poc design DD-23, DD-25, DD-27, §6.2, §6.3, §7.7 (amended 2026-10-05); requirements NFR-01, NFR-02; owner ruling (execution.md 2026-10-05)
// Logical-reference discovery (via an explicit ALLOWLIST of fields — never a
// generic "every <UPPER_SNAKE> string" walk) and resolution. The registry and
// deployment definitions carry ONLY logical references (DD-23's `<XXX>`
// placeholders) — never inline secrets. At startup, every reference the
// EXECUTOR ITSELF needs must resolve via SecretProvider; an unresolved
// reference aborts the Executor.
//
// NFR-01 boundary: `containers[].envSecretRef` and the deployment `runtimeSecretRefs` values are deliberately EXCLUDED from
// every allowlist below. Design §6.4 is explicit about it: `--runtime-secret
// <container>=<secretRef>` travels to deploy-container.sh as an opaque
// reference, and "the target resolves it with its own permissions (OD-Q5)" —
// it is the APPLICATION's own runtime secret. If the Executor resolved it at
// startup, it would need IAM read access to application secrets just to
// boot, which is exactly what NFR-01 ("MUST NOT read application secrets")
// forbids. A prior version of this module collected every
// logical-reference-shaped string anywhere in the document (including
// envSecretRef) — that is the bug this allowlist replaces.
//
// Owner ruling (execution.md 2026-10-05, "existence without reading"): CREDENTIAL
// references are a THIRD category, disjoint from both of the above —
// `notifications.slack.tokenRef` and the Target
// Registry's `credentialRef` (SSH key/password) are never passed to
// `getSecret` here; definition-service is PROHIBITED from reading secret
// values (design §7 definition-service row). They are only EXISTENCE-checked
// (see `collect*ExistenceOnlyRefs` and `checkAllReferencesExist` below) — a
// missing one still aborts startup, naming only the ref.

import type { SecretProvider } from "../../ports/secret-provider.js";

/** Exactly the `logicalRef` shape used across schemas/*.schema.json: `<UPPER_SNAKE>`. */
const LOGICAL_REF_PATTERN = /^<[A-Z][A-Z0-9_]*>$/;

export function isLogicalRef(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_REF_PATTERN.test(value);
}

function addIfLogicalRef(value: unknown, acc: Set<string>): void {
  if (isLogicalRef(value)) acc.add(value);
}

/**
 * Target Registry reference fields the Executor itself resolves BY VALUE at
 * startup (all non-sensitive identifiers — owner ruling, execution.md
 * 2026-10-05): `connectionRef` (host identity JSON, no credential —
 * `parseResolvedConnection` rejects one if present), `hostKeyRef` (an SSH
 * host key is PUBLIC material), `externalDeployersRef` (deploy-window
 * coverage, §7.7), and per-container `name` (resolved for the
 * duplicate-name check — FR-02), `imageRepositoryRef` and `portRef`.
 * `containers[].envSecretRef` is NOT included — see module doc. The
 * registry's `credentialRef` (SSH credential) is NOT included either — it is
 * existence-checked only, see `collectRegistryExistenceOnlyRefs`.
 */
export function collectRegistryAllowlistedRefs(
  entries: Readonly<Record<string, Record<string, unknown>>>,
  acc: Set<string> = new Set(),
): Set<string> {
  for (const entry of Object.values(entries)) {
    addIfLogicalRef(entry.connectionRef, acc);
    addIfLogicalRef(entry.hostKeyRef, acc);
    addIfLogicalRef(entry.externalDeployersRef, acc);
    const containers = Array.isArray(entry.containers) ? entry.containers : [];
    for (const raw of containers) {
      if (!raw || typeof raw !== "object") continue;
      const container = raw as Record<string, unknown>;
      addIfLogicalRef(container.name, acc);
      addIfLogicalRef(container.imageRepositoryRef, acc);
      addIfLogicalRef(container.portRef, acc);
      // container.envSecretRef: intentionally excluded (NFR-01, design §6.4 OD-Q5).
    }
  }
  return acc;
}

/**
 * Target Registry CREDENTIAL reference: `credentialRef` (the SSH key or
 * password used to connect — read only by the SSH handler at use time, see
 * design §7.5). Owner ruling (execution.md 2026-10-05): definition-service
 * only checks that it EXISTS, never reads its value.
 */
export function collectRegistryExistenceOnlyRefs(
  entries: Readonly<Record<string, Record<string, unknown>>>,
  acc: Set<string> = new Set(),
): Set<string> {
  for (const entry of Object.values(entries)) {
    addIfLogicalRef(entry.credentialRef, acc);
  }
  return acc;
}

/**
 * Deployment Definition reference fields the Executor itself resolves BY
 * VALUE at startup. All are non-sensitive IDENTIFIER references (DD-23, DD-25
 * approved 2026-10-06): the bound source (`source.repositoryRef`,
 * `source.workflowRef`, `source.environmentRef`, DD-27), `allowedSenderRef`
 * (resolves to the CI role ID, DD-25), each artifact's `container` and
 * `imageRepositoryRef`, each `health[*].url`, and the Slack `channelRef`.
 * `migration.container` and the `health` / `runtimeSecretRefs` KEYS may be
 * logical container names too, and are resolved as identifiers.
 * `runtimeSecretRefs` VALUES are NEVER collected: they travel to the target as
 * opaque references and the target resolves them with its own permissions
 * (NFR-01, design §6.2, OD-Q5).
 */
export function collectDeploymentAllowlistedRefs(
  deployment: Record<string, unknown>,
  acc: Set<string> = new Set(),
): Set<string> {
  const source = deployment.source as Record<string, unknown> | undefined;
  if (source) {
    addIfLogicalRef(source.repositoryRef, acc);
    addIfLogicalRef(source.workflowRef, acc);
    addIfLogicalRef(source.environmentRef, acc);
  }
  addIfLogicalRef(deployment.allowedSenderRef, acc);

  const artifacts = Array.isArray(deployment.artifacts) ? (deployment.artifacts as unknown[]) : [];
  for (const raw of artifacts) {
    if (!raw || typeof raw !== "object") continue;
    const artifact = raw as Record<string, unknown>;
    addIfLogicalRef(artifact.container, acc);
    addIfLogicalRef(artifact.imageRepositoryRef, acc);
  }

  const migration = deployment.migration as Record<string, unknown> | undefined;
  if (migration) addIfLogicalRef(migration.container, acc);

  const health = deployment.health as Record<string, unknown> | undefined;
  if (health && typeof health === "object") {
    for (const [container, check] of Object.entries(health)) {
      addIfLogicalRef(container, acc);
      if (check && typeof check === "object") addIfLogicalRef((check as Record<string, unknown>).url, acc);
    }
  }

  const runtimeSecretRefs = deployment.runtimeSecretRefs as Record<string, unknown> | undefined;
  if (runtimeSecretRefs && typeof runtimeSecretRefs === "object") {
    for (const container of Object.keys(runtimeSecretRefs)) addIfLogicalRef(container, acc); // keys only, never the values.
  }

  const notifications = deployment.notifications as Record<string, unknown> | undefined;
  const slack = notifications?.slack as Record<string, unknown> | undefined;
  if (slack) addIfLogicalRef(slack.channelRef, acc);

  return acc;
}

/**
 * Deployment Definition CREDENTIAL references: `notifications.slack.tokenRef`
 * (Slack bot token). Existence-only (design DD-23 amendment, owner ruling
 * execution.md 2026-10-05): definition-service never reads the value. There is
 * no git credential in Model B (NFR-01).
 */
export function collectDeploymentExistenceOnlyRefs(
  deployment: Record<string, unknown>,
  acc: Set<string> = new Set(),
): Set<string> {
  const notifications = deployment.notifications as Record<string, unknown> | undefined;
  const slack = notifications?.slack as Record<string, unknown> | undefined;
  if (slack) addIfLogicalRef(slack.tokenRef, acc);
  return acc;
}

/**
 * Platform-config principal references (design DD-25): the Executor's own
 * role, the scheduler and the operator. Non-sensitive identifier references
 * that resolve to role IDs. Where the platform config is stored is NOT
 * specified by the design, so the caller supplies these refs.
 */
export interface PlatformPrincipalRefs {
  /** The CI role shared by the authorized repositories (AC-02 V1, DD-25). */
  readonly ciPrincipalRef: string;
  readonly executorPrincipalRef: string;
  readonly schedulerPrincipalRef: string;
  readonly operatorPrincipalRef: string;
}

export function collectPrincipalRefs(refs: PlatformPrincipalRefs, acc: Set<string> = new Set()): Set<string> {
  addIfLogicalRef(refs.ciPrincipalRef, acc);
  addIfLogicalRef(refs.executorPrincipalRef, acc);
  addIfLogicalRef(refs.schedulerPrincipalRef, acc);
  addIfLogicalRef(refs.operatorPrincipalRef, acc);
  return acc;
}

export class UnresolvedReferenceError extends Error {
  readonly ref: string;
  constructor(ref: string, cause?: unknown) {
    super(
      `unresolved reference at startup: "${ref}" did not resolve via SecretProvider` +
        (cause instanceof Error ? ` (${cause.message})` : ""),
    );
    this.name = "UnresolvedReferenceError";
    this.ref = ref;
  }
}

/**
 * Resolves every given reference via the SecretProvider. Any reference that
 * fails to resolve aborts immediately with a clear, named error — "the
 * Executor does not arrange with an invalid registry" (DD-23).
 */
export async function resolveAllReferences(
  refs: Iterable<string>,
  secretProvider: SecretProvider,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  for (const ref of refs) {
    try {
      resolved.set(ref, await secretProvider.getSecret(ref));
    } catch (cause) {
      throw new UnresolvedReferenceError(ref, cause);
    }
  }
  return resolved;
}

/**
 * Checks every given CREDENTIAL reference EXISTS via the SecretProvider,
 * without ever reading its value (owner ruling, execution.md 2026-10-05).
 * Any reference that does not exist, or whose existence check itself fails,
 * aborts immediately with a clear error naming only the ref — never a
 * resolved value, since none is ever read here.
 */
export async function checkAllReferencesExist(refs: Iterable<string>, secretProvider: SecretProvider): Promise<void> {
  for (const ref of refs) {
    let found: boolean;
    try {
      found = await secretProvider.exists(ref);
    } catch (cause) {
      throw new UnresolvedReferenceError(ref, cause);
    }
    if (!found) {
      throw new UnresolvedReferenceError(ref);
    }
  }
}

/**
 * `externalDeployersRef` resolves to an opaque list of external-deployer
 * identifiers (design §7.7/DD-21: opaque lists). SecretProvider only
 * contracts a single string per reference, so the list travels as a JSON
 * array of strings in that resolved value. The resolved value is the real
 * (unpublished, DD-23) external-job list — NEVER echoed into the error
 * message (NFR-02): only the ref is named.
 */
export function parseResolvedExternalDeployers(ref: string, resolvedValue: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolvedValue);
  } catch {
    throw new Error(`resolved externalDeployers value for "${ref}" is not valid JSON`);
  }
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
    return parsed;
  }
  throw new Error(`resolved externalDeployers value for "${ref}" is not a JSON array of strings`);
}

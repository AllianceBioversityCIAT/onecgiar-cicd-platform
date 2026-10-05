// @akili-spec changes/cicd-executor-poc design DD-23, §6.4, §7.7 (amended 2026-10-05); requirements NFR-01, NFR-02; owner ruling (execution.md 2026-10-05)
// Logical-reference discovery (via an explicit ALLOWLIST of fields — never a
// generic "every <UPPER_SNAKE> string" walk) and resolution. The registry and
// pipeline definitions carry ONLY logical references (DD-23's `<XXX>`
// placeholders) — never inline secrets. At startup, every reference the
// EXECUTOR ITSELF needs must resolve via SecretProvider; an unresolved
// reference aborts the Executor.
//
// NFR-01 boundary: `containers[].envSecretRef` is deliberately EXCLUDED from
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
// `repository.credentialRef`, `notifications.slack.tokenRef` and the Target
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
 * Pipeline Definition reference fields the Executor itself resolves BY VALUE
 * at startup: `repository.url/branch` (git access), the Slack `channel`
 * (notifications), each `source.packages[].path`, and each `lambda` step's
 * `with.function`. These are all non-sensitive identifiers the Executor's
 * own handlers consume directly — never an application secret, and never a
 * credential (see `collectPipelineExistenceOnlyRefs` for those).
 */
export function collectPipelineAllowlistedRefs(
  pipeline: Record<string, unknown>,
  acc: Set<string> = new Set(),
): Set<string> {
  const repository = pipeline.repository as Record<string, unknown> | undefined;
  if (repository) {
    addIfLogicalRef(repository.url, acc);
    addIfLogicalRef(repository.branch, acc);
  }

  const notifications = pipeline.notifications as Record<string, unknown> | undefined;
  const slack = notifications?.slack as Record<string, unknown> | undefined;
  if (slack) {
    addIfLogicalRef(slack.channel, acc);
  }

  const source = pipeline.source as Record<string, unknown> | undefined;
  const packages = Array.isArray(source?.packages) ? (source!.packages as unknown[]) : [];
  for (const pkg of packages) {
    if (pkg && typeof pkg === "object") addIfLogicalRef((pkg as Record<string, unknown>).path, acc);
  }

  const steps = [
    ...(Array.isArray(pipeline.steps) ? (pipeline.steps as unknown[]) : []),
    ...(Array.isArray(pipeline.finally) ? (pipeline.finally as unknown[]) : []),
  ];
  for (const raw of steps) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    if (step.type === "lambda") {
      const withBlock = step.with as Record<string, unknown> | undefined;
      addIfLogicalRef(withBlock?.function, acc);
    }
  }

  return acc;
}

/**
 * Pipeline Definition CREDENTIAL references: `repository.credentialRef` (git
 * access token) and `notifications.slack.tokenRef` (Slack bot token). Owner
 * ruling (execution.md 2026-10-05): definition-service only checks that
 * these EXIST, never reads their value — `repository.url`/`branch` and
 * `slack.channel` are resolved by value instead, see
 * `collectPipelineAllowlistedRefs`.
 */
export function collectPipelineExistenceOnlyRefs(
  pipeline: Record<string, unknown>,
  acc: Set<string> = new Set(),
): Set<string> {
  const repository = pipeline.repository as Record<string, unknown> | undefined;
  if (repository) {
    addIfLogicalRef(repository.credentialRef, acc);
  }

  const notifications = pipeline.notifications as Record<string, unknown> | undefined;
  const slack = notifications?.slack as Record<string, unknown> | undefined;
  if (slack) {
    addIfLogicalRef(slack.tokenRef, acc);
  }

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

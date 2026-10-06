// @akili-spec changes/cicd-executor-poc requirements FR-02; design §7.7 (amended 2026-10-05), DD-21, DD-23
// Semantic rules over the Target Registry that JSON Schema cannot express:
// duplicate ports/container names on the same host, and (startup-only) that
// a resolved `externalDeployers` list is non-empty when the window policy is
// `required`. Schema-level rules (host key presence, the oneOf window-policy
// shapes, migration attestation) already live in schemas/targets.schema.json
// (T-02/T-03) and are NOT reimplemented here.

import type { ValidationIssue } from "./semantic-rules.js";
import { isLogicalRef } from "./reference-resolution.js";

export interface RegistryContainerShape {
  readonly name: string;
  readonly portRef: string;
  /** Position within the entry's `containers` array — used ONLY to build a
   * field path that identifies the colliding container WITHOUT echoing its
   * (possibly resolved, real) name/port into log/error text (NFR-02). */
  readonly index: number;
}

export interface RegistryEntryShape {
  /** Opaque host identity for this call: a logical connectionRef (CI mode) or
   * its resolved value (startup mode). Two entries with the same value are
   * considered to be on the same host — the core never parses what is inside. */
  readonly hostKey: string;
  readonly containers: readonly RegistryContainerShape[];
}

/**
 * FR-02 'port or name conflict': "two registry entries on the same host
 * that publish the same port or the same container name" → rejected,
 * naming both entries. Called once with logical
 * values (CI mode) and once more with resolved values (startup mode) — a
 * collision only observable after resolution (two different logical refs
 * resolving to the same real host/port) is caught by the second call.
 *
 * Error/log text never echoes the actual name/port/host value (NFR-02): at
 * startup those are the real, resolved values (DD-23), so only `targetId`s
 * and a positional field path (`containers[<index>]`) identify the
 * collision — never the container name or port string itself, and never
 * the host identity either.
 */
export function checkDuplicatePortsAndNames(
  entries: Readonly<Record<string, RegistryEntryShape>>,
): ValidationIssue[] {
  const targetIdsByHost = new Map<string, string[]>();
  for (const [targetId, entry] of Object.entries(entries)) {
    const list = targetIdsByHost.get(entry.hostKey) ?? [];
    list.push(targetId);
    targetIdsByHost.set(entry.hostKey, list);
  }

  const issues: ValidationIssue[] = [];
  for (const targetIds of targetIdsByHost.values()) {
    if (targetIds.length < 2) continue; // only one target declared on this host: nothing to collide with.

    const nameOwner = new Map<string, string>();
    const portOwner = new Map<string, string>();
    for (const targetId of targetIds) {
      const entry = entries[targetId];
      if (!entry) continue;
      for (const container of entry.containers) {
        const priorName = nameOwner.get(container.name);
        if (priorName && priorName !== targetId) {
          issues.push({
            rule: "duplicate-container-name",
            field: `${targetId}.containers[${container.index}].name`,
            message: `duplicate container name on the same host: target "${targetId}" conflicts with target "${priorName}"`,
          });
        } else {
          nameOwner.set(container.name, targetId);
        }

        const priorPort = portOwner.get(container.portRef);
        if (priorPort && priorPort !== targetId) {
          issues.push({
            rule: "duplicate-port",
            field: `${targetId}.containers[${container.index}].portRef`,
            message: `duplicate port on the same host: target "${targetId}" conflicts with target "${priorPort}"`,
          });
        } else {
          portOwner.set(container.portRef, targetId);
        }
      }
    }
  }
  return issues;
}

/**
 * design §7.7 (amended 2026-10-05) / DD-23: "At startup the reference is
 * resolved and the list is validated to be non-empty." Schema can only check
 * the FORM (externalDeployersRef present ⇒ deployWindowPolicy=required); it
 * cannot see what the reference resolves to. This is the resolved-value
 * half of that rule, startup-only.
 */
export function checkResolvedExternalDeployersNonEmpty(
  targetId: string,
  policy: "required" | "not-required",
  resolvedList: readonly string[] | undefined,
): ValidationIssue[] {
  if (policy !== "required") return [];
  if (!resolvedList || resolvedList.length === 0) {
    return [
      {
        rule: "external-deployers-empty",
        field: `${targetId}.externalDeployersRef`,
        message: `resolved externalDeployers list is empty for target "${targetId}" (deployWindowPolicy=required): a deploy window cannot cover zero external deployers`,
      },
    ];
  }
  return [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface ResolvedConnection {
  readonly host: string;
  readonly port?: number;
  readonly user?: string;
}

/**
 * Field names that must never appear in a resolved `connectionRef` value.
 * Owner ruling (execution.md 2026-10-05): `connectionRef` carries NON-SENSITIVE
 * identity only (`host`/`port`/`user`); the SSH credential lives in the
 * target's separate, existence-checked-only `credentialRef`. If a resolved
 * connection value carries a credential-looking field, that is a
 * misconfiguration (a credential leaking into the identity secret) and
 * startup must refuse it rather than silently ignore the field.
 */
const CREDENTIAL_LOOKING_KEYS = ["privateKey", "password", "key", "credential", "secret", "token"] as const;

/**
 * DD-23 (amended by owner ruling, execution.md 2026-10-05): `connectionRef`
 * resolves to NON-SENSITIVE identity only — `{"host": "...", "port": ...,
 * "user": "..."}` (port/user optional). The SSH credential is a SEPARATE,
 * existence-checked-only reference (the target's `credentialRef`) — it is
 * never part of this JSON. Host IDENTITY (for the duplicate-port/name check,
 * FR-02) is only the `host` field — grouping by the whole resolved string
 * would wrongly treat two entries on the SAME host with different users as
 * different hosts. If the resolved value carries a credential-looking field
 * anyway (e.g. a misconfigured secret), startup is refused — naming only the
 * ref, never the resolved value, which may itself be a credential.
 */
export function parseResolvedConnection(ref: string, resolvedValue: string): ResolvedConnection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolvedValue);
  } catch {
    throw new Error(`resolved connection value for "${ref}" is not valid JSON (expected {"host": "..."})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`resolved connection value for "${ref}" is not a JSON object (expected {"host": "..."})`);
  }
  const obj = parsed as Record<string, unknown>;
  const credentialLikeKey = CREDENTIAL_LOOKING_KEYS.find((k) => Object.prototype.hasOwnProperty.call(obj, k));
  if (credentialLikeKey) {
    throw new Error(
      `resolved connection value for "${ref}" carries a credential-looking field ("${credentialLikeKey}") — ` +
        `connectionRef must resolve to identity only (host/port/user), never a credential (owner ruling, execution.md 2026-10-05)`,
    );
  }
  if (typeof obj.host !== "string" || obj.host.trim().length === 0) {
    throw new Error(`resolved connection value for "${ref}" is missing a non-empty "host" field`);
  }
  const connection: { host: string; port?: number; user?: string } = { host: obj.host };
  if (typeof obj.port === "number") connection.port = obj.port;
  if (typeof obj.user === "string") connection.user = obj.user;
  return connection;
}

const PORT_MAPPING_PATTERN = /^(\d+):(\d+)$/;

/**
 * design §6.4: `portRef` resolves to the real `--port <container>=<host:container>`
 * mapping. Two entries collide on the same host only when they publish the
 * same HOST port — comparing the whole mapping string (as before) misses
 * `8080:3000` vs `8080:4000`, which both occupy host port 8080.
 */
export function parseResolvedPortMapping(ref: string, resolvedValue: string): { hostPort: string; containerPort: string } {
  const match = PORT_MAPPING_PATTERN.exec(resolvedValue.trim());
  if (!match) {
    throw new Error(`resolved port value for "${ref}" is not a "<host>:<container>" mapping (design §6.4 --port)`);
  }
  return { hostPort: match[1]!, containerPort: match[2]! };
}

/** Extracts the {hostKey, containers} shape from raw (still-unresolved) registry entries, using the logical connectionRef/portRef values as-is (CI mode). */
export function extractLogicalRegistryShape(
  entries: Readonly<Record<string, Record<string, unknown>>>,
): Record<string, RegistryEntryShape> {
  const shape: Record<string, RegistryEntryShape> = {};
  for (const [targetId, entry] of Object.entries(entries)) {
    const hostKey = asString(entry.connectionRef);
    if (!hostKey) continue; // schema-level validation already flags a missing/invalid connectionRef.
    const rawContainers = Array.isArray(entry.containers) ? entry.containers : [];
    const containers: RegistryContainerShape[] = [];
    rawContainers.forEach((raw: unknown, index: number) => {
      if (!raw || typeof raw !== "object") return;
      const name = asString((raw as Record<string, unknown>).name);
      const portRef = asString((raw as Record<string, unknown>).portRef);
      if (name && portRef) containers.push({ name, portRef, index });
    });
    shape[targetId] = { hostKey, containers };
  }
  return shape;
}

/**
 * Same shape, but with connectionRef/portRef/container-name swapped for
 * their RESOLVED values (startup mode):
 *   - `hostKey` is the `host` field of the parsed resolved connection (DD-23)
 *     — grouping by host identity alone, not the whole connection secret, so
 *     two entries on the same host with different users/credentials still
 *     collide (and two different hosts never falsely collide).
 *   - container `name` resolves to the real container name when it was a
 *     logical ref, so two logically-different names that resolve to the
 *     SAME real name are caught.
 *   - container `portRef` becomes the published HOST port (the left side of
 *     the resolved `<host>:<container>` mapping, design §6.4), not the whole
 *     mapping string — `8080:3000` and `8080:4000` both occupy host port 8080.
 */
export function extractResolvedRegistryShape(
  entries: Readonly<Record<string, Record<string, unknown>>>,
  resolved: ReadonlyMap<string, string>,
): Record<string, RegistryEntryShape> {
  const shape: Record<string, RegistryEntryShape> = {};
  for (const [targetId, entry] of Object.entries(entries)) {
    const connectionRef = asString(entry.connectionRef);
    if (!connectionRef) continue;
    const resolvedConnectionValue = resolved.get(connectionRef);
    if (resolvedConnectionValue === undefined) continue; // an unresolved ref already aborted startup before this runs.
    const hostKey = parseResolvedConnection(connectionRef, resolvedConnectionValue).host;

    const rawContainers = Array.isArray(entry.containers) ? entry.containers : [];
    const containers: RegistryContainerShape[] = [];
    rawContainers.forEach((raw: unknown, index: number) => {
      if (!raw || typeof raw !== "object") return;
      const name = asString((raw as Record<string, unknown>).name);
      const portRef = asString((raw as Record<string, unknown>).portRef);
      if (!name || !portRef) return;

      const resolvedName = isLogicalRef(name) ? (resolved.get(name) ?? name) : name;
      const resolvedPortValue = resolved.get(portRef);
      const hostPort =
        resolvedPortValue !== undefined ? parseResolvedPortMapping(portRef, resolvedPortValue).hostPort : portRef;

      containers.push({ name: resolvedName, portRef: hostPort, index });
    });
    shape[targetId] = { hostKey, containers };
  }
  return shape;
}

export interface DeploymentBinding {
  readonly deploymentId: string;
  readonly targetRef: string;
}

/**
 * Single-source invariant (design §6.3 added rule, DD-27 implementation
 * detail 1; owner approval 2026-10-06): a `lockKey` may be referenced by
 * EXACTLY ONE `deploymentId`, and each `deploymentId` is bound to exactly one
 * definition (hence one source and one `allowedSender`). Violations are
 * rejected at validation, in CI and at startup. `runNumber` is only ever
 * compared inside one source, so two deployments sharing a lock would make
 * the order input meaningless.
 *
 * A lockKey is reached through the definition's `targetRef`; two definitions
 * on DIFFERENT targets that declare the same lockKey string collide too.
 * Only logical values are compared and only ids/lockKeys (logical, DD-23) are
 * named in the issue text.
 */
export function checkOneDeploymentPerLockKey(
  deployments: readonly DeploymentBinding[],
  registryEntries: Readonly<Record<string, Record<string, unknown>>>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const idCounts = new Map<string, number>();
  for (const { deploymentId } of deployments) idCounts.set(deploymentId, (idCounts.get(deploymentId) ?? 0) + 1);
  for (const [deploymentId, count] of idCounts) {
    if (count > 1) {
      issues.push({
        rule: "deployment-duplicate",
        field: `deployment(${deploymentId})/deploymentId`,
        message: `deploymentId "${deploymentId}" is declared by ${count} definitions; a deploymentId is bound to exactly one definition and one source (DD-27)`,
      });
    }
  }

  const idsByLockKey = new Map<string, Set<string>>();
  for (const { deploymentId, targetRef } of deployments) {
    const lockKey = registryEntries[targetRef]?.lockKey;
    if (typeof lockKey !== "string") continue; // missing target/lockKey is reported by other rules.
    const ids = idsByLockKey.get(lockKey) ?? new Set<string>();
    ids.add(deploymentId);
    idsByLockKey.set(lockKey, ids);
  }
  for (const [lockKey, ids] of idsByLockKey) {
    if (ids.size > 1) {
      issues.push({
        rule: "lock-key-multiple-deployments",
        field: `targetRegistry/lockKey`,
        message: `lockKey "${lockKey}" is referenced by more than one deploymentId (${[...ids].sort().join(", ")}); exactly one deploymentId per lockKey is allowed (design §6.3, DD-27)`,
      });
    }
  }
  return issues;
}

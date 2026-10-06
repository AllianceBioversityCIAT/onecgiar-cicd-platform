// @akili-spec changes/cicd-executor-poc design §5.1, §6.3, §7 (execution-service, deploy-window-service, ssh-deployer rows), DD-09, DD-19, DD-27; requirements FR-12, FR-17
// Small composition adapters (N-17b): each one only translates between a
// repository's public surface and the port a service declares. No business
// rule lives here.
import type { TargetOrderingEntry, TargetOrderingPort } from "../application/execution-service/index.js";
import type {
  ExecutionLookup,
  LockOwnerLookup,
  ResolutionAuditWriter,
  UnresolvedStore,
} from "../application/deploy-window-service/index.js";
import type { TargetConnectionDetails, TargetResolver } from "../adapters/ssh-deployer/index.js";
import type { ExecutionRepository } from "../adapters/dynamodb-state-store/execution-repository.js";
import type { LockRepository } from "../adapters/dynamodb-state-store/lock-repository.js";
import type { ResolutionAuditRepository } from "../adapters/dynamodb-state-store/resolution-audit-repository.js";
import type { TargetStateRepository } from "../adapters/dynamodb-state-store/target-state-repository.js";
import type { RaiseMaxDecision, TargetOrderingState } from "../domain/supersede-policy/index.js";
import type { Clock } from "../ports/clock.js";
import type { StartupCatalog } from "./catalog.js";

/** `TargetStateRepository` `{ raised }` -> the execution-service port's `{ accepted }`; `readOrdering` from `get()`. */
export function createTargetOrderingPort(deps: { readonly targets: TargetStateRepository; readonly clock: Clock }): TargetOrderingPort {
  return {
    async readOrdering(lockKey): Promise<TargetOrderingState> {
      const item = await deps.targets.get(lockKey);
      return {
        ...(item?.lastDeployed === undefined ? {} : { lastDeployed: item.lastDeployed }),
        ...(item?.highestDispatched === undefined ? {} : { highestDispatched: item.highestDispatched }),
        ...(item?.highestAccepted === undefined ? {} : { highestAccepted: item.highestAccepted }),
      };
    },
    async raiseHighestAccepted(lockKey, value: TargetOrderingEntry): Promise<RaiseMaxDecision> {
      const outcome = await deps.targets.raiseHighestAccepted(lockKey, value, deps.clock.now().getTime());
      if (outcome.raised) return { accepted: true, reason: "RAISED" };
      return { accepted: false, reason: outcome.reason };
    },
  };
}

export function createUnresolvedStore(deps: { readonly targets: TargetStateRepository; readonly clock: Clock }): UnresolvedStore {
  return {
    async listUnresolved(lockKey) {
      return ((await deps.targets.get(lockKey))?.unresolved ?? []).map((entry) => entry.executionId);
    },
    removeUnresolved: (lockKey, executionId) => deps.targets.removeUnresolved(lockKey, executionId, deps.clock.now().getTime()),
  };
}

export function createExecutionLookup(executions: Pick<ExecutionRepository, "get">): ExecutionLookup {
  return {
    async getStatus(executionId) {
      const item = await executions.get(executionId);
      return item === undefined ? undefined : { status: item.status, lockKey: item.lockKey };
    },
  };
}

export function createLockOwnerLookup(locks: Pick<LockRepository, "get">): LockOwnerLookup {
  return {
    async hasLiveOwner(lockKey, nowMs) {
      const lock = await locks.get(lockKey);
      return lock !== undefined && lock.leaseExpiresAt > nowMs;
    },
  };
}

export function createResolutionAuditWriter(audit: ResolutionAuditRepository): ResolutionAuditWriter {
  return {
    async write(entry) {
      await audit.write(entry); // idempotent per eventId: an existing entry is the expected redelivery outcome
    },
  };
}

/**
 * SSH `TargetResolver` over the VALIDATED registry (DD-19: no re-read). `temporaryPassword` is always `false`:
 * the registry has no marker for a temporary password (spec gap escalated, FR-12), so a password credential is never accepted.
 * The references are returned as references; the transport resolves them through the SecretProvider at point of use.
 */
export function createTargetResolver(catalog: StartupCatalog): TargetResolver {
  const byTarget = new Map<string, TargetConnectionDetails>();
  for (const id of catalog.deploymentIds()) {
    const view = catalog.deployment(id);
    if (view === undefined) continue;
    const t = view.target;
    const connectionRef = t["connectionRef"];
    const hostKeyRef = t["hostKeyRef"];
    const credentialRef = t["credentialRef"];
    if (typeof connectionRef === "string" && typeof hostKeyRef === "string" && typeof credentialRef === "string") {
      byTarget.set(view.targetId, { connectionRef, hostKeyRef, credentialRef, temporaryPassword: false });
    }
  }
  return { resolve: async (targetRef) => byTarget.get(targetRef) };
}

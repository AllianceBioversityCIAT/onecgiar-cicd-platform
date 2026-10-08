// @akili-spec changes/cicd-executor-poc design §4.2, §6.4, §7.7, DD-21; requirements FR-18, FR-24, RL-1; tasks R-5 (AC-02 V1)
// Deploy-window service: opens/closes windows (idempotent, conditional writes
// through the window repository) and answers the coordinator's revalidation
// V1-V4 (fail fast, no waiting). Authorization of the operator principal is
// the router's job (DD-25); this service trusts only ports and persisted data.
// AC-02 V1: windows are keyed by the `targetId` (the V1 lock key, design §1.2).
// Opening reads the target with one GetItem (R-3) and rejects an unknown or
// invalid target and a target whose policy is `not-required`. Revalidation of
// an accepted execution never re-reads the registry: the caller passes the
// window policy of the execution's snapshot.
import {
  isDeployAllowed,
  validateOpenWindow,
  type DeployDecision,
  type DeployDenial,
  type OpenViolation,
  type TargetWindowPolicy,
  type WindowRecord,
} from "../../domain/window-policy/index.js";
import type { Clock } from "../../ports/clock.js";
import type { TargetRegistry } from "../../ports/target-registry.js";

export { TargetResolutionService } from "./target-resolution.js";
export type {
  ExecutionLookup,
  LockOwnerLookup,
  ResolutionAudit,
  ResolutionAuditWriter,
  ResolutionContext,
  ResolutionOutcome,
  ResolutionRejection,
  TargetResolutionDeps,
  TargetResolutionEvent,
  UnresolvedStore,
} from "./target-resolution.js";

/** Window persistence port; `DeployWindowRepository` (N-08) satisfies it structurally. */
export interface WindowStore {
  get(lockKey: string): Promise<WindowRecord | undefined>;
  createOpen(item: WindowRecord & { readonly state: "OPEN" }): Promise<boolean>;
  reopen(
    lockKey: string,
    expectedVersion: number,
    patch: {
      readonly openedBy: string;
      readonly openedAt: number;
      readonly closesAt: number;
      readonly externalJobsDisabled: readonly string[];
      readonly note?: string;
    },
  ): Promise<boolean>;
  close(
    lockKey: string,
    expectedVersion: number,
    patch: { readonly closedBy?: string; readonly closedReason: "MANUAL" | "EXPIRED"; readonly closedAt: number },
  ): Promise<boolean>;
}

/** The target of a revalidation: its id (the window key) and the window policy of the execution snapshot. */
export interface WindowTarget extends TargetWindowPolicy {
  readonly targetId: string;
}

export interface DeployWindowServiceDeps {
  readonly windows: WindowStore;
  /** Read-only Target Registry (R-3), used only to open a window. */
  readonly targets: TargetRegistry;
  readonly clock: Clock;
}

export interface OpenWindowCommand {
  readonly targetId: string;
  readonly openedBy: string;
  readonly externalJobsDisabled: readonly string[];
  /** ISO-8601 date-time, as in the event. */
  readonly closesAt: string;
  readonly note?: string;
}

export type OpenRejection = OpenViolation | "UNKNOWN_TARGET" | "INVALID_TARGET";

export type OpenOutcome =
  | { readonly outcome: "OPENED" }
  | { readonly outcome: "ALREADY_OPEN" }
  | {
      readonly outcome: "REJECTED";
      readonly reason: OpenRejection;
      readonly violations: readonly OpenRejection[];
    }
  /** A concurrent writer won; the caller must let the message be redelivered. */
  | { readonly outcome: "CONFLICT" };

export type CloseOutcome =
  | { readonly outcome: "CLOSED" }
  | { readonly outcome: "ALREADY_CLOSED" }
  | { readonly outcome: "CONFLICT" };

/** Revalidation points (§7.7) and the closed-state-machine transition each one fails into. */
export type RevalidationPoint = "V1" | "V2" | "V3" | "V4";

const FAILURE_TRANSITION: Record<RevalidationPoint, "X4" | "X8" | "X15" | "X10"> = {
  V1: "X4",
  V2: "X8",
  V3: "X15",
  V4: "X10",
};

export type Revalidation =
  | { readonly ok: true; readonly point: RevalidationPoint }
  | {
      readonly ok: false;
      readonly point: RevalidationPoint;
      readonly failureCode: "DEPLOY_WINDOW_CLOSED";
      readonly transition: "X4" | "X8" | "X15" | "X10";
      readonly reason: DeployDenial;
    };

export class DeployWindowService {
  public constructor(private readonly deps: DeployWindowServiceDeps) {}

  public async open(command: OpenWindowCommand): Promise<OpenOutcome> {
    const now = this.deps.clock.now().getTime();
    const lookup = await this.deps.targets.getTarget(command.targetId);
    if (lookup.kind === "missing") return { outcome: "REJECTED", reason: "UNKNOWN_TARGET", violations: ["UNKNOWN_TARGET"] };
    if (lookup.kind === "invalid") return { outcome: "REJECTED", reason: "INVALID_TARGET", violations: ["INVALID_TARGET"] };
    const closesAt = Date.parse(command.closesAt);
    const validation = validateOpenWindow({
      target: { deployWindowPolicy: lookup.target.deployWindowPolicy },
      openedBy: command.openedBy,
      externalJobsDisabled: command.externalJobsDisabled,
      closesAt,
      now,
    });
    if (!validation.valid) {
      return {
        outcome: "REJECTED",
        reason: validation.violations[0] as OpenViolation,
        violations: validation.violations,
      };
    }
    const patch = {
      openedBy: command.openedBy,
      openedAt: now,
      closesAt,
      externalJobsDisabled: command.externalJobsDisabled,
      ...(command.note === undefined ? {} : { note: command.note }),
    };

    const existing = await this.deps.windows.get(command.targetId);
    if (existing === undefined) {
      const created = await this.deps.windows.createOpen({ lockKey: command.targetId, state: "OPEN", ...patch, version: 1 });
      return created ? { outcome: "OPENED" } : { outcome: "CONFLICT" };
    }

    let version = existing.version;
    if (existing.state === "OPEN") {
      if (existing.closesAt !== undefined && existing.closesAt > now) return { outcome: "ALREADY_OPEN" };
      // Expired but not yet closed by the reconciler: close it, then reopen.
      const expired = await this.deps.windows.close(command.targetId, version, { closedReason: "EXPIRED", closedAt: now });
      if (!expired) return { outcome: "CONFLICT" };
      version += 1;
    }
    const reopened = await this.deps.windows.reopen(command.targetId, version, patch);
    return reopened ? { outcome: "OPENED" } : { outcome: "CONFLICT" };
  }

  public async close(command: { readonly targetId: string; readonly closedBy: string }): Promise<CloseOutcome> {
    const existing = await this.deps.windows.get(command.targetId);
    if (existing === undefined || existing.state === "CLOSED") return { outcome: "ALREADY_CLOSED" };
    const closed = await this.deps.windows.close(command.targetId, existing.version, {
      closedBy: command.closedBy,
      closedReason: "MANUAL",
      closedAt: this.deps.clock.now().getTime(),
    });
    return closed ? { outcome: "CLOSED" } : { outcome: "CONFLICT" };
  }

  /** `isDeployAllowed(target, needUntil)` (design §4.3); `needUntil` is epoch ms (now + deployTimeoutMinutes). */
  public async isDeployAllowed(target: WindowTarget, needUntil: number): Promise<DeployDecision> {
    const window = target.deployWindowPolicy === "required" ? await this.deps.windows.get(target.targetId) : undefined;
    return isDeployAllowed({ target, window, needUntil, now: this.deps.clock.now().getTime() });
  }

  /**
   * Revalidation used by the coordinator at V1 (QUEUED), V2 (every lock
   * attempt), V3 (after exit 50) and V4 (right before the SSH exec). Fail-fast
   * (RL-1): a denial maps straight to `FAILED (DEPLOY_WINDOW_CLOSED)` through
   * the point's transition; this method never waits and never retries.
   */
  public async revalidate(point: RevalidationPoint, target: WindowTarget, needUntil: number): Promise<Revalidation> {
    const decision = await this.isDeployAllowed(target, needUntil);
    if (decision.allowed) return { ok: true, point };
    return { ok: false, point, failureCode: "DEPLOY_WINDOW_CLOSED", transition: FAILURE_TRANSITION[point], reason: decision.reason };
  }
}

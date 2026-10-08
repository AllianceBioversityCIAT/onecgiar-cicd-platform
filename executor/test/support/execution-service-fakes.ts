// @akili-spec changes/cicd-executor-poc design §5.1, §7 (execution-service row), DD-20, DD-27
// In-memory fakes of the execution-service ports. The storage fakes reproduce
// the conditional-write semantics of the DynamoDB repositories (same method
// names and outcomes) so unit tests exercise the service's branching, while the
// DynamoDB Local integration tests exercise the real conditions.
import { decideRaiseMax, type OrderingValue, type RaiseMaxDecision, type TargetOrderingState } from "../../src/domain/supersede-policy/index.js";
import type { DedupeItem, ExecutionItem, RejectionItem } from "../../src/adapters/dynamodb-state-store/types.js";
import type { RejectionRef } from "../../src/adapters/dynamodb-state-store/keys.js";
import type { ExecutionTransitionExpected, ExecutionUpdatePatch } from "../../src/adapters/dynamodb-state-store/execution-repository.js";
import type {
  DedupePort,
  ExecutionStorePort,
  RejectionStorePort,
  SequencePort,
  TargetOrderingEntry,
  TargetOrderingPort,
} from "../../src/application/execution-service/index.js";
import type { Clock } from "../../src/ports/clock.js";

export class FakeClock implements Clock {
  public constructor(public nowMs = 1_800_000_000_000) {}
  public now(): Date {
    return new Date(this.nowMs);
  }
}

export class FakeDedupe implements DedupePort {
  public readonly items = new Map<string, DedupeItem>();
  private key(d: string, r: string): string {
    return `${d}#${r}`;
  }
  public async get(d: string, r: string): Promise<DedupeItem | undefined> {
    return this.items.get(this.key(d, r));
  }
  public async claim(d: string, r: string, claimToken: string, claimLeaseExpiresAt: number, expiresAt: number): Promise<boolean> {
    if (this.items.has(this.key(d, r))) return false;
    this.items.set(this.key(d, r), { targetId: d, requestId: r, state: "CLAIMED", claimToken, claimLeaseExpiresAt, expiresAt });
    return true;
  }
  public async takeOverExpiredClaim(d: string, r: string, previous: string, next: string, lease: number, now: number): Promise<boolean> {
    const item = this.items.get(this.key(d, r));
    if (item === undefined || item.claimToken !== previous || item.claimLeaseExpiresAt >= now || item.state !== "CLAIMED") return false;
    this.items.set(this.key(d, r), { ...item, claimToken: next, claimLeaseExpiresAt: lease });
    return true;
  }
  public async recordSequence(d: string, r: string, claimToken: string, sequence: number): Promise<boolean> {
    const item = this.items.get(this.key(d, r));
    if (item === undefined || item.claimToken !== claimToken || item.sequence !== undefined) return false;
    this.items.set(this.key(d, r), { ...item, sequence });
    return true;
  }
  public async bind(d: string, r: string, claimToken: string, executionId: string): Promise<boolean> {
    const item = this.items.get(this.key(d, r));
    if (item === undefined || item.claimToken !== claimToken) return false;
    this.items.set(this.key(d, r), { ...item, state: "BOUND", executionId });
    return true;
  }
}

export class FakeSequence implements SequencePort {
  public readonly counters = new Map<string, number>();
  public async increment(targetId: string): Promise<number> {
    const next = (this.counters.get(targetId) ?? 0) + 1;
    this.counters.set(targetId, next);
    return next;
  }
}

export class FakeExecutions implements ExecutionStorePort {
  public readonly items = new Map<string, ExecutionItem>();
  public async get(executionId: string): Promise<ExecutionItem | undefined> {
    return this.items.get(executionId);
  }
  public async create(item: ExecutionItem): Promise<boolean> {
    if (this.items.has(item.executionId)) return false;
    this.items.set(item.executionId, item);
    return true;
  }
  public async update(executionId: string, expected: ExecutionTransitionExpected, patch: ExecutionUpdatePatch): Promise<boolean> {
    const item = this.items.get(executionId);
    if (item === undefined || item.status !== expected.status || item.version !== expected.version) return false;
    const next: Record<string, unknown> = { ...item, version: item.version + 1 };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) delete next[field];
      else next[field] = value;
    }
    this.items.set(executionId, next as unknown as ExecutionItem);
    return true;
  }
}

export class FakeRejections implements RejectionStorePort {
  public readonly items = new Map<string, Omit<RejectionItem, "expiresAt">>();
  public static keyOf(ref: RejectionRef): string {
    return `REJECT#MSG#${ref.sqsMessageId}`;
  }
  public async record(ref: RejectionRef, item: Omit<RejectionItem, "expiresAt">): Promise<boolean> {
    const key = FakeRejections.keyOf(ref);
    if (this.items.has(key)) return false;
    this.items.set(key, item);
    return true;
  }
}

/** Target-ordering fake with the same raise rule as the real adapter must apply (`decideRaiseMax`). */
export class FakeTarget implements TargetOrderingPort {
  public readonly states = new Map<string, TargetOrderingState>();
  public readonly raises: { lockKey: string; value: TargetOrderingEntry; decision: RaiseMaxDecision }[] = [];
  public seed(lockKey: string, state: TargetOrderingState): void {
    this.states.set(lockKey, state);
  }
  public async readOrdering(lockKey: string): Promise<TargetOrderingState> {
    return this.states.get(lockKey) ?? {};
  }
  public async raiseHighestAccepted(lockKey: string, value: TargetOrderingEntry): Promise<RaiseMaxDecision> {
    const state = this.states.get(lockKey) ?? {};
    const decision = decideRaiseMax(state.highestAccepted, value);
    if (decision.accepted) {
      const ordering: OrderingValue = { sourceRef: value.sourceRef, runNumber: value.runNumber };
      this.states.set(lockKey, { ...state, highestAccepted: ordering });
    }
    this.raises.push({ lockKey, value, decision });
    return decision;
  }
}

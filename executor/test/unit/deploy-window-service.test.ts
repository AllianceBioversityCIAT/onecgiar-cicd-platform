// @akili-spec changes/cicd-executor-poc design §7.7, DD-21; requirements FR-24, RL-1
import { describe, expect, it } from "vitest";
import {
  DeployWindowService,
  TargetResolutionService,
  type OpenWindowCommand,
  type ResolutionAudit,
  type TargetPolicyLookup,
  type WindowStore,
} from "../../src/application/deploy-window-service/index.js";
import type { TargetWindowPolicy, WindowRecord } from "../../src/domain/window-policy/index.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-06T10:00:00.000Z");
const LOCK = "<LOCK_KEY>";
const target: TargetWindowPolicy = { deployWindowPolicy: "required", externalDeployers: ["<JOB_A>", "<JOB_B>"] };

class FakeWindowStore implements WindowStore {
  public item: WindowRecord | undefined;
  public failNextWrite = false;
  public async get(): Promise<WindowRecord | undefined> {
    return this.item;
  }
  public async createOpen(item: WindowRecord & { readonly state: "OPEN" }): Promise<boolean> {
    if (this.failNextWrite || this.item !== undefined) return false;
    this.item = item;
    return true;
  }
  public async reopen(_k: string, v: number, patch: Parameters<WindowStore["reopen"]>[2]): Promise<boolean> {
    if (this.failNextWrite || this.item?.state !== "CLOSED" || this.item.version !== v) return false;
    this.item = { ...this.item, ...patch, state: "OPEN", version: v + 1 };
    return true;
  }
  public async close(_k: string, v: number, patch: Parameters<WindowStore["close"]>[2]): Promise<boolean> {
    if (this.failNextWrite || this.item?.state !== "OPEN" || this.item.version !== v) return false;
    this.item = { ...this.item, ...patch, state: "CLOSED", version: v + 1 };
    return true;
  }
}

function setup(lookup: TargetPolicyLookup = { resolve: async () => target }) {
  const store = new FakeWindowStore();
  let nowMs = NOW;
  const service = new DeployWindowService({ windows: store, targets: lookup, clock: { now: () => new Date(nowMs) } });
  return { store, service, advance: (ms: number) => (nowMs += ms) };
}

const openCommand = (over: Partial<OpenWindowCommand> = {}): OpenWindowCommand => ({
  lockKey: LOCK,
  openedBy: "operator-1",
  externalJobsDisabled: ["<JOB_A>", "<JOB_B>"],
  closesAt: new Date(NOW + 2 * HOUR).toISOString(),
  ...over,
});

describe("DeployWindowService.open / close", () => {
  it("opens a window and persists owner, list and closesAt", async () => {
    const { store, service } = setup();
    expect(await service.open(openCommand({ note: "test window" }))).toEqual({ outcome: "OPENED" });
    expect(store.item).toMatchObject({ state: "OPEN", openedBy: "operator-1", closesAt: NOW + 2 * HOUR, version: 1, note: "test window" });
  });

  it("rejects a partial window without writing", async () => {
    const { store, service } = setup();
    const result = await service.open(openCommand({ externalJobsDisabled: ["<JOB_A>"] }));
    expect(result).toMatchObject({ outcome: "REJECTED", reason: "PARTIAL_COVERAGE", uncovered: ["<JOB_B>"] });
    expect(store.item).toBeUndefined();
  });

  it("rejects closesAt beyond 8 h and an unknown target", async () => {
    const { store, service } = setup();
    expect(await service.open(openCommand({ closesAt: new Date(NOW + 8 * HOUR + 1000).toISOString() }))).toMatchObject({
      outcome: "REJECTED",
      reason: "WINDOW_TOO_LONG",
    });
    const unknown = setup({ resolve: async () => undefined });
    expect(await unknown.service.open(openCommand())).toMatchObject({ outcome: "REJECTED", reason: "UNKNOWN_TARGET" });
    expect(store.item).toBeUndefined();
  });

  it("is idempotent: a second open on a live window is ALREADY_OPEN and changes nothing", async () => {
    const { store, service } = setup();
    await service.open(openCommand());
    const before = store.item;
    expect(await service.open(openCommand({ openedBy: "operator-2" }))).toEqual({ outcome: "ALREADY_OPEN" });
    expect(store.item).toBe(before);
  });

  it("reopens a closed window and replaces an expired-but-OPEN one", async () => {
    const { store, service, advance } = setup();
    await service.open(openCommand());
    await service.close({ lockKey: LOCK, closedBy: "operator-1" });
    expect(await service.open(openCommand())).toEqual({ outcome: "OPENED" });
    expect(store.item).toMatchObject({ state: "OPEN", version: 3 });
    advance(3 * HOUR);
    expect(await service.open(openCommand({ closesAt: new Date(NOW + 5 * HOUR).toISOString() }))).toEqual({ outcome: "OPENED" });
    expect(store.item).toMatchObject({ state: "OPEN", version: 5, closesAt: NOW + 5 * HOUR });
  });

  it("close is idempotent and records MANUAL + closedBy", async () => {
    const { store, service } = setup();
    expect(await service.close({ lockKey: LOCK, closedBy: "operator-1" })).toEqual({ outcome: "ALREADY_CLOSED" });
    await service.open(openCommand());
    expect(await service.close({ lockKey: LOCK, closedBy: "operator-1" })).toEqual({ outcome: "CLOSED" });
    expect(store.item).toMatchObject({ state: "CLOSED", closedBy: "operator-1", closedReason: "MANUAL" });
    expect(await service.close({ lockKey: LOCK, closedBy: "operator-1" })).toEqual({ outcome: "ALREADY_CLOSED" });
  });

  it("reports CONFLICT when the conditional write loses", async () => {
    const { store, service } = setup();
    store.failNextWrite = true;
    expect(await service.open(openCommand())).toEqual({ outcome: "CONFLICT" });
  });
});

describe("DeployWindowService revalidation V1-V4 (RL-1)", () => {
  it("passes at every point with a valid window", async () => {
    const { service } = setup();
    await service.open(openCommand());
    for (const point of ["V1", "V2", "V3", "V4"] as const) {
      expect(await service.revalidate(point, LOCK, NOW + HOUR)).toEqual({ ok: true, point });
    }
  });

  it("fails fast with DEPLOY_WINDOW_CLOSED mapped to X4/X8/X15/X10 when no window exists", async () => {
    const { service } = setup();
    const expected = { V1: "X4", V2: "X8", V3: "X15", V4: "X10" } as const;
    for (const point of ["V1", "V2", "V3", "V4"] as const) {
      expect(await service.revalidate(point, LOCK, NOW + HOUR)).toEqual({
        ok: false,
        point,
        failureCode: "DEPLOY_WINDOW_CLOSED",
        transition: expected[point],
        reason: "NO_WINDOW",
      });
    }
  });

  it("an expired window is not allowed", async () => {
    const { service, advance } = setup();
    await service.open(openCommand());
    expect(await service.revalidate("V1", LOCK, NOW + HOUR)).toMatchObject({ ok: true });
    advance(2 * HOUR);
    expect(await service.isDeployAllowed(LOCK, NOW + 3 * HOUR)).toEqual({ allowed: false, reason: "WINDOW_EXPIRED" });
  });

  it("a window closed manually fails V4 right before exec", async () => {
    const { service } = setup();
    await service.open(openCommand());
    await service.close({ lockKey: LOCK, closedBy: "operator-1" });
    expect(await service.revalidate("V4", LOCK, NOW + HOUR)).toMatchObject({ ok: false, transition: "X10", reason: "WINDOW_CLOSED" });
  });

  it("needUntil beyond closesAt is denied (the window must cover the deploy duration)", async () => {
    const { service } = setup();
    await service.open(openCommand());
    expect(await service.revalidate("V2", LOCK, NOW + 3 * HOUR)).toMatchObject({ ok: false, reason: "WINDOW_TOO_SHORT", transition: "X8" });
  });

  it("not-required (none) targets never need a window", async () => {
    const { service } = setup({ resolve: async () => ({ deployWindowPolicy: "not-required", externalDeployers: [] }) });
    expect(await service.revalidate("V4", LOCK, NOW + HOUR)).toEqual({ ok: true, point: "V4" });
  });
});

describe("TargetResolutionService (runbook 12.2 preconditions)", () => {
  const event = {
    eventId: "00000000-0000-4000-8000-000000000001",
    lockKey: LOCK,
    executionId: "exec-1",
    resolvedBy: "operator-1",
    observedDigests: { "<UNIT>": `sha256:${"a".repeat(64)}` },
  };

  function resolutionSetup(
    over: { status?: string; lockKey?: string; unresolved?: readonly string[]; liveOwner?: boolean; execution?: boolean; removeOk?: boolean } = {},
  ) {
    const calls: string[] = [];
    const audits: ResolutionAudit[] = [];
    const service = new TargetResolutionService({
      clock: { now: () => new Date(NOW) },
      executions: {
        getStatus: async () =>
          over.execution === false ? undefined : { status: over.status ?? "UNKNOWN_TARGET_STATE", lockKey: over.lockKey ?? LOCK },
      },
      unresolved: {
        listUnresolved: async () => over.unresolved ?? ["exec-1", "exec-2"],
        removeUnresolved: async (k, id) => {
          calls.push(`remove:${k}:${id}`);
          return over.removeOk ?? true;
        },
      },
      locks: { hasLiveOwner: async () => over.liveOwner ?? false },
      audit: { write: async (entry) => void audits.push(entry) },
    });
    return { service, calls, audits };
  }

  it("records: audits (with SenderId role) then removes only that entry; nothing else is touched", async () => {
    const { service, calls, audits } = resolutionSetup();
    expect(await service.record(event, { senderId: "<OPERATOR_ROLE>:session" })).toEqual({ outcome: "RECORDED" });
    expect(calls).toEqual([`remove:${LOCK}:exec-1`]);
    expect(audits).toEqual([{ ...event, senderId: "<OPERATOR_ROLE>:session", at: NOW }]);
  });

  it.each([
    ["EXECUTION_NOT_FOUND", { execution: false }],
    ["EXECUTION_NOT_UNKNOWN_TARGET_STATE", { status: "SUCCEEDED" }],
    ["LOCK_KEY_MISMATCH", { lockKey: "<OTHER_LOCK_KEY>" }],
    ["NOT_LISTED_IN_UNRESOLVED", { unresolved: ["exec-2"] }],
    ["LOCK_HAS_LIVE_OWNER", { liveOwner: true }],
  ] as const)("rejects %s without any write", async (reason, over) => {
    const { service, calls, audits } = resolutionSetup(over);
    expect(await service.record(event)).toEqual({ outcome: "REJECTED", reason });
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("reports CONFLICT when the conditional removal loses", async () => {
    const { service } = resolutionSetup({ removeOk: false });
    expect(await service.record(event)).toEqual({ outcome: "CONFLICT" });
  });
});

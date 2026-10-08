// @akili-spec changes/cicd-executor-poc design §6.4, §7.7, DD-21; requirements FR-24, RL-1; tasks R-5 (AC-02 V1: windows by targetId; open reads the Target Registry; revalidation uses the snapshot policy)
import { describe, expect, it } from "vitest";
import {
  DeployWindowService,
  TargetResolutionService,
  type OpenWindowCommand,
  type ResolutionAudit,
  type WindowStore,
  type WindowTarget,
} from "../../src/application/deploy-window-service/index.js";
import type { WindowRecord } from "../../src/domain/window-policy/index.js";
import type { TargetLookup, TargetRecord, TargetRegistry } from "../../src/ports/target-registry.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-06T10:00:00.000Z");
const TARGET_ID = "example-app-dev";
const record: TargetRecord = {
  targetId: TARGET_ID,
  project: "example",
  environment: "dev",
  host: "target.example.internal",
  user: "deploy",
  hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
  credentialRef: "cicd-poc/dev/example-app-dev/ssh",
  deployScript: "/opt/cicd/example-app/deploy.sh",
  deployWindowPolicy: "required",
  sourceRepositoryId: "123456789",
  schemaVersion: 1,
  version: 1,
  updatedAt: "2026-10-07T12:00:00Z",
  updatedBy: "platform-admin",
};
const REQUIRED: WindowTarget = { targetId: TARGET_ID, deployWindowPolicy: "required" };

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

function setup(lookup: TargetLookup = { kind: "found", target: record }) {
  const store = new FakeWindowStore();
  let nowMs = NOW;
  const reads: string[] = [];
  const targets: TargetRegistry = {
    getTarget: async (id) => {
      reads.push(id);
      return lookup;
    },
  };
  const service = new DeployWindowService({ windows: store, targets, clock: { now: () => new Date(nowMs) } });
  return { store, service, reads, advance: (ms: number) => (nowMs += ms) };
}

const openCommand = (over: Partial<OpenWindowCommand> = {}): OpenWindowCommand => ({
  targetId: TARGET_ID,
  openedBy: "operator-1",
  externalJobsDisabled: ["<JOB_A>"],
  closesAt: new Date(NOW + 2 * HOUR).toISOString(),
  ...over,
});

describe("DeployWindowService.open / close", () => {
  it("opens a window keyed by the targetId after reading the target, and persists owner, list (audit) and closesAt", async () => {
    const { store, service, reads } = setup();
    expect(await service.open(openCommand({ note: "test window" }))).toEqual({ outcome: "OPENED" });
    expect(reads).toEqual([TARGET_ID]);
    expect(store.item).toMatchObject({
      lockKey: TARGET_ID,
      state: "OPEN",
      openedBy: "operator-1",
      externalJobsDisabled: ["<JOB_A>"],
      closesAt: NOW + 2 * HOUR,
      version: 1,
      note: "test window",
    });
  });

  it.each([
    ["an unknown target", { kind: "missing" } as TargetLookup, "UNKNOWN_TARGET"],
    ["an invalid target record", { kind: "invalid", problems: ["/hostKey minItems"] } as TargetLookup, "INVALID_TARGET"],
    ["a not-required target", { kind: "found", target: { ...record, deployWindowPolicy: "not-required" } } as TargetLookup, "WINDOW_NOT_REQUIRED"],
  ])("rejects opening on %s without writing (design §6.4, §7.7)", async (_label, lookup, reason) => {
    const { store, service } = setup(lookup);
    expect(await service.open(openCommand())).toMatchObject({ outcome: "REJECTED", reason });
    expect(store.item).toBeUndefined();
  });

  it("rejects an empty disabled list without writing", async () => {
    const { store, service } = setup();
    expect(await service.open(openCommand({ externalJobsDisabled: [] }))).toMatchObject({ outcome: "REJECTED", reason: "EMPTY_DISABLED_LIST" });
    expect(store.item).toBeUndefined();
  });

  it("rejects closesAt beyond 8 h", async () => {
    const { store, service } = setup();
    expect(await service.open(openCommand({ closesAt: new Date(NOW + 8 * HOUR + 1000).toISOString() }))).toMatchObject({
      outcome: "REJECTED",
      reason: "WINDOW_TOO_LONG",
    });
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
    await service.close({ targetId: TARGET_ID, closedBy: "operator-1" });
    expect(await service.open(openCommand())).toEqual({ outcome: "OPENED" });
    expect(store.item).toMatchObject({ state: "OPEN", version: 3 });
    advance(3 * HOUR);
    expect(await service.open(openCommand({ closesAt: new Date(NOW + 5 * HOUR).toISOString() }))).toEqual({ outcome: "OPENED" });
    expect(store.item).toMatchObject({ state: "OPEN", version: 5, closesAt: NOW + 5 * HOUR });
  });

  it("close is idempotent and records MANUAL + closedBy", async () => {
    const { store, service } = setup();
    expect(await service.close({ targetId: TARGET_ID, closedBy: "operator-1" })).toEqual({ outcome: "ALREADY_CLOSED" });
    await service.open(openCommand());
    expect(await service.close({ targetId: TARGET_ID, closedBy: "operator-1" })).toEqual({ outcome: "CLOSED" });
    expect(store.item).toMatchObject({ state: "CLOSED", closedBy: "operator-1", closedReason: "MANUAL" });
    expect(await service.close({ targetId: TARGET_ID, closedBy: "operator-1" })).toEqual({ outcome: "ALREADY_CLOSED" });
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
      expect(await service.revalidate(point, REQUIRED, NOW + HOUR)).toEqual({ ok: true, point });
    }
  });

  it("fails fast with DEPLOY_WINDOW_CLOSED mapped to X4/X8/X15/X10 when no window exists", async () => {
    const { service } = setup();
    const expected = { V1: "X4", V2: "X8", V3: "X15", V4: "X10" } as const;
    for (const point of ["V1", "V2", "V3", "V4"] as const) {
      expect(await service.revalidate(point, REQUIRED, NOW + HOUR)).toEqual({
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
    expect(await service.revalidate("V1", REQUIRED, NOW + HOUR)).toMatchObject({ ok: true });
    advance(2 * HOUR);
    expect(await service.isDeployAllowed(REQUIRED, NOW + 3 * HOUR)).toEqual({ allowed: false, reason: "WINDOW_EXPIRED" });
  });

  it("a window closed manually fails V4 right before exec", async () => {
    const { service } = setup();
    await service.open(openCommand());
    await service.close({ targetId: TARGET_ID, closedBy: "operator-1" });
    expect(await service.revalidate("V4", REQUIRED, NOW + HOUR)).toMatchObject({ ok: false, transition: "X10", reason: "WINDOW_CLOSED" });
  });

  it("needUntil beyond closesAt is denied (the window must cover the deploy duration)", async () => {
    const { service } = setup();
    await service.open(openCommand());
    expect(await service.revalidate("V2", REQUIRED, NOW + 3 * HOUR)).toMatchObject({ ok: false, reason: "WINDOW_TOO_SHORT", transition: "X8" });
  });

  it("not-required targets never need a window", async () => {
    const { service } = setup();
    expect(await service.revalidate("V4", { targetId: TARGET_ID, deployWindowPolicy: "not-required" }, NOW + HOUR)).toEqual({ ok: true, point: "V4" });
  });

  it("revalidation never reads the Target Registry: the policy comes from the execution snapshot", async () => {
    const { service, reads } = setup({ kind: "missing" });
    await service.revalidate("V2", REQUIRED, NOW + HOUR);
    expect(reads).toEqual([]);
  });
});

describe("TargetResolutionService (runbook 12.2 preconditions)", () => {
  const event = {
    eventId: "00000000-0000-4000-8000-000000000001",
    targetId: TARGET_ID,
    executionId: "exec-1",
    resolvedBy: "operator-1",
    observedDigests: { "<UNIT>": `sha256:${"a".repeat(64)}` },
  };

  function resolutionSetup(
    over: { status?: string; targetId?: string; unresolved?: readonly string[]; liveOwner?: boolean; execution?: boolean; removeOk?: boolean } = {},
  ) {
    const calls: string[] = [];
    const audits: ResolutionAudit[] = [];
    const service = new TargetResolutionService({
      clock: { now: () => new Date(NOW) },
      executions: {
        getStatus: async () =>
          over.execution === false ? undefined : { status: over.status ?? "UNKNOWN_TARGET_STATE", targetId: over.targetId ?? TARGET_ID },
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
    expect(calls).toEqual([`remove:${TARGET_ID}:exec-1`]);
    expect(audits).toEqual([{ ...event, senderId: "<OPERATOR_ROLE>:session", at: NOW }]);
  });

  it.each([
    ["EXECUTION_NOT_FOUND", { execution: false }],
    ["EXECUTION_NOT_UNKNOWN_TARGET_STATE", { status: "SUCCEEDED" }],
    ["TARGET_MISMATCH", { targetId: "other-app-dev" }],
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

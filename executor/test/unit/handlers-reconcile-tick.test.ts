// @akili-spec changes/cicd-executor-poc design 6.4, DD-13; G-8 (owner decision 2026-10-06)
// RECONCILE_TICK has no sender-supplied eventId: the handler generates the correlation id inside the Executor.
import { describe, expect, it, vi } from "vitest";
import { createMessageHandlers, type HandlerDeps } from "../../src/composition/handlers.js";
import type { ReconcileTickEvent } from "../../src/domain/request-contract/index.js";

const tick: ReconcileTickEvent = { specVersion: 1, eventType: "RECONCILE_TICK", source: "scheduler", timestamp: "2026-10-06T12:05:00Z" };

describe("reconcileTick handler (G-8)", () => {
  it("logs a generated correlation id, reconciles once and waits for background work", async () => {
    const info = vi.fn();
    const reconcile = vi.fn(async () => ({ overdueExecutions: 0, actions: [], windowsClosed: 0 }));
    const idle = vi.fn(async () => undefined);
    const deps = {
      reconciler: { reconcile },
      logger: { info },
      pending: { idle },
      newCorrelationId: () => "00000000-0000-4000-8000-0000000000aa",
    } as unknown as HandlerDeps;

    await createMessageHandlers(deps).reconcileTick(tick);

    expect(info).toHaveBeenCalledWith("RECONCILE_TICK consumed", { correlationId: "00000000-0000-4000-8000-0000000000aa" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("defaults to a fresh UUID per tick", async () => {
    const info = vi.fn();
    const deps = {
      reconciler: { reconcile: async () => ({ overdueExecutions: 0, actions: [], windowsClosed: 0 }) },
      logger: { info },
      pending: { idle: async () => undefined },
    } as unknown as HandlerDeps;
    const handlers = createMessageHandlers(deps);
    await handlers.reconcileTick(tick);
    await handlers.reconcileTick(tick);
    const ids = info.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

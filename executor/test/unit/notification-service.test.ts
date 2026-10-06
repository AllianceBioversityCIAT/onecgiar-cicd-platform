// @akili-spec changes/cicd-executor-poc design §6.6, §5.1; requirements FR-14
// Notification service: lifecycle messages per §6.6, EVT# dedupe, and the
// "provider failure never changes state / never throws" guarantees.
import { describe, expect, it } from "vitest";
import {
  createNotificationService,
  type EventMarkStore,
  type NotificationInput,
} from "../../src/application/notification-service/index.js";
import { createLogger } from "../../src/observability/logger/index.js";
import type { NotificationEvent, NotificationProvider } from "../../src/ports/notification-provider.js";

const FAKE_TOKEN = ["xo", "xb-FAKE-0000000000-fake-token-value"].join(""); // built at runtime so no token-shaped literal is committed
const clock = { now: () => new Date("2026-10-06T12:00:00.000Z") };

/** Mirrors the `attribute_not_exists` semantics of EventMarkRepository.markOnce. */
class FakeMarks implements EventMarkStore {
  public readonly seen = new Set<string>();
  public fail = false;
  public async markOnce(executionId: string, eventKey: string): Promise<boolean> {
    if (this.fail) throw new Error("mark store unavailable");
    const key = `EXEC#${executionId}|EVT#${eventKey}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

class RecordingProvider implements NotificationProvider {
  public readonly name = "fake";
  public readonly sent: NotificationEvent[] = [];
  public failWith: Error | undefined;
  public async notify(event: NotificationEvent): Promise<{ threadRef?: string }> {
    if (this.failWith) throw this.failWith;
    this.sent.push(event);
    return { threadRef: event.threadRef ?? "1700000000.000100" };
  }
}

function setup() {
  const marks = new FakeMarks();
  const provider = new RecordingProvider();
  const lines: string[] = [];
  const failures: string[] = [];
  const service = createNotificationService({
    providers: [provider],
    marks,
    logger: createLogger({ sink: { write: (l) => lines.push(l) }, clock }),
    metrics: { recordNotificationFailed: (p) => failures.push(p) },
    clock,
  });
  return { marks, provider, lines, failures, service };
}

const base = {
  executionId: "exec-1",
  deploymentId: "<PRMS_REPORTING_DEV>",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  runUrl: "https://github.com/<ORG>/<REPO>/actions/runs/1",
  destination: { channelRef: "<DEPLOY_CHANNEL>", tokenRef: "<SLACK_TOKEN>" },
} as const;

describe("notification-service (FR-14, design §6.6)", () => {
  it("posts the root on ACCEPTED with deploymentId, executionId, short commit and run link, and returns the thread ref", async () => {
    const { service, provider } = setup();
    const result = await service.notify({ ...base, kind: "ACCEPTED" });

    expect(provider.sent).toHaveLength(1);
    const text = provider.sent[0]!.message;
    expect(text).toContain("<PRMS_REPORTING_DEV>");
    expect(text).toContain("exec-1");
    expect(text).toContain("0123456");
    expect(text).not.toContain(base.commitSha);
    expect(text).toContain(base.runUrl);
    expect(provider.sent[0]!.threadRef).toBeUndefined();
    expect(result.threadRef).toBe("1700000000.000100");
  });

  it("duplicate event produces exactly one message (EVT# claim)", async () => {
    const { service, provider } = setup();
    const input: NotificationInput = { ...base, kind: "ACCEPTED" };
    await service.notify(input);
    await service.notify(input);
    expect(provider.sent).toHaveLength(1);
  });

  it("replies in the thread and rewrites the root with outcome and duration on SUCCEEDED", async () => {
    const { service, provider } = setup();
    await service.notify({ ...base, kind: "SUCCEEDED", threadRef: "17.1", durationMs: 42_000 });
    const event = provider.sent[0]!;
    expect(event.threadRef).toBe("17.1");
    expect(event.message).toContain("succeeded");
    expect(event.rootText).toContain("succeeded in 42s");
  });

  it.each([
    [{ kind: "SUPERSEDED", supersededByExecutionId: "exec-2" } as const, "Superseded by execution exec-2"],
    [{ kind: "DEPLOY_WINDOW_CLOSED" } as const, "DEPLOY_WINDOW_CLOSED"],
    [{ kind: "LOCK_TIMEOUT" } as const, "LOCK_TIMEOUT"],
    [{ kind: "DEPLOY_FAILED", code: "HEALTH_CHECK_FAILED" } as const, "HEALTH_CHECK_FAILED"],
    [
      { kind: "UNKNOWN_TARGET_STATE", runbookUrl: "https://runbook.example/<RUNBOOK>" } as const,
      "https://runbook.example/<RUNBOOK>",
    ],
  ])("thread reply for %j", async (variant, expected) => {
    const { service, provider } = setup();
    await service.notify({ ...base, threadRef: "17.1", ...variant } as NotificationInput);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.message).toContain(expected);
    expect(provider.sent[0]!.threadRef).toBe("17.1");
  });

  it("REJECTED goes to the platform channel with reason and sender reference only, deduped by rejectionId", async () => {
    const { service, provider } = setup();
    const input: NotificationInput = {
      kind: "REJECTED",
      rejectionId: "<DEPLOYMENT>#req-1",
      reason: "UNAUTHORIZED_SENDER",
      senderRef: "<SENDER_REF>",
      destination: { channelRef: "<PLATFORM_CHANNEL>", tokenRef: "<SLACK_TOKEN>" },
    };
    await service.notify(input);
    await service.notify(input);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.channelRef).toBe("<PLATFORM_CHANNEL>");
    expect(provider.sent[0]!.message).toBe("Request rejected: UNAUTHORIZED_SENDER (sender ref <SENDER_REF>)");
    expect(provider.sent[0]!.executionId).toBeUndefined();
  });

  it("different failure codes of one execution are distinct events", async () => {
    const { service, provider } = setup();
    await service.notify({ ...base, kind: "DEPLOY_FAILED", code: "A" });
    await service.notify({ ...base, kind: "DEPLOY_FAILED", code: "B" });
    expect(provider.sent).toHaveLength(2);
  });

  it("provider error: does not throw, logs redacted error, counts a metric", async () => {
    const { service, provider, lines, failures } = setup();
    provider.failWith = new Error(`Slack failed: Authorization: Bearer ${FAKE_TOKEN}`);
    await expect(service.notify({ ...base, kind: "ACCEPTED" })).resolves.toEqual({});
    expect(failures).toEqual(["fake"]);
    const logged = lines.join("\n");
    expect(logged).toContain("NOTIFICATION_FAILED");
    expect(logged).not.toContain(FAKE_TOKEN);
  });

  it("mark store failure: does not throw and sends nothing", async () => {
    const { service, provider, marks, lines } = setup();
    marks.fail = true;
    await expect(service.notify({ ...base, kind: "ACCEPTED" })).resolves.toEqual({});
    expect(provider.sent).toHaveLength(0);
    expect(lines.join("\n")).toContain("event mark write failed");
  });

  it("redacts secrets that leak into message inputs", async () => {
    const { service, provider } = setup();
    await service.notify({ ...base, kind: "DEPLOY_FAILED", code: `X ${FAKE_TOKEN}`, threadRef: "17.1" });
    expect(provider.sent[0]!.message).not.toContain(FAKE_TOKEN);
    expect(provider.sent[0]!.rootText).not.toContain(FAKE_TOKEN);
  });
});

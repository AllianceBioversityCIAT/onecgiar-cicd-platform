// @akili-spec changes/cicd-executor-poc design §6.6, DD-12; requirements FR-14
//
// `CICD_NOTIFICATIONS_DISABLED`: an explicit operator switch that replaces Slack with a provider that only logs
// `notification suppressed`. Exact values only; absent, empty or `false` keeps the default (notifications on).
import { describe, expect, it } from "vitest";
import { createSuppressedNotificationProvider } from "../../src/adapters/notify/suppressed-provider/index.js";
import { ConfigError, loadConfig } from "../../src/composition/config.js";
import { createLogger } from "../../src/observability/logger/index.js";
import { validEnv } from "../support/composition-fixtures.js";

describe("CICD_NOTIFICATIONS_DISABLED configuration", () => {
  it("keeps notifications on when the variable is absent, empty or false (default behavior)", () => {
    expect(loadConfig(validEnv()).notificationsDisabled).toBe(false);
    expect(loadConfig(validEnv({ CICD_NOTIFICATIONS_DISABLED: "" })).notificationsDisabled).toBe(false);
    expect(loadConfig(validEnv({ CICD_NOTIFICATIONS_DISABLED: "false" })).notificationsDisabled).toBe(false);
  });

  it("disables notifications only for exactly true", () => {
    expect(loadConfig(validEnv({ CICD_NOTIFICATIONS_DISABLED: "true" })).notificationsDisabled).toBe(true);
  });

  it.each(["TRUE", "True", "1", "yes", "on", " true", "true ", "disabled"])("refuses the ambiguous value %j", (value) => {
    expect(() => loadConfig(validEnv({ CICD_NOTIFICATIONS_DISABLED: value }))).toThrowError(ConfigError);
    try {
      loadConfig(validEnv({ CICD_NOTIFICATIONS_DISABLED: value }));
    } catch (e) {
      expect(String(e)).toContain("CICD_NOTIFICATIONS_DISABLED must be exactly true or false");
    }
  });
});

describe("suppressed notification provider", () => {
  function capture() {
    const lines: string[] = [];
    const logger = createLogger({ sink: { write: (l: string) => void lines.push(l) }, clock: { now: () => new Date("2026-10-10T00:00:00Z") } });
    return { lines, logger, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
  }

  it("sends nothing and logs `notification suppressed` with the kind and the execution id only", async () => {
    const { logger, records } = capture();
    const provider = createSuppressedNotificationProvider({ logger });
    const result = await provider.notify({
      executionId: "example-app-dev-1",
      kind: "DEPLOY_WINDOW_CLOSED",
      message: "Deploy failed: DEPLOY_WINDOW_CLOSED | target example-app-dev",
      channelRef: "<PLATFORM_SLACK_CHANNEL_REF>",
      tokenRef: "<PLATFORM_SLACK_TOKEN_REF>",
      threadRef: "1700000000.000100",
    });
    expect(provider.name).toBe("suppressed");
    expect(result).toEqual({}); // no Slack thread exists
    const [record, ...rest] = records();
    expect(rest).toEqual([]);
    expect(record).toMatchObject({ message: "notification suppressed", eventType: "NOTIFICATION_SUPPRESSED", kind: "DEPLOY_WINDOW_CLOSED", executionId: "example-app-dev-1" });
    const raw = JSON.stringify(record);
    for (const leaked of ["Deploy failed", "<PLATFORM_SLACK_CHANNEL_REF>", "<PLATFORM_SLACK_TOKEN_REF>", "1700000000.000100"]) expect(raw).not.toContain(leaked);
  });

  it("omits the execution id when the event has none (REJECTED)", async () => {
    const { logger, records } = capture();
    await createSuppressedNotificationProvider({ logger }).notify({ kind: "REJECTED", message: "m", channelRef: "<C>", tokenRef: "<T>" });
    expect(records()[0]).toMatchObject({ message: "notification suppressed", kind: "REJECTED" });
    expect(records()[0]).not.toHaveProperty("executionId");
  });
});

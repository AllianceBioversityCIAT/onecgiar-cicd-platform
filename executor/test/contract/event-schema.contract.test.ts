/* eslint-disable @typescript-eslint/no-explicit-any -- negative fixtures mutate arbitrary nested JSON */
// @akili-spec changes/cicd-executor-poc requirements FR-04; design 6.4
//
// Contract tests for schemas/event.schema.json, reduced to the internal event
// types of design 6.4 (DEPLOY_REQUESTED is covered by deploy-request-schema).
import { beforeAll, describe, expect, it } from "vitest";
import type { ValidateFunction } from "ajv";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { eventSchemaPath } from "./support/schema-paths.js";
import { clone, violations as baseViolations } from "./support/violations.js";

const envelope = { specVersion: 1, timestamp: "2026-10-05T12:00:00Z" };
const LOCK_KEY = "deployment#<PRMS_REPORTING_DEV_TARGET>#prms-reporting-dev-unit";

const fixtures: Record<string, Record<string, unknown>> = {
  LOCK_RETRY_REQUESTED: {
    ...envelope, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f1", eventType: "LOCK_RETRY_REQUESTED",
    source: "executor", executionId: "prms-reporting-dev-184", attempt: 2,
  },
  RECONCILE_TICK: {
    ...envelope, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f2", eventType: "RECONCILE_TICK", source: "scheduler",
  },
  DEPLOY_WINDOW_OPEN_REQUESTED: {
    ...envelope, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f3", eventType: "DEPLOY_WINDOW_OPEN_REQUESTED",
    source: "operator", lockKey: LOCK_KEY, openedBy: "operator-1", externalJobsDisabled: ["<EXTERNAL_JOB_ID>"],
    closesAt: "2026-10-05T14:00:00Z", note: "maintenance",
  },
  DEPLOY_WINDOW_CLOSE_REQUESTED: {
    ...envelope, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f4", eventType: "DEPLOY_WINDOW_CLOSE_REQUESTED",
    source: "operator", lockKey: LOCK_KEY, closedBy: "operator-1",
  },
  TARGET_RESOLUTION_RECORDED: {
    ...envelope, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f5", eventType: "TARGET_RESOLUTION_RECORDED",
    source: "operator", lockKey: LOCK_KEY, executionId: "prms-reporting-dev-184", resolvedBy: "operator-1",
    observedDigests: { server: `sha256:${"a".repeat(64)}` },
  },
};

/** Like the shared helper, but also names the property of an `unevaluatedProperties` violation. */
function violations(validate: ValidateFunction): string[] {
  const named = (validate.errors ?? [])
    .filter((e) => e.keyword === "unevaluatedProperties")
    .map((e) => `${e.instancePath} unevaluatedProperties ${(e.params as { unevaluatedProperty: string }).unevaluatedProperty}`);
  return [...baseViolations(validate), ...named];
}

describe("schemas/event.schema.json (FR-04, internal types)", () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    validate = createAjv().compile(readJsonSchema(eventSchemaPath));
  });

  it.each(Object.keys(fixtures))("accepts a valid %s", (type) => {
    expect(validate(fixtures[type]), JSON.stringify(validate.errors)).toBe(true);
  });

  const negatives: Array<[string, string, (e: Record<string, any>) => void, string]> = [
    ["a removed type (PIPELINE_REQUESTED)", "RECONCILE_TICK", (e) => { e.eventType = "PIPELINE_REQUESTED"; }, "/eventType enum"],
    ["a removed type (BUILD_COMPLETED)", "RECONCILE_TICK", (e) => { e.eventType = "BUILD_COMPLETED"; }, "/eventType enum"],
    ["a removed source (lambda)", "RECONCILE_TICK", (e) => { e.source = "lambda"; }, "/source enum"],
    ["an unknown field", "RECONCILE_TICK", (e) => { e.extra = 1; }, " unevaluatedProperties extra"],
    ["RECONCILE_TICK carrying executionId (another type's field)", "RECONCILE_TICK", (e) => { e.executionId = "x-1"; }, " unevaluatedProperties executionId"],
    ["LOCK_RETRY_REQUESTED carrying lockKey", "LOCK_RETRY_REQUESTED", (e) => { e.lockKey = LOCK_KEY; }, " unevaluatedProperties lockKey"],
    ["window open carrying closedBy", "DEPLOY_WINDOW_OPEN_REQUESTED", (e) => { e.closedBy = "operator-1"; }, " unevaluatedProperties closedBy"],
    ["window close carrying closesAt", "DEPLOY_WINDOW_CLOSE_REQUESTED", (e) => { e.closesAt = "2026-10-05T14:00:00Z"; }, " unevaluatedProperties closesAt"],
    ["window close carrying openedBy", "DEPLOY_WINDOW_CLOSE_REQUESTED", (e) => { e.openedBy = "operator-1"; }, " unevaluatedProperties openedBy"],
    ["resolution carrying attempt", "TARGET_RESOLUTION_RECORDED", (e) => { e.attempt = 1; }, " unevaluatedProperties attempt"],
    ["a non-UUID eventId", "RECONCILE_TICK", (e) => { e.eventId = "nope"; }, "/eventId format"],
    ["RECONCILE_TICK from an operator", "RECONCILE_TICK", (e) => { e.source = "operator"; }, "/source const"],
    ["LOCK_RETRY_REQUESTED without executionId", "LOCK_RETRY_REQUESTED", (e) => { delete e.executionId; }, " required executionId"],
    ["LOCK_RETRY_REQUESTED without attempt", "LOCK_RETRY_REQUESTED", (e) => { delete e.attempt; }, " required attempt"],
    ["LOCK_RETRY_REQUESTED from an operator", "LOCK_RETRY_REQUESTED", (e) => { e.source = "operator"; }, "/source const"],
    ["window open without closesAt", "DEPLOY_WINDOW_OPEN_REQUESTED", (e) => { delete e.closesAt; }, " required closesAt"],
    [
      "window open with empty externalJobsDisabled", "DEPLOY_WINDOW_OPEN_REQUESTED",
      (e) => { e.externalJobsDisabled = []; }, "/externalJobsDisabled minItems",
    ],
    ["window open from the executor", "DEPLOY_WINDOW_OPEN_REQUESTED", (e) => { e.source = "executor"; }, "/source const"],
    ["window close without closedBy", "DEPLOY_WINDOW_CLOSE_REQUESTED", (e) => { delete e.closedBy; }, " required closedBy"],
    ["resolution without observedDigests", "TARGET_RESOLUTION_RECORDED", (e) => { delete e.observedDigests; }, " required observedDigests"],
    [
      "resolution with a tag as observed digest", "TARGET_RESOLUTION_RECORDED",
      (e) => { e.observedDigests.server = "latest"; }, "/observedDigests/server pattern",
    ],
    ["resolution without resolvedBy", "TARGET_RESOLUTION_RECORDED", (e) => { delete e.resolvedBy; }, " required resolvedBy"],
  ];

  it.each(negatives)("rejects %s", (_name, type, mutate, expected) => {
    const e = clone(fixtures[type]) as Record<string, any>;
    mutate(e);
    expect(validate(e)).toBe(false);
    expect(violations(validate)).toContain(expected);
  });
});

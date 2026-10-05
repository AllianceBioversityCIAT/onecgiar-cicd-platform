// @akili-spec changes/cicd-executor-poc requirements FR-04; design 6.1
//
// Contract tests for schemas/event.schema.json (repo root). Proves:
//  1. A valid envelope per eventType family validates.
//  2. A negative corpus, one fixture per FR-04 rule, each fails validation.
import { describe, expect, it, beforeAll } from "vitest";
import type { ValidateFunction } from "ajv";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { eventSchemaPath } from "./support/schema-paths.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const validStepResultEvent = {
  specVersion: 1,
  eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f1",
  eventType: "BUILD_COMPLETED",
  executionId: "prms-reporting-dev-184",
  pipelineId: "prms-reporting-dev",
  environment: "dev",
  stepId: "server-image",
  status: "SUCCEEDED",
  attempt: 1,
  timestamp: "2026-10-05T12:00:00Z",
  source: "codebuild",
};

const validPipelineRequestedEvent = {
  specVersion: 1,
  eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f2",
  eventType: "PIPELINE_REQUESTED",
  pipelineId: "prms-reporting-dev",
  environment: "dev",
  requestId: "req-184",
  timestamp: "2026-10-05T12:00:00Z",
  source: "operator",
};

const validDeployWindowOpenEvent = {
  specVersion: 1,
  eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f3",
  eventType: "DEPLOY_WINDOW_OPEN_REQUESTED",
  lockKey: "deployment#<PRMS_REPORTING_DEV_TARGET>#prms-reporting-dev-unit",
  openedBy: "operator-1",
  externalJobsDisabled: ["<JENKINS_JOB_ID>"],
  timestamp: "2026-10-05T12:00:00Z",
  source: "operator",
};

const validReconcileTickEvent = {
  specVersion: 1,
  eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f4",
  eventType: "RECONCILE_TICK",
  timestamp: "2026-10-05T12:00:00Z",
  source: "scheduler",
};

describe("schemas/event.schema.json (FR-04)", () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    const ajv = createAjv();
    const schema = readJsonSchema(eventSchemaPath);
    validate = ajv.compile(schema);
  });

  describe("positive cases, one per envelope shape (design 6.1)", () => {
    it("accepts a step-result envelope (BUILD_COMPLETED)", () => {
      expect(validate(validStepResultEvent), JSON.stringify(validate.errors)).toBe(true);
    });

    it("accepts a PIPELINE_REQUESTED envelope", () => {
      expect(validate(validPipelineRequestedEvent), JSON.stringify(validate.errors)).toBe(true);
    });

    it("accepts a DEPLOY_WINDOW_OPEN_REQUESTED envelope", () => {
      expect(validate(validDeployWindowOpenEvent), JSON.stringify(validate.errors)).toBe(true);
    });

    it("accepts a RECONCILE_TICK envelope", () => {
      expect(validate(validReconcileTickEvent), JSON.stringify(validate.errors)).toBe(true);
    });
  });

  describe("negative corpus — one case per FR-04 rule", () => {
    it("rejects an envelope missing eventType (invalid envelope)", () => {
      const fixture = clone(validStepResultEvent) as Record<string, unknown>;
      delete fixture.eventType;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects an unknown eventType", () => {
      const fixture = clone(validStepResultEvent) as Record<string, unknown>;
      fixture.eventType = "SOMETHING_ELSE";
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a step-result event missing stepId (required field per type)", () => {
      const fixture = clone(validStepResultEvent) as Record<string, unknown>;
      delete fixture.stepId;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a PIPELINE_REQUESTED event missing requestId (required field per type)", () => {
      const fixture = clone(validPipelineRequestedEvent) as Record<string, unknown>;
      delete fixture.requestId;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a DEPLOY_WINDOW_OPEN_REQUESTED event missing openedBy", () => {
      const fixture = clone(validDeployWindowOpenEvent) as Record<string, unknown>;
      delete fixture.openedBy;
      expect(validate(fixture)).toBe(false);
    });

    it("rejects a DEPLOY_WINDOW_OPEN_REQUESTED event with an empty externalJobsDisabled[]", () => {
      const fixture = clone(validDeployWindowOpenEvent) as Record<string, unknown>;
      fixture.externalJobsDisabled = [];
      expect(validate(fixture)).toBe(false);
    });
  });
});

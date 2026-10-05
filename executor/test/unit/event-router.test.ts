// @akili-spec changes/cicd-executor-poc design §6.1, §7 (event-router row); requirements FR-04, FR-07
//
// Proves event-router's whole FR-04 pipeline: validate -> normalize ->
// orphan check (via a fake StepAttemptLookup, standing in for the
// StateStore-backed port) -> route to a handler map. The schema used is the
// REAL repo-root schemas/event.schema.json (design §6.1: "reuse it, do not
// duplicate the rules") — loaded through the same DefinitionSource seam the
// core uses (DD-19), via the InMemoryDefinitionSource test fake, never a
// fabricated test-only schema.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  routeEvent,
  createEnvelopeValidator,
  type EnvelopeValidator,
  type EventHandlerMap,
  type EventRouterLogger,
  type EventRouterMetrics,
  type OrphanEventDetails,
  type StepAttemptLookup,
  type StepAttemptLookupResult,
} from "../../src/application/event-router/index.js";
import { MalformedEventError } from "../../src/domain/events/index.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";
import { eventSchemaPath } from "../contract/support/schema-paths.js";

function loadFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/aws/${fileName}`, import.meta.url), "utf8")) as T;
}

function fakeLogger(): EventRouterLogger & { readonly calls: OrphanEventDetails[] } {
  const calls: OrphanEventDetails[] = [];
  return {
    calls,
    orphanEvent(details) {
      calls.push(details);
    },
  };
}

function fakeMetrics(): EventRouterMetrics & { count: number } {
  return {
    count: 0,
    recordOrphanEvent() {
      this.count += 1;
    },
  };
}

/** A lookup that always resolves to the same result, for the tests that only need one attempt in play. */
function staticLookup(result: StepAttemptLookupResult): StepAttemptLookup {
  return {
    async findCurrentAttempt() {
      return result;
    },
  };
}

const validBuildCompletedEnvelope = {
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

describe("event-router — routeEvent (FR-04)", () => {
  let envelopeValidator: EnvelopeValidator;

  beforeAll(async () => {
    const schemaContent = readFileSync(eventSchemaPath, "utf8");
    const definitionSource = new InMemoryDefinitionSource({ schemas: { "event.schema.json": schemaContent } });
    envelopeValidator = await createEnvelopeValidator(definitionSource);
  });

  describe("an already-valid envelope (FR-04 'valid envelope')", () => {
    it("routes directly to the matching handler without normalization", async () => {
      const calls: unknown[] = [];
      const handlers: EventHandlerMap = {
        BUILD_COMPLETED: (envelope) => {
          calls.push(envelope);
        },
      };
      const outcome = await routeEvent(validBuildCompletedEnvelope, {
        envelopeValidator,
        attemptLookup: staticLookup({
          found: true,
          pipelineId: "prms-reporting-dev",
          environment: "dev",
          attempt: 1,
          status: "RUNNING",
        }),
        logger: fakeLogger(),
        metrics: fakeMetrics(),
        handlers,
      });
      expect(outcome.kind).toBe("ROUTED");
      expect(calls).toHaveLength(1);
    });

    it("reports NO_HANDLER (without throwing) when no handler is registered for the eventType", async () => {
      const outcome = await routeEvent(validBuildCompletedEnvelope, {
        envelopeValidator,
        attemptLookup: staticLookup({
          found: true,
          pipelineId: "prms-reporting-dev",
          environment: "dev",
          attempt: 1,
          status: "RUNNING",
        }),
        logger: fakeLogger(),
        metrics: fakeMetrics(),
        handlers: {},
      });
      expect(outcome.kind).toBe("NO_HANDLER");
    });

    it("treats an unknown execution for an already-valid envelope as ORPHAN_EVENT, without invoking the handler", async () => {
      const calls: unknown[] = [];
      const handlers: EventHandlerMap = { BUILD_COMPLETED: () => { calls.push(1); } };
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const outcome = await routeEvent(validBuildCompletedEnvelope, {
        envelopeValidator,
        attemptLookup: staticLookup({ found: false, reason: "EXECUTION_NOT_FOUND" }),
        logger,
        metrics,
        handlers,
      });
      expect(outcome).toEqual({ kind: "ORPHAN", reason: "EXECUTION_NOT_FOUND" });
      expect(calls).toHaveLength(0);
      expect(logger.calls).toHaveLength(1);
      expect(metrics.count).toBe(1);
    });
  });

  describe("Lambda Destinations normalization + correlation (FR-04 'native AWS results')", () => {
    it("normalizes a PASSED worker result and routes it as QUALITY_COMPLETED", async () => {
      const record = loadFixture("lambda-destinations-success-passed.json");
      const calls: unknown[] = [];
      const outcome = await routeEvent(record, {
        envelopeValidator,
        attemptLookup: staticLookup({
          found: true,
          pipelineId: "prms-reporting-dev",
          environment: "dev",
          attempt: 1,
          status: "RUNNING",
          dispatchToken: "dispatch-token-0001",
        }),
        logger: fakeLogger(),
        metrics: fakeMetrics(),
        handlers: { QUALITY_COMPLETED: (envelope) => { calls.push(envelope); } },
      });
      expect(outcome.kind).toBe("ROUTED");
      expect(calls).toHaveLength(1);
      expect((outcome as { envelope: { attempt?: number; pipelineId?: string } }).envelope.attempt).toBe(1);
      expect((outcome as { envelope: { attempt?: number; pipelineId?: string } }).envelope.pipelineId).toBe(
        "prms-reporting-dev",
      );
    });

    it("is ORPHAN_EVENT (STALE_ATTEMPT) when the result's dispatchToken does not match the current attempt's — a stale Lambda attempt never mutates the current one even while RUNNING", async () => {
      const record = loadFixture("lambda-destinations-success-passed.json");
      const calls: unknown[] = [];
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const outcome = await routeEvent(record, {
        envelopeValidator,
        attemptLookup: staticLookup({
          found: true,
          pipelineId: "prms-reporting-dev",
          environment: "dev",
          attempt: 2,
          status: "RUNNING",
          // Current attempt's token, minted by a later DISPATCHING (T10)
          // than the one that produced the fixture's "dispatch-token-0001".
          dispatchToken: "dispatch-token-0002",
        }),
        logger,
        metrics,
        handlers: { QUALITY_COMPLETED: () => { calls.push(1); } },
      });
      expect(outcome).toEqual({ kind: "ORPHAN", reason: "STALE_ATTEMPT" });
      expect(calls).toHaveLength(0);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0]?.reason).toBe("STALE_ATTEMPT");
      expect(metrics.count).toBe(1);
    });

    it("routes a Lambda result whose dispatchToken matches the current attempt even while the step is still DISPATCHING (no externalRef registered yet) — Lambda has no early-arrival race", async () => {
      const record = loadFixture("lambda-destinations-success-passed.json");
      const calls: unknown[] = [];
      const outcome = await routeEvent(record, {
        envelopeValidator,
        attemptLookup: staticLookup({
          found: true,
          pipelineId: "prms-reporting-dev",
          environment: "dev",
          attempt: 1,
          status: "DISPATCHING",
          dispatchToken: "dispatch-token-0001",
          externalRef: undefined,
        }),
        logger: fakeLogger(),
        metrics: fakeMetrics(),
        handlers: { QUALITY_COMPLETED: (envelope) => { calls.push(envelope); } },
      });
      expect(outcome.kind).toBe("ROUTED");
      expect(calls).toHaveLength(1);
    });
  });

  describe("orphan detection (FR-04 'orphan event', design §6.1)", () => {
    it("is ORPHAN_EVENT when the executionId does not exist, and never invokes a handler", async () => {
      const record = loadFixture("codebuild-state-change-succeeded.json");
      const calls: unknown[] = [];
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const outcome = await routeEvent(record, {
        envelopeValidator,
        attemptLookup: staticLookup({ found: false, reason: "EXECUTION_NOT_FOUND" }),
        logger,
        metrics,
        handlers: { BUILD_COMPLETED: () => { calls.push(1); } },
      });
      expect(outcome).toEqual({ kind: "ORPHAN", reason: "EXECUTION_NOT_FOUND" });
      expect(calls).toHaveLength(0);
      expect(logger.calls).toEqual([
        expect.objectContaining({ reason: "EXECUTION_NOT_FOUND", executionId: "prms-reporting-dev-184" }),
      ]);
      expect(metrics.count).toBe(1);
    });

    it("is ORPHAN_EVENT when the stepId does not exist in that execution, and never invokes a handler", async () => {
      const record = loadFixture("codebuild-state-change-succeeded.json");
      const calls: unknown[] = [];
      const outcome = await routeEvent(record, {
        envelopeValidator,
        attemptLookup: staticLookup({ found: false, reason: "STEP_NOT_FOUND" }),
        logger: fakeLogger(),
        metrics: fakeMetrics(),
        handlers: { BUILD_COMPLETED: () => { calls.push(1); } },
      });
      expect(outcome).toEqual({ kind: "ORPHAN", reason: "STEP_NOT_FOUND" });
      expect(calls).toHaveLength(0);
    });

    it("is ORPHAN_EVENT (STALE_ATTEMPT) when the build-id does not match the current attempt's externalRef — a superseded attempt's result never mutates the current one", async () => {
      // This fixture (design §6.1 "the result of a previous,
      // already-superseded attempt") carries build-id "...build-STALE-0000", but the
      // lookup below reports the CURRENT attempt's externalRef as a
      // DIFFERENT build id — simulating a late result from a step that was
      // already retried (T10) under a new dispatch.
      const record = loadFixture("codebuild-state-change-previous-attempt.json");
      const calls: unknown[] = [];
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const outcome = await routeEvent(record, {
        envelopeValidator,
        attemptLookup: staticLookup({
          found: true,
          pipelineId: "prms-reporting-dev",
          environment: "dev",
          attempt: 2,
          status: "RUNNING",
          externalRef: "arn:aws:codebuild:<AWS_REGION>:<AWS_ACCOUNT_ID>:build/prms-reporting-dev:build-CURRENT-0001",
        }),
        logger,
        metrics,
        handlers: { BUILD_COMPLETED: () => { calls.push(1); } },
      });
      expect(outcome).toEqual({ kind: "ORPHAN", reason: "STALE_ATTEMPT" });
      expect(calls).toHaveLength(0);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0]?.reason).toBe("STALE_ATTEMPT");
      expect(metrics.count).toBe(1);
    });

    it("is RETRY_LATER (not ORPHAN) for a CodeBuild result while the current attempt is still DISPATCHING with no externalRef registered yet — the early-arrival race (design §6.1/§6.4) must not be acked as an orphan, or a valid result would be lost", async () => {
      const record = loadFixture("codebuild-state-change-succeeded.json");
      const calls: unknown[] = [];
      const logger = fakeLogger();
      const metrics = fakeMetrics();
      const outcome = await routeEvent(record, {
        envelopeValidator,
        attemptLookup: staticLookup({
          found: true,
          pipelineId: "prms-reporting-dev",
          environment: "dev",
          attempt: 1,
          status: "DISPATCHING",
          dispatchToken: "dispatch-token-codebuild-0001",
          externalRef: undefined,
        }),
        logger,
        metrics,
        handlers: { BUILD_COMPLETED: () => { calls.push(1); } },
      });
      expect(outcome).toEqual({ kind: "RETRY_LATER", reason: "EXTERNAL_REF_NOT_YET_REGISTERED" });
      expect(calls).toHaveLength(0);
      // Not an orphan: no log, no metric, and — critically for the
      // consumer's ack/no-ack decision — a distinct outcome kind.
      expect(logger.calls).toHaveLength(0);
      expect(metrics.count).toBe(0);
    });
  });

  describe("poison path (FR-04 'poisoned message')", () => {
    it("throws MalformedEventError for a message that is neither a valid envelope nor a recognized AWS-native shape", async () => {
      await expect(
        routeEvent(
          { garbage: true },
          {
            envelopeValidator,
            attemptLookup: staticLookup({ found: false, reason: "EXECUTION_NOT_FOUND" }),
            logger: fakeLogger(),
            metrics: fakeMetrics(),
            handlers: {},
          },
        ),
      ).rejects.toThrow(MalformedEventError);
    });

    it("throws MalformedEventError for an envelope that fails schema validation (missing required eventType)", async () => {
      const broken = { ...validBuildCompletedEnvelope } as Record<string, unknown>;
      delete broken.eventType;
      await expect(
        routeEvent(broken, {
          envelopeValidator,
          attemptLookup: staticLookup({ found: false, reason: "EXECUTION_NOT_FOUND" }),
          logger: fakeLogger(),
          metrics: fakeMetrics(),
          handlers: {},
        }),
      ).rejects.toThrow(MalformedEventError);
    });

    it("includes Ajv's path/message details (never payload values) on MalformedEventError when the re-validated, normalized envelope fails schema validation", async () => {
      const record = loadFixture("codebuild-state-change-succeeded.json");
      await expect(
        routeEvent(record, {
          envelopeValidator,
          attemptLookup: staticLookup({
            found: true,
            pipelineId: "prms-reporting-dev",
            environment: "dev",
            // Invalid on purpose (schema: `attempt` has `minimum: 1`) so the
            // defense-in-depth re-validation after normalization fails.
            attempt: 0,
            status: "RUNNING",
            externalRef: "arn:aws:codebuild:<AWS_REGION>:<AWS_ACCOUNT_ID>:build/prms-reporting-dev:build-aaaa0001",
          }),
          logger: fakeLogger(),
          metrics: fakeMetrics(),
          handlers: {},
        }),
      ).rejects.toMatchObject({
        name: "MalformedEventError",
        schemaErrors: expect.arrayContaining([expect.stringContaining("attempt")]),
      });
    });
  });
});

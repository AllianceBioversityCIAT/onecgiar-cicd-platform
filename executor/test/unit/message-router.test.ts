// @akili-spec changes/cicd-executor-poc design §6.1, §6.4, §7 (message-router row), §3.3; requirements FR-03, FR-04, RL-3
//
// One test per router outcome, including every rejection path. The schemas are
// the REAL repo-root deploy-request.schema.json and event.schema.json, loaded
// through the DefinitionSource port (DD-19) via the in-memory fake. The sender
// authorizer (N-06) and the definition lookup are fakes.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createMessageValidators,
  routeMessage,
  type DeploymentSourceLookup,
  type MessageHandlers,
  type MessageRouterDeps,
  type Rejection,
  type SenderAuthorizer,
  type ValidatedDeployRequest,
} from "../../src/application/message-router/index.js";
import { MAX_BODY_BYTES } from "../../src/domain/request-contract/index.js";
import { applyTransition } from "../../src/domain/state-machine/index.js";
import { deployRequestSchemaPath, eventSchemaPath } from "../contract/support/schema-paths.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";

const SOURCE = {
  repository: "example-org/example-app",
  workflowRef: "example-org/platform-workflows/.github/workflows/deploy.yml@refs/heads/main",
};

const validRequest = {
  specVersion: 1,
  eventType: "DEPLOY_REQUESTED",
  requestId: "9876543210-1",
  deploymentId: "example-app-dev",
  commitSha: "a".repeat(40),
  artifacts: { server: `sha256:${"b".repeat(64)}` },
  ci: { ...SOURCE, runId: "9876543210", runAttempt: 1, runNumber: 42 },
};

const LOCK_KEY = "deployment#<EXAMPLE_TARGET>#example-app-dev-unit";
const internalEvents: Record<string, { event: Record<string, unknown>; handler: keyof MessageHandlers }> = {
  LOCK_RETRY_REQUESTED: {
    handler: "lockRetryRequested",
    event: {
      specVersion: 1, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f1", eventType: "LOCK_RETRY_REQUESTED",
      timestamp: "2026-10-05T12:00:00Z", source: "executor", executionId: "example-app-dev-184", attempt: 2,
    },
  },
  RECONCILE_TICK: {
    handler: "reconcileTick",
    event: {
      specVersion: 1, eventType: "RECONCILE_TICK",
      timestamp: "2026-10-05T12:00:00Z", source: "scheduler",
    },
  },
  DEPLOY_WINDOW_OPEN_REQUESTED: {
    handler: "deployWindowOpenRequested",
    event: {
      specVersion: 1, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f3", eventType: "DEPLOY_WINDOW_OPEN_REQUESTED",
      timestamp: "2026-10-05T12:00:00Z", source: "operator", lockKey: LOCK_KEY, openedBy: "operator-1",
      externalJobsDisabled: ["<EXTERNAL_JOB_ID>"], closesAt: "2026-10-05T14:00:00Z",
    },
  },
  DEPLOY_WINDOW_CLOSE_REQUESTED: {
    handler: "deployWindowCloseRequested",
    event: {
      specVersion: 1, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f4", eventType: "DEPLOY_WINDOW_CLOSE_REQUESTED",
      timestamp: "2026-10-05T12:00:00Z", source: "operator", lockKey: LOCK_KEY, closedBy: "operator-1",
    },
  },
  TARGET_RESOLUTION_RECORDED: {
    handler: "targetResolutionRecorded",
    event: {
      specVersion: 1, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f5", eventType: "TARGET_RESOLUTION_RECORDED",
      timestamp: "2026-10-05T12:00:00Z", source: "operator", lockKey: LOCK_KEY, executionId: "example-app-dev-184",
      resolvedBy: "operator-1", observedDigests: { server: `sha256:${"c".repeat(64)}` },
    },
  },
};

interface Harness {
  readonly deps: MessageRouterDeps;
  readonly calls: Array<{ handler: string; arg: unknown }>;
  readonly authorizeCalls: Array<Record<string, unknown>>;
}

function harness(options: {
  authorize?: (request: Parameters<SenderAuthorizer["decide"]>[0]) => boolean;
  resolveSource?: DeploymentSourceLookup["resolveSource"];
  handlerFailure?: Error;
} = {}): Harness {
  const calls: Harness["calls"] = [];
  const authorizeCalls: Harness["authorizeCalls"] = [];
  const record = (handler: string) => async (arg: unknown): Promise<void> => {
    calls.push({ handler, arg });
    if (options.handlerFailure !== undefined) throw options.handlerFailure;
  };
  const handlers: MessageHandlers = {
    deployRequested: record("deployRequested"),
    rejected: record("rejected"),
    unauthorizedInternalEvent: record("unauthorizedInternalEvent"),
    lockRetryRequested: record("lockRetryRequested"),
    reconcileTick: record("reconcileTick"),
    deployWindowOpenRequested: record("deployWindowOpenRequested"),
    deployWindowCloseRequested: record("deployWindowCloseRequested"),
    targetResolutionRecorded: record("targetResolutionRecorded"),
  };
  return {
    calls,
    authorizeCalls,
    deps: {
      validators,
      handlers,
      authorizer: {
        decide(request) {
          authorizeCalls.push({ ...request });
          return { authorized: options.authorize === undefined ? true : options.authorize(request), senderRef: "ROLE_ID_REF" };
        },
      },
      sources: {
        resolveSource: options.resolveSource ?? (async (id) => (id === "example-app-dev" ? SOURCE : undefined)),
      },
    },
  };
}

let validators: MessageRouterDeps["validators"];

beforeAll(async () => {
  validators = await createMessageValidators(
    new InMemoryDefinitionSource({
      schemas: {
        "deploy-request.schema.json": readFileSync(deployRequestSchemaPath, "utf8"),
        "event.schema.json": readFileSync(eventSchemaPath, "utf8"),
      },
    }),
  );
});

const body = (value: unknown): string => JSON.stringify(value);
const rejectedCall = (h: Harness): Rejection => h.calls.find((c) => c.handler === "rejected")!.arg as Rejection;

describe("message-router: DEPLOY_REQUESTED", () => {
  it("routes a valid request to the deploy handler and the creation checks lead to X1 (FR-03)", async () => {
    const h = harness();
    const result = await routeMessage({ body: body(validRequest), senderId: "ROLE_ID_1:session" }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "HANDLED", eventType: "DEPLOY_REQUESTED" });
    expect(h.calls.map((c) => c.handler)).toEqual(["deployRequested"]);
    const validated = h.calls[0]!.arg as ValidatedDeployRequest;
    expect(validated.request.deploymentId).toBe("example-app-dev");
    expect(validated.source).toEqual(SOURCE);
    // The dedupe claim belongs to execution-service; with it, the state machine yields X1.
    const created = applyTransition(null, { kind: "CREATE", checks: { ...validated.checks, dedupeClaimOwned: true } });
    expect(created).toMatchObject({ accepted: true, transitionId: "X1" });
  });

  it("a schema-invalid but parseable request is REJECTED via X2 SCHEMA_INVALID and acknowledged (FR-04, RL-3)", async () => {
    const h = harness();
    const result = await routeMessage({ body: body({ ...validRequest, host: "<HOST>" }) }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "REJECTED", reason: "SCHEMA_INVALID" });
    expect(h.calls.map((c) => c.handler)).toEqual(["rejected"]);
    const rejection = rejectedCall(h);
    expect(rejection).toMatchObject({ transitionId: "X2", reason: "SCHEMA_INVALID", requestId: "9876543210-1" });
    expect(rejection.details).toContain("(root) additionalProperties host");
  });

  it("an image tag instead of a digest is REJECTED with the violated rule recorded (FR-03)", async () => {
    const h = harness();
    const result = await routeMessage({ body: body({ ...validRequest, artifacts: { server: "latest" } }) }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "REJECTED", reason: "SCHEMA_INVALID" });
    expect(rejectedCall(h).details).toContain("/artifacts/server pattern");
  });

  it("a requestId that differs from ci.runId-ci.runAttempt is REJECTED via X2 REQUEST_ID_MISMATCH (CC-2)", async () => {
    const h = harness();
    const result = await routeMessage({ body: body({ ...validRequest, requestId: "9876543210-2" }) }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "REJECTED", reason: "REQUEST_ID_MISMATCH" });
    expect(h.calls.map((c) => c.handler)).toEqual(["rejected"]);
  });

  it("an unknown deployment is REJECTED via X2 UNKNOWN_DEPLOYMENT and acknowledged (FR-03)", async () => {
    const h = harness();
    const result = await routeMessage({ body: body({ ...validRequest, deploymentId: "no-such-deployment" }) }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "REJECTED", reason: "UNKNOWN_DEPLOYMENT" });
  });

  it.each([
    ["ci.repository", { repository: "example-org/another-app" }],
    ["ci.workflowRef", { workflowRef: "example-org/platform-workflows/.github/workflows/other.yml@refs/heads/main" }],
  ])("a %s that differs from the resolved source is REJECTED via X2 CONSISTENCY_MISMATCH", async (_field, ci) => {
    const h = harness();
    const result = await routeMessage({ body: body({ ...validRequest, ci: { ...validRequest.ci, ...ci } }) }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "REJECTED", reason: "CONSISTENCY_MISMATCH" });
    expect(h.calls.map((c) => c.handler)).toEqual(["rejected"]);
  });

  it("an unauthorized sender is REJECTED via X2 UNAUTHORIZED_SENDER before any other check (DD-25)", async () => {
    const h = harness({ authorize: () => false });
    // The body is also schema-invalid: the first reason in the closed order wins.
    const result = await routeMessage({ body: body({ ...validRequest, host: "<HOST>" }), senderId: "ROLE_ID_X:s" }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "REJECTED", reason: "UNAUTHORIZED_SENDER" });
  });

  it("never passes the body `source` or `ci` fields to the authorizer; only senderId, eventType and the lookup key (DD-25)", async () => {
    const h = harness();
    await routeMessage({ body: body(validRequest), senderId: "ROLE_ID_1:session" }, h.deps);
    await routeMessage({ body: body(internalEvents["RECONCILE_TICK"]!.event), senderId: "ROLE_ID_2:session" }, h.deps);

    expect(h.authorizeCalls).toEqual([
      { senderId: "ROLE_ID_1:session", eventType: "DEPLOY_REQUESTED", deploymentId: "example-app-dev" },
      { senderId: "ROLE_ID_2:session", eventType: "RECONCILE_TICK" },
    ]);
  });

  it("a handler failure propagates so the message is not acknowledged and SQS redelivers it", async () => {
    const h = harness({ handlerFailure: new Error("state store unavailable") });
    await expect(routeMessage({ body: body(validRequest) }, h.deps)).rejects.toThrow("state store unavailable");
  });
});

describe("message-router: unparseable messages are never acknowledged (RL-3)", () => {
  it.each([
    ["not JSON", "this is not json {", "NOT_JSON"],
    ["an empty body", "", "NOT_JSON"],
    ["a JSON array", "[1,2,3]", "NOT_AN_OBJECT"],
    ["JSON null", "null", "NOT_AN_OBJECT"],
    ["a JSON string", '"DEPLOY_REQUESTED"', "NOT_AN_OBJECT"],
  ])("%s -> no ack", async (_name, raw, reason) => {
    const h = harness();
    const result = await routeMessage({ body: raw }, h.deps);

    expect(result).toMatchObject({ ack: false, outcome: "UNROUTABLE", reason });
    expect(h.calls).toEqual([]);
    expect(h.authorizeCalls).toEqual([]);
  });

  it("a body larger than 8 KB -> no ack, even if it is otherwise a valid request", async () => {
    const h = harness();
    const json = body(validRequest);
    const oversized = json + " ".repeat(MAX_BODY_BYTES + 1 - Buffer.byteLength(json));
    expect(Buffer.byteLength(oversized)).toBe(MAX_BODY_BYTES + 1);

    const result = await routeMessage({ body: oversized }, h.deps);

    expect(result).toMatchObject({ ack: false, outcome: "UNROUTABLE", reason: "BODY_TOO_LARGE" });
    expect(h.calls).toEqual([]);
  });

  it("a body of exactly 8 KB is still accepted (boundary)", async () => {
    const h = harness();
    const json = body(validRequest);
    const exact = json + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(json));

    const result = await routeMessage({ body: exact }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "HANDLED", eventType: "DEPLOY_REQUESTED" });
  });

  it("the size limit counts bytes, not characters", async () => {
    const h = harness();
    const multibyte = body({ ...validRequest, note: "é".repeat(4200) }); // 4,200 characters, ~8,400 bytes
    expect(multibyte.length).toBeLessThan(MAX_BODY_BYTES);

    const result = await routeMessage({ body: multibyte }, h.deps);

    expect(result).toMatchObject({ ack: false, reason: "BODY_TOO_LARGE" });
  });
});

describe("message-router: eventType routing", () => {
  it.each([
    ["a removed type (PIPELINE_REQUESTED)", { ...validRequest, eventType: "PIPELINE_REQUESTED" }],
    ["a removed CI type (BUILD_COMPLETED)", { eventType: "BUILD_COMPLETED" }],
    ["a missing eventType", { ...validRequest, eventType: undefined }],
    ["a non-string eventType", { ...validRequest, eventType: 7 }],
  ])("%s -> no ack (no execution to reject; left for the DLQ and its alarm)", async (_name, raw) => {
    const h = harness();
    const result = await routeMessage({ body: body(raw) }, h.deps);

    expect(result).toMatchObject({ ack: false, outcome: "UNROUTABLE", reason: "UNKNOWN_EVENT_TYPE" });
    expect(h.calls).toEqual([]);
  });

  it.each(Object.entries(internalEvents))("routes a valid %s to its own handler only", async (type, { event, handler }) => {
    const h = harness();
    const result = await routeMessage({ body: body(event) }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "HANDLED", eventType: type });
    expect(h.calls).toEqual([{ handler, arg: event }]);
  });

  it.each(Object.entries(internalEvents))("%s with a field of another type is rejected by the schema -> no ack, no handler", async (type, { event }) => {
    const h = harness();
    // `closedBy` belongs only to DEPLOY_WINDOW_CLOSE_REQUESTED; for that type use `attempt` (LOCK_RETRY only).
    const foreign = type === "DEPLOY_WINDOW_CLOSE_REQUESTED" ? { attempt: 1 } : { closedBy: "operator-1" };
    const result = await routeMessage({ body: body({ ...event, ...foreign }) }, h.deps);

    expect(result).toMatchObject({ ack: false, outcome: "UNROUTABLE", reason: "INVALID_INTERNAL_EVENT" });
    expect((result as unknown as { details: string[] }).details.join(" ")).toMatch(/unevaluatedProperties/);
    expect(h.calls).toEqual([]);
  });

  it("an internal event from an unauthorized sender is acknowledged without invoking its handler (DD-25)", async () => {
    const h = harness({ authorize: () => false });
    const result = await routeMessage({ body: body(internalEvents["RECONCILE_TICK"]!.event), senderId: "ROLE_ID_X:s" }, h.deps);

    expect(result).toEqual({ ack: true, outcome: "UNAUTHORIZED", eventType: "RECONCILE_TICK" });
    expect(h.calls).toEqual([{ handler: "unauthorizedInternalEvent", arg: { eventType: "RECONCILE_TICK", senderId: "ROLE_ID_X:s" } }]);
  });

  it("a RECONCILE_TICK carrying an eventId is schema-invalid: the sender does not supply the correlation id (G-8)", async () => {
    const h = harness();
    const result = await routeMessage(
      { body: body({ ...internalEvents["RECONCILE_TICK"]!.event, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f2" }), senderId: "ROLE_ID_2:session" },
      h.deps,
    );

    expect(result).toMatchObject({ ack: false, reason: "INVALID_INTERNAL_EVENT" });
  });

  it("an event type that does not match its sender class in the body is schema-invalid (RECONCILE_TICK claiming operator)", async () => {
    const h = harness();
    const result = await routeMessage({ body: body({ ...internalEvents["RECONCILE_TICK"]!.event, source: "operator" }) }, h.deps);

    expect(result).toMatchObject({ ack: false, reason: "INVALID_INTERNAL_EVENT" });
  });
});

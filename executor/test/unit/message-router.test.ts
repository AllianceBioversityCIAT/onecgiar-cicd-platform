// @akili-spec changes/cicd-executor-poc design §1.2, §3.3, §6.1, §6.3, §6.4, §7 (message-router row), §7.3 (X1, X2), DD-25; requirements FR-02, FR-03, FR-04, FR-21, RL-3; tasks R-4 (AC-02 V1)
//
// One test per router outcome, including every rejection path. The schemas are
// the REAL repo-root deploy-request.schema.json and event.schema.json, loaded
// through the DefinitionSource port via the in-memory fake. The sender
// authorizer, the Target Registry and the dedupe lookup are fakes that record
// their calls, so "no read, no write before authorization" is observable.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createMessageValidators,
  DedupeClaimPendingError,
  routeMessage,
  type DedupeLookup,
  type MessageHandlers,
  type MessageRouterDeps,
  type Rejection,
  type SenderAuthorizer,
  type ValidatedDeployRequest,
} from "../../src/application/message-router/index.js";
import { createSenderAuthorizer } from "../../src/application/sender-authorizer/index.js";
import { MAX_BODY_BYTES } from "../../src/domain/request-contract/index.js";
import { applyTransition } from "../../src/domain/state-machine/index.js";
import type { TargetLookup, TargetRecord } from "../../src/ports/target-registry.js";
import { deployRequestSchemaPath, eventSchemaPath } from "../contract/support/schema-paths.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";

const TARGET_ID = "example-app-dev";
const REPO_ID = "123456789";
const OTHER_REPO_ID = "987654321";
const NOW = 1_800_000_000_000;

const target: TargetRecord = {
  targetId: TARGET_ID,
  project: "example",
  environment: "dev",
  host: "target.example.internal",
  user: "deploy",
  hostKey: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample"],
  credentialRef: "cicd-poc/dev/example-app-dev/ssh",
  deployScript: "/opt/cicd/example-app/deploy.sh",
  deployWindowPolicy: "required",
  sourceRepositoryId: REPO_ID,
  schemaVersion: 1,
  version: 1,
  updatedAt: "2026-10-07T12:00:00Z",
  updatedBy: "platform-admin",
};

const validRequest = {
  specVersion: 1,
  eventType: "DEPLOY_REQUESTED",
  requestId: "9876543210-1",
  targetId: TARGET_ID,
  commitSha: "a".repeat(40),
  artifacts: { server: `sha256:${"b".repeat(64)}` },
  ci: {
    repository: "example-org/example-app",
    workflowRef: "example-org/example-app/.github/workflows/deploy.yml@refs/heads/main",
    runId: "9876543210",
    runAttempt: 1,
    runNumber: 42,
  },
};

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
    event: { specVersion: 1, eventType: "RECONCILE_TICK", timestamp: "2026-10-05T12:00:00Z", source: "scheduler" },
  },
  DEPLOY_WINDOW_OPEN_REQUESTED: {
    handler: "deployWindowOpenRequested",
    event: {
      specVersion: 1, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f3", eventType: "DEPLOY_WINDOW_OPEN_REQUESTED",
      timestamp: "2026-10-05T12:00:00Z", source: "operator", targetId: TARGET_ID, openedBy: "operator-1",
      externalJobsDisabled: ["<EXTERNAL_JOB_ID>"], closesAt: "2026-10-05T14:00:00Z",
    },
  },
  DEPLOY_WINDOW_CLOSE_REQUESTED: {
    handler: "deployWindowCloseRequested",
    event: {
      specVersion: 1, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f4", eventType: "DEPLOY_WINDOW_CLOSE_REQUESTED",
      timestamp: "2026-10-05T12:00:00Z", source: "operator", targetId: TARGET_ID, closedBy: "operator-1",
    },
  },
  TARGET_RESOLUTION_RECORDED: {
    handler: "targetResolutionRecorded",
    event: {
      specVersion: 1, eventId: "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f5", eventType: "TARGET_RESOLUTION_RECORDED",
      timestamp: "2026-10-05T12:00:00Z", source: "operator", targetId: TARGET_ID, executionId: "example-app-dev-184",
      resolvedBy: "operator-1", observedDigests: { server: `sha256:${"c".repeat(64)}` },
    },
  },
};

type DedupeView = Awaited<ReturnType<DedupeLookup["get"]>>;

interface Harness {
  readonly deps: MessageRouterDeps;
  readonly calls: Array<{ handler: string; arg: unknown }>;
  readonly authorizeCalls: Array<Record<string, unknown>>;
  readonly targetCalls: string[];
  readonly dedupeCalls: Array<[string, string]>;
}

function harness(options: {
  decide?: SenderAuthorizer["decide"];
  lookup?: TargetLookup;
  dedupe?: DedupeView;
  handlerFailure?: Error;
} = {}): Harness {
  const calls: Harness["calls"] = [];
  const authorizeCalls: Harness["authorizeCalls"] = [];
  const targetCalls: string[] = [];
  const dedupeCalls: Harness["dedupeCalls"] = [];
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
    targetCalls,
    dedupeCalls,
    deps: {
      validators,
      handlers,
      clock: { now: () => new Date(NOW) },
      authorizer: {
        decide(request) {
          authorizeCalls.push({ ...request });
          return options.decide?.(request) ?? { authorized: true, senderRef: "ROLE_ID_REF", sourceRepositoryId: REPO_ID };
        },
      },
      targets: {
        async getTarget(id) {
          targetCalls.push(id);
          return options.lookup ?? { kind: "found", target };
        },
      },
      dedupe: {
        async get(id, requestId) {
          dedupeCalls.push([id, requestId]);
          return options.dedupe;
        },
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
const msg = (value: unknown, extra: { senderId?: string; messageId?: string } = {}) => ({ body: body(value), messageId: "m-1", ...extra });
const rejectedCall = (h: Harness): Rejection => h.calls.find((c) => c.handler === "rejected")!.arg as Rejection;

describe("message-router: DEPLOY_REQUESTED accepted", () => {
  it("routes a valid request with the validated target to the deploy handler; the checks lead to X1 (FR-03)", async () => {
    const h = harness();
    const result = await routeMessage(msg(validRequest), h.deps);

    expect(result).toEqual({ ack: true, outcome: "HANDLED", eventType: "DEPLOY_REQUESTED" });
    const validated = h.calls[0]!.arg as ValidatedDeployRequest;
    expect(h.calls.map((c) => c.handler)).toEqual(["deployRequested"]);
    expect(validated.request).toEqual(validRequest);
    expect(validated.target).toEqual(target);
    expect(validated.senderRef).toBe("ROLE_ID_REF");
    const x1 = applyTransition(null, { kind: "CREATE", checks: { ...validated.checks, dedupeClaimOwned: true } });
    expect(x1).toMatchObject({ accepted: true, transitionId: "X1" });
    expect(h.targetCalls).toEqual([TARGET_ID]);
    expect(h.dedupeCalls).toEqual([]);
  });

  it("passes only senderId and eventType to the authorizer, never a body field (DD-25)", async () => {
    const h = harness();
    await routeMessage(msg({ ...validRequest, source: "operator" }, { senderId: "ROLE:123456789" }), h.deps);
    expect(h.authorizeCalls).toEqual([{ senderId: "ROLE:123456789", eventType: "DEPLOY_REQUESTED" }]);
  });
});

describe("message-router: DEPLOY_REQUESTED rejected (X2, REJECT#MSG#)", () => {
  it("an unauthorized sender is REJECTED (UNAUTHORIZED_SENDER) before any other check: no schema, no target read, no dedupe read", async () => {
    const h = harness({ decide: () => ({ authorized: false, senderRef: "FOREIGN" }) });
    const result = await routeMessage(msg({ eventType: "DEPLOY_REQUESTED", not: "even a valid request" }), h.deps);

    expect(result).toMatchObject({ ack: true, outcome: "REJECTED", reason: "UNAUTHORIZED_SENDER" });
    expect(rejectedCall(h)).toMatchObject({ reason: "UNAUTHORIZED_SENDER", senderRef: "FOREIGN", sqsMessageId: "m-1" });
    expect(h.targetCalls).toEqual([]);
    expect(h.dedupeCalls).toEqual([]);
  });

  it("an authorized decision without a sourceRepositoryId is still UNAUTHORIZED_SENDER (fail closed)", async () => {
    const h = harness({ decide: () => ({ authorized: true, senderRef: "ROLE" }) });
    expect(await routeMessage(msg(validRequest), h.deps)).toMatchObject({ reason: "UNAUTHORIZED_SENDER" });
    expect(h.targetCalls).toEqual([]);
  });

  it.each([
    ["a schema-invalid request", { ...validRequest, commitSha: "nope" }, "/commitSha pattern"],
    ["an image tag instead of a digest", { ...validRequest, artifacts: { server: "latest" } }, "/artifacts/server pattern"],
    ["a request carrying the removed deploymentId", { ...validRequest, deploymentId: TARGET_ID }, "(root) additionalProperties deploymentId"],
    ["a request carrying a host", { ...validRequest, host: "<HOST>" }, "(root) additionalProperties host"],
    ["a request without targetId", (() => { const r: Record<string, unknown> = { ...validRequest }; delete r.targetId; return r; })(), "(root) required targetId"],
  ])("%s is REJECTED (SCHEMA_INVALID) with the violated rule recorded and no target read", async (_name, request, rule) => {
    const h = harness();
    const result = await routeMessage(msg(request), h.deps);

    expect(result).toEqual({ ack: true, outcome: "REJECTED", reason: "SCHEMA_INVALID" });
    expect(rejectedCall(h).details).toContain(rule);
    expect(h.targetCalls).toEqual([]);
  });

  it("a requestId that differs from ci.runId-ci.runAttempt is REJECTED (REQUEST_ID_MISMATCH, CC-2)", async () => {
    const h = harness();
    expect(await routeMessage(msg({ ...validRequest, requestId: "1-1" }), h.deps)).toMatchObject({ reason: "REQUEST_ID_MISMATCH" });
    expect(h.targetCalls).toEqual([]);
  });

  it("an unknown target is REJECTED (TARGET_UNKNOWN) after a read-only dedupe check finds nothing", async () => {
    const h = harness({ lookup: { kind: "missing" } });
    expect(await routeMessage(msg(validRequest), h.deps)).toMatchObject({ reason: "TARGET_UNKNOWN" });
    expect(rejectedCall(h)).toMatchObject({ targetId: TARGET_ID, requestId: "9876543210-1", sqsMessageId: "m-1" });
    expect(h.dedupeCalls).toEqual([[TARGET_ID, "9876543210-1"]]);
    expect(h.calls.map((c) => c.handler)).toEqual(["rejected"]);
  });

  it("an invalid target record is REJECTED (TARGET_INVALID) with the record's violated rules, never its values", async () => {
    const h = harness({ lookup: { kind: "invalid", problems: ["/deployScript pattern"] } });
    expect(await routeMessage(msg(validRequest), h.deps)).toMatchObject({ reason: "TARGET_INVALID" });
    expect(rejectedCall(h).details).toEqual(["/deployScript pattern"]);
  });

  it.each([
    ["an expired dedupe claim (no execution exists)", { state: "CLAIMED" as const, claimLeaseExpiresAt: NOW - 1 }],
  ])("a target rejection with %s is still REJECTED", async (_name, dedupe) => {
    const h = harness({ lookup: { kind: "missing" }, dedupe });
    expect(await routeMessage(msg(validRequest), h.deps)).toMatchObject({ outcome: "REJECTED", reason: "TARGET_UNKNOWN" });
  });

  it.each([
    ["deleted", { kind: "missing" } as TargetLookup],
    ["invalidated", { kind: "invalid", problems: ["/hostKey minItems"] } as TargetLookup],
  ])("a redelivery of an accepted (BOUND) request whose record was later %s is a no-op, not a rejection (design §6.3)", async (_name, lookup) => {
    const h = harness({ lookup, dedupe: { state: "BOUND", claimLeaseExpiresAt: 0 } });
    expect(await routeMessage(msg(validRequest), h.deps)).toEqual({ ack: true, outcome: "DUPLICATE" });
    expect(h.calls).toEqual([]);
  });

  it("a target rejection while a live dedupe claim owns the request is left for redelivery (no ack, DD-20)", async () => {
    const h = harness({ lookup: { kind: "missing" }, dedupe: { state: "CLAIMED", claimLeaseExpiresAt: NOW + 60_000 } });
    await expect(routeMessage(msg(validRequest), h.deps)).rejects.toBeInstanceOf(DedupeClaimPendingError);
    expect(h.calls).toEqual([]);
  });

  it("a request from another repository is REJECTED (TARGET_NOT_AUTHORIZED) without ANY dedupe read or handler (option A)", async () => {
    const h = harness({ decide: () => ({ authorized: true, senderRef: "CI_ROLE", sourceRepositoryId: OTHER_REPO_ID }) });
    const result = await routeMessage(msg({ ...validRequest, ci: { ...validRequest.ci, runNumber: 999_999 } }), h.deps);

    expect(result).toEqual({ ack: true, outcome: "REJECTED", reason: "TARGET_NOT_AUTHORIZED" });
    expect(h.dedupeCalls).toEqual([]);
    expect(h.calls.map((c) => c.handler)).toEqual(["rejected"]);
    expect(rejectedCall(h)).toMatchObject({ sqsMessageId: "m-1", senderRef: "CI_ROLE" });
  });

  it("a rejection without an SQS message id cannot be recorded: it is not acknowledged", async () => {
    const h = harness({ lookup: { kind: "missing" } });
    await expect(routeMessage({ body: body(validRequest) }, h.deps)).rejects.toThrow(/SQS message id/);
    expect(h.calls).toEqual([]);
  });

  it("a handler failure propagates so the message is not acknowledged and SQS redelivers it", async () => {
    const h = harness({ handlerFailure: new Error("state store unavailable") });
    await expect(routeMessage(msg(validRequest), h.deps)).rejects.toThrow("state store unavailable");
  });
});

describe("message-router with the real sender-authorizer: body identity never authorizes (option A)", () => {
  const CI = "AROAFAKEEXAMPLE0001";
  const FOREIGN = "AROAFAKEEXAMPLE0099";
  const real = () => createSenderAuthorizer({ principals: { ci: CI, executor: "AROAFAKEEXAMPLE0010", scheduler: "AROAFAKEEXAMPLE0011", operator: "AROAFAKEEXAMPLE0012" } });

  it("the CI role with the target's repository_id as session is accepted", async () => {
    const h = harness();
    const deps = { ...h.deps, authorizer: real() };
    expect(await routeMessage(msg(validRequest, { senderId: `${CI}:${REPO_ID}` }), deps)).toMatchObject({ outcome: "HANDLED" });
  });

  it("the CI role of another repository is TARGET_NOT_AUTHORIZED even when ci.repository is forged to the target's repository", async () => {
    const h = harness();
    const deps = { ...h.deps, authorizer: real() };
    const forged = { ...validRequest, ci: { ...validRequest.ci, repository: "example-org/example-app" } };
    expect(await routeMessage(msg(forged, { senderId: `${CI}:${OTHER_REPO_ID}` }), deps)).toMatchObject({ reason: "TARGET_NOT_AUTHORIZED" });
    expect(h.dedupeCalls).toEqual([]);
  });

  it("the CI role with a non-numeric session, a foreign role and a missing SenderId are UNAUTHORIZED_SENDER", async () => {
    for (const senderId of [`${CI}:gh-run-1`, `${FOREIGN}:${REPO_ID}`, undefined]) {
      const h = harness();
      const deps = { ...h.deps, authorizer: real() };
      expect(await routeMessage(msg(validRequest, senderId === undefined ? {} : { senderId }), deps)).toMatchObject({ reason: "UNAUTHORIZED_SENDER" });
      expect(h.targetCalls).toEqual([]);
    }
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
    expect(await routeMessage({ body: oversized }, h.deps)).toMatchObject({ ack: false, outcome: "UNROUTABLE", reason: "BODY_TOO_LARGE" });
    expect(h.calls).toEqual([]);
  });

  it("a body of exactly 8 KB is still accepted (boundary)", async () => {
    const h = harness();
    const json = body(validRequest);
    const exact = json + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(json));
    expect(await routeMessage({ body: exact, messageId: "m-1" }, h.deps)).toEqual({ ack: true, outcome: "HANDLED", eventType: "DEPLOY_REQUESTED" });
  });

  it("the size limit counts bytes, not characters", async () => {
    const h = harness();
    const multibyte = body({ ...validRequest, note: "é".repeat(4200) }); // 4,200 characters, ~8,400 bytes
    expect(multibyte.length).toBeLessThan(MAX_BODY_BYTES);
    expect(await routeMessage({ body: multibyte }, h.deps)).toMatchObject({ ack: false, reason: "BODY_TOO_LARGE" });
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
    expect(await routeMessage({ body: body(raw) }, h.deps)).toMatchObject({ ack: false, outcome: "UNROUTABLE", reason: "UNKNOWN_EVENT_TYPE" });
    expect(h.calls).toEqual([]);
  });

  it.each(Object.entries(internalEvents))("routes a valid %s to its own handler only", async (type, { event, handler }) => {
    const h = harness();
    const result = await routeMessage({ body: body(event) }, h.deps);
    expect(result).toEqual({ ack: true, outcome: "HANDLED", eventType: type });
    expect(h.calls.map((c) => c.handler)).toEqual([handler]);
    expect(h.calls[0]!.arg).toEqual(event);
  });

  it.each(Object.entries(internalEvents))("%s with a field of another type is rejected by the schema -> no ack, no handler", async (type, { event }) => {
    const h = harness();
    const foreign = type === "DEPLOY_WINDOW_CLOSE_REQUESTED" ? { attempt: 1 } : { closedBy: "operator-1" };
    const result = await routeMessage({ body: body({ ...event, ...foreign }) }, h.deps);
    expect(result).toMatchObject({ ack: false, outcome: "UNROUTABLE", reason: "INVALID_INTERNAL_EVENT" });
    expect((result as unknown as { details: string[] }).details.join(" ")).toMatch(/unevaluatedProperties/);
    expect(h.calls).toEqual([]);
  });

  it("an internal event from an unauthorized sender is acknowledged without invoking its handler (DD-25)", async () => {
    const h = harness({ decide: () => ({ authorized: false }) });
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
    expect(await routeMessage({ body: body({ ...internalEvents["RECONCILE_TICK"]!.event, source: "operator" }) }, h.deps)).toMatchObject({
      ack: false,
      reason: "INVALID_INTERNAL_EVENT",
    });
  });
});

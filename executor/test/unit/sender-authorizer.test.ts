// @akili-spec changes/cicd-executor-poc design DD-25, §6.4; requirements FR-21, RL-2, premise P-A4
//
// Sender authorization from the SQS SenderId (`ROLEID:session`) only. All role
// IDs are obviously fake. The forged-body tests go through the real message
// router so that a body-driven authorizer would be observable end to end.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createSenderAuthorizer,
  parseSenderId,
  type DecidingSenderAuthorizer,
} from "../../src/application/sender-authorizer/index.js";
import { createMessageValidators, routeMessage, type MessageHandlers, type MessageRouterDeps } from "../../src/application/message-router/index.js";
import { createMetrics } from "../../src/observability/metrics/index.js";
import { MESSAGE_EVENT_TYPES } from "../../src/domain/request-contract/index.js";
import { deployRequestSchemaPath, eventSchemaPath } from "../contract/support/schema-paths.js";
import { InMemoryDefinitionSource } from "../support/in-memory-definition-source.js";

const CI_A = "AROAFAKEEXAMPLE0001";
const CI_B = "AROAFAKEEXAMPLE0002";
const EXECUTOR = "AROAFAKEEXAMPLE0010";
const SCHEDULER = "AROAFAKEEXAMPLE0011";
const OPERATOR = "AROAFAKEEXAMPLE0012";
const FOREIGN = "AROAFAKEEXAMPLE0099";

const config = {
  allowedSenders: { "example-app-dev": CI_A, "other-app-dev": CI_B },
  principals: { executor: EXECUTOR, scheduler: SCHEDULER, operator: OPERATOR },
};

function make(): { authorizer: DecidingSenderAuthorizer; unauthorized: () => number } {
  const reasons: string[] = [];
  const authorizer = createSenderAuthorizer({ ...config, metrics: { recordRejectedRequest: (reason) => void reasons.push(reason) } });
  return { authorizer, unauthorized: () => reasons.length };
}

const sid = (role: string, session = "gh-run-1") => `${role}:${session}`;

describe("sender-authorizer: per-type rules (DD-25)", () => {
  it("authorizes the CI role for its own deployment and returns the role-ID prefix as senderRef", () => {
    const { authorizer } = make();
    expect(authorizer.decide({ senderId: sid(CI_A), eventType: "DEPLOY_REQUESTED", deploymentId: "example-app-dev" })).toEqual({
      authorized: true,
      senderRef: CI_A,
    });
  });

  it.each([
    ["LOCK_RETRY_REQUESTED", EXECUTOR],
    ["RECONCILE_TICK", SCHEDULER],
    ["DEPLOY_WINDOW_OPEN_REQUESTED", OPERATOR],
    ["DEPLOY_WINDOW_CLOSE_REQUESTED", OPERATOR],
    ["TARGET_RESOLUTION_RECORDED", OPERATOR],
  ] as const)("%s is authorized only for its principal class", async (eventType, role) => {
    const { authorizer } = make();
    expect(await authorizer.authorize({ senderId: sid(role), eventType })).toBe(true);
    for (const other of [EXECUTOR, SCHEDULER, OPERATOR, CI_A, FOREIGN].filter((r) => r !== role)) {
      expect(await authorizer.authorize({ senderId: sid(other), eventType })).toBe(false);
    }
  });

  it("rejects a foreign role for every event type", () => {
    const { authorizer } = make();
    for (const eventType of MESSAGE_EVENT_TYPES) {
      expect(authorizer.decide({ senderId: sid(FOREIGN), eventType, deploymentId: "example-app-dev" })).toMatchObject({
        authorized: false,
        reason: "NOT_AUTHORIZED",
        senderRef: FOREIGN,
      });
    }
  });

  it("rejects the right role with the wrong type (CI sends RECONCILE_TICK; scheduler sends DEPLOY_REQUESTED)", async () => {
    const { authorizer } = make();
    expect(await authorizer.authorize({ senderId: sid(CI_A), eventType: "RECONCILE_TICK" })).toBe(false);
    expect(await authorizer.authorize({ senderId: sid(SCHEDULER), eventType: "DEPLOY_REQUESTED", deploymentId: "example-app-dev" })).toBe(false);
  });

  it("rejects the CI role of deployment A requesting deployment B, and unknown or absent deploymentId", async () => {
    const { authorizer } = make();
    expect(await authorizer.authorize({ senderId: sid(CI_A), eventType: "DEPLOY_REQUESTED", deploymentId: "other-app-dev" })).toBe(false);
    expect(await authorizer.authorize({ senderId: sid(CI_A), eventType: "DEPLOY_REQUESTED", deploymentId: "unknown-dev" })).toBe(false);
    expect(await authorizer.authorize({ senderId: sid(CI_A), eventType: "DEPLOY_REQUESTED", deploymentId: "toString" })).toBe(false);
    expect(await authorizer.authorize({ senderId: sid(CI_A), eventType: "DEPLOY_REQUESTED" })).toBe(false);
  });

  it("ignores the caller-chosen session name: any session of the right role is authorized, a lookalike session of a foreign role is not", async () => {
    const { authorizer } = make();
    for (const session of ["gh-run-1", "gh-run-999", "x", OPERATOR, `${CI_A}:nested`]) {
      expect(await authorizer.authorize({ senderId: sid(CI_A, session), eventType: "DEPLOY_REQUESTED", deploymentId: "example-app-dev" })).toBe(true);
    }
    expect(await authorizer.authorize({ senderId: sid(FOREIGN, CI_A), eventType: "DEPLOY_REQUESTED", deploymentId: "example-app-dev" })).toBe(false);
    expect(await authorizer.authorize({ senderId: sid(FOREIGN, EXECUTOR), eventType: "LOCK_RETRY_REQUESTED" })).toBe(false);
  });

  it("never returns the session suffix in the decision", () => {
    const { authorizer } = make();
    const d = authorizer.decide({ senderId: sid(CI_A, "secret-session"), eventType: "DEPLOY_REQUESTED", deploymentId: "example-app-dev" });
    expect(JSON.stringify(d)).not.toContain("secret-session");
  });
});

describe("sender-authorizer: fail-closed on bad SenderId", () => {
  it("rejects a missing SenderId", () => {
    const { authorizer } = make();
    expect(authorizer.decide({ senderId: undefined, eventType: "RECONCILE_TICK" })).toEqual({ authorized: false, reason: "MISSING_SENDER_ID" });
    expect(authorizer.decide({ senderId: "", eventType: "RECONCILE_TICK" })).toEqual({ authorized: false, reason: "MISSING_SENDER_ID" });
  });

  it.each(["AROAFAKEEXAMPLE0011", ":gh-run-1", `${SCHEDULER}:`, "AROA FAKE:s", "AROA-FAKE:s"])(
    "rejects the malformed SenderId %j",
    (senderId) => {
      const { authorizer } = make();
      expect(authorizer.decide({ senderId, eventType: "RECONCILE_TICK" })).toMatchObject({ authorized: false, reason: "MALFORMED_SENDER_ID" });
    },
  );

  it("rejects an unknown role ID and a recreated role (new ID) until the reference is updated", async () => {
    const { authorizer } = make();
    expect(await authorizer.authorize({ senderId: sid("AROAFAKEEXAMPLE0111"), eventType: "RECONCILE_TICK" })).toBe(false);
    const recreated = createSenderAuthorizer({ ...config, principals: { ...config.principals, scheduler: "AROAFAKEEXAMPLE0211" } });
    expect(await recreated.authorize({ senderId: sid(SCHEDULER), eventType: "RECONCILE_TICK" })).toBe(false);
  });

  it("never authorizes against an empty configured role ID", async () => {
    const a = createSenderAuthorizer({ allowedSenders: { d: "" }, principals: { executor: "", scheduler: "", operator: "" } });
    expect(await a.authorize({ senderId: ":x", eventType: "RECONCILE_TICK" })).toBe(false);
    expect(await a.authorize({ senderId: "AROAFAKEEXAMPLE0001:x", eventType: "DEPLOY_REQUESTED", deploymentId: "d" })).toBe(false);
  });

  it("parseSenderId extracts only the role-ID prefix", () => {
    expect(parseSenderId(sid(CI_A))).toEqual({ roleId: CI_A });
  });
});

describe("sender-authorizer: unauthorized-sender metric", () => {
  it("emits one metric per rejection and none for an authorized sender", () => {
    const { authorizer, unauthorized } = make();
    authorizer.decide({ senderId: sid(SCHEDULER), eventType: "RECONCILE_TICK" });
    expect(unauthorized()).toBe(0);
    authorizer.decide({ senderId: sid(FOREIGN), eventType: "RECONCILE_TICK" });
    authorizer.decide({ senderId: undefined, eventType: "RECONCILE_TICK" });
    expect(unauthorized()).toBe(2);
  });

  it("the real EMF metrics object satisfies the seam and writes RejectedRequests with dimension reason=UNAUTHORIZED_SENDER", () => {
    const lines: string[] = [];
    const metrics = createMetrics({ sink: { write: (l) => void lines.push(l) }, clock: { now: () => new Date(0) } });
    createSenderAuthorizer({ ...config, metrics }).decide({ senderId: sid(FOREIGN), eventType: "RECONCILE_TICK" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ RejectedRequests: 1, reason: "UNAUTHORIZED_SENDER" });
    expect(JSON.parse(lines[0] as string)._aws.CloudWatchMetrics[0]).toMatchObject({ Dimensions: [["reason"]], Metrics: [{ Name: "RejectedRequests" }] });
  });
});

describe("sender-authorizer behind the message router: body identity is never an input", () => {
  let deps: MessageRouterDeps;
  let deployed: number;

  beforeAll(async () => {
    const source = new InMemoryDefinitionSource({ schemas: {
      "deploy-request.schema.json": readFileSync(deployRequestSchemaPath, "utf8"),
      "event.schema.json": readFileSync(eventSchemaPath, "utf8"),
    } });
    const validators = await createMessageValidators(source);
    deployed = 0;
    const noop = () => Promise.resolve();
    const handlers: MessageHandlers = {
      deployRequested: () => Promise.resolve(void deployed++),
      rejected: noop,
      unauthorizedInternalEvent: noop,
      lockRetryRequested: noop,
      reconcileTick: noop,
      deployWindowOpenRequested: noop,
      deployWindowCloseRequested: noop,
      targetResolutionRecorded: noop,
    };
    deps = {
      validators,
      authorizer: make().authorizer,
      sources: {
        resolveSource: () =>
          Promise.resolve({
            repository: "example-org/example-app",
            workflowRef: "example-org/platform-workflows/.github/workflows/deploy.yml@refs/heads/main",
          }),
      },
      handlers,
    };
  });

  const body = () =>
    JSON.stringify({
      specVersion: 1,
      eventType: "DEPLOY_REQUESTED",
      requestId: "9876543210-1",
      deploymentId: "example-app-dev",
      commitSha: "a".repeat(40),
      artifacts: { server: `sha256:${"b".repeat(64)}` },
      ci: {
        repository: "example-org/example-app",
        workflowRef: "example-org/platform-workflows/.github/workflows/deploy.yml@refs/heads/main",
        runId: "9876543210",
        runAttempt: 1,
        runNumber: 42,
      },
    });

  it("a foreign sender with a body that perfectly matches the bound source (forged ci.repository/workflowRef) is REJECTED (UNAUTHORIZED_SENDER)", async () => {
    const result = await routeMessage({ body: body(), senderId: sid(FOREIGN) }, deps);
    expect(result).toMatchObject({ ack: true, outcome: "REJECTED", reason: "UNAUTHORIZED_SENDER" });
    expect(deployed).toBe(0);
  });

  it("a forged `source` field in the body cannot authorize an internal event", async () => {
    const forged = JSON.stringify({
      specVersion: 1,
      eventId: "00000000-0000-4000-8000-000000000000",
      eventType: "RECONCILE_TICK",
      timestamp: "2026-10-06T00:00:00Z",
      source: "scheduler",
    });
    const result = await routeMessage({ body: forged, senderId: sid(FOREIGN) }, deps);
    expect(result).toMatchObject({ ack: true, outcome: "UNAUTHORIZED" });
  });

  it("the legitimate CI sender is accepted regardless of session name", async () => {
    const result = await routeMessage({ body: body(), senderId: sid(CI_A, "any-session-name") }, deps);
    expect(result).toMatchObject({ ack: true, outcome: "HANDLED" });
  });

  it("a request without SenderId is REJECTED (UNAUTHORIZED_SENDER)", async () => {
    const result = await routeMessage({ body: body() }, deps);
    expect(result).toMatchObject({ outcome: "REJECTED", reason: "UNAUTHORIZED_SENDER" });
  });
});

describe("sender-authorizer: inherited configuration is not trusted", () => {
  it("rejects a deploymentId that exists only on the prototype of allowedSenders", async () => {
    const allowedSenders = Object.create({ "inherited-dev": CI_A }) as Record<string, string>;
    const a = createSenderAuthorizer({ allowedSenders, principals: config.principals });
    expect(await a.authorize({ senderId: sid(CI_A), eventType: "DEPLOY_REQUESTED", deploymentId: "inherited-dev" })).toBe(false);
  });

  it("an authorized sender emits no metric", () => {
    const lines: string[] = [];
    const metrics = createMetrics({ sink: { write: (l) => void lines.push(l) }, clock: { now: () => new Date(0) } });
    createSenderAuthorizer({ ...config, metrics }).decide({ senderId: sid(SCHEDULER), eventType: "RECONCILE_TICK" });
    expect(lines).toEqual([]);
  });
});

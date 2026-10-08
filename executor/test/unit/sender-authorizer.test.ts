// @akili-spec changes/cicd-executor-poc design DD-24, DD-25, §6.4; requirements FR-21, RL-2, premise P-A4; tasks R-4 (AC-02 V1, option A)
//
// Sender authorization from the SQS SenderId (`ROLEID:session`) only. All role
// IDs are obviously fake. AC-02 V1: one CI role is shared by the authorized
// repositories; for DEPLOY_REQUESTED the session name is the GitHub
// repository_id forced by the CI role trust policy (option A), so the numeric
// suffix is returned as the verified `sourceRepositoryId`. For every other type
// the session name stays untrusted and is never returned. P-R1/P-R2 (that IAM
// really enforces the session name) are validated in B2, not here.
// The end-to-end checks through the router live in message-router.test.ts.
import { describe, expect, it } from "vitest";
import {
  createSenderAuthorizer,
  parseSenderId,
  type DecidingSenderAuthorizer,
} from "../../src/application/sender-authorizer/index.js";
import { createMetrics } from "../../src/observability/metrics/index.js";
import { MESSAGE_EVENT_TYPES } from "../../src/domain/request-contract/index.js";

const CI = "AROAFAKEEXAMPLE0001";
const EXECUTOR = "AROAFAKEEXAMPLE0010";
const SCHEDULER = "AROAFAKEEXAMPLE0011";
const OPERATOR = "AROAFAKEEXAMPLE0012";
const FOREIGN = "AROAFAKEEXAMPLE0099";
const REPO_ID = "123456789";

const principals = { ci: CI, executor: EXECUTOR, scheduler: SCHEDULER, operator: OPERATOR };

function make(): { authorizer: DecidingSenderAuthorizer; unauthorized: () => number } {
  const reasons: string[] = [];
  const authorizer = createSenderAuthorizer({ principals, metrics: { recordRejectedRequest: (reason) => void reasons.push(reason) } });
  return { authorizer, unauthorized: () => reasons.length };
}

const sid = (role: string, session = "gh-run-1") => `${role}:${session}`;

describe("sender-authorizer: DEPLOY_REQUESTED from the shared CI role (option A)", () => {
  it("authorizes the CI role with a numeric session and returns the role-ID prefix and the verified sourceRepositoryId", () => {
    const { authorizer } = make();
    expect(authorizer.decide({ senderId: sid(CI, REPO_ID), eventType: "DEPLOY_REQUESTED" })).toEqual({
      authorized: true,
      senderRef: CI,
      sourceRepositoryId: REPO_ID,
    });
  });

  it.each(["gh-run-1", "", "12a", "-1", "1".repeat(21), "123 456", `${REPO_ID}:x`, "0x1F"])(
    "rejects the CI role whose session %j is not a repository_id (UNAUTHORIZED_SENDER)",
    (session) => {
      const { authorizer } = make();
      const d = authorizer.decide({ senderId: `${CI}:${session}`, eventType: "DEPLOY_REQUESTED" });
      expect(d.authorized).toBe(false);
      expect(JSON.stringify(d)).not.toContain("sourceRepositoryId");
    },
  );

  it.each([EXECUTOR, SCHEDULER, OPERATOR, FOREIGN])("rejects DEPLOY_REQUESTED from %s even with a numeric session", (role) => {
    const { authorizer } = make();
    expect(authorizer.decide({ senderId: sid(role, REPO_ID), eventType: "DEPLOY_REQUESTED" })).toMatchObject({
      authorized: false,
      reason: "NOT_AUTHORIZED",
      senderRef: role,
    });
  });

  it("never returns a sourceRepositoryId for an internal event, even from the CI role with a numeric session", () => {
    const { authorizer } = make();
    const d = authorizer.decide({ senderId: sid(CI, REPO_ID), eventType: "RECONCILE_TICK" });
    expect(d.authorized).toBe(false);
    expect(JSON.stringify(d)).not.toContain(REPO_ID);
  });
});

describe("sender-authorizer: internal events (DD-25)", () => {
  it.each([
    ["LOCK_RETRY_REQUESTED", EXECUTOR],
    ["RECONCILE_TICK", SCHEDULER],
    ["DEPLOY_WINDOW_OPEN_REQUESTED", OPERATOR],
    ["DEPLOY_WINDOW_CLOSE_REQUESTED", OPERATOR],
    ["TARGET_RESOLUTION_RECORDED", OPERATOR],
  ] as const)("%s is authorized only for its principal class", async (eventType, role) => {
    const { authorizer } = make();
    expect(await authorizer.authorize({ senderId: sid(role), eventType })).toBe(true);
    for (const other of [EXECUTOR, SCHEDULER, OPERATOR, CI, FOREIGN].filter((r) => r !== role)) {
      expect(await authorizer.authorize({ senderId: sid(other), eventType })).toBe(false);
    }
  });

  it("rejects a foreign role for every event type", () => {
    const { authorizer } = make();
    for (const eventType of MESSAGE_EVENT_TYPES) {
      expect(authorizer.decide({ senderId: sid(FOREIGN, REPO_ID), eventType })).toMatchObject({
        authorized: false,
        reason: "NOT_AUTHORIZED",
        senderRef: FOREIGN,
      });
    }
  });

  it("ignores the caller-chosen session name of an internal event and never returns it", async () => {
    const { authorizer } = make();
    for (const session of ["gh-run-1", "x", OPERATOR, `${CI}:nested`, REPO_ID]) {
      const d = authorizer.decide({ senderId: sid(OPERATOR, session), eventType: "DEPLOY_WINDOW_OPEN_REQUESTED" });
      expect(d).toEqual({ authorized: true, senderRef: OPERATOR });
    }
    expect(await authorizer.authorize({ senderId: sid(FOREIGN, EXECUTOR), eventType: "LOCK_RETRY_REQUESTED" })).toBe(false);
  });
});

describe("sender-authorizer: fail-closed on bad SenderId", () => {
  it("rejects a missing SenderId", () => {
    const { authorizer } = make();
    expect(authorizer.decide({ senderId: undefined, eventType: "RECONCILE_TICK" })).toEqual({ authorized: false, reason: "MISSING_SENDER_ID" });
    expect(authorizer.decide({ senderId: "", eventType: "DEPLOY_REQUESTED" })).toEqual({ authorized: false, reason: "MISSING_SENDER_ID" });
  });

  it.each(["AROAFAKEEXAMPLE0011", ":gh-run-1", `${SCHEDULER}:`, "AROA FAKE:s", "AROA-FAKE:s"])(
    "rejects the malformed SenderId %j",
    (senderId) => {
      const { authorizer } = make();
      expect(authorizer.decide({ senderId, eventType: "RECONCILE_TICK" })).toMatchObject({ authorized: false, reason: "MALFORMED_SENDER_ID" });
    },
  );

  it("rejects a recreated role (new ID) until the reference is updated", async () => {
    const recreated = createSenderAuthorizer({ principals: { ...principals, ci: "AROAFAKEEXAMPLE0201" } });
    expect(await recreated.authorize({ senderId: sid(CI, REPO_ID), eventType: "DEPLOY_REQUESTED" })).toBe(false);
  });

  it("never authorizes against an empty configured role ID", async () => {
    const a = createSenderAuthorizer({ principals: { ci: "", executor: "", scheduler: "", operator: "" } });
    expect(await a.authorize({ senderId: ":x", eventType: "RECONCILE_TICK" })).toBe(false);
    expect(await a.authorize({ senderId: `AROAFAKEEXAMPLE0001:${REPO_ID}`, eventType: "DEPLOY_REQUESTED" })).toBe(false);
  });

  it("parseSenderId splits the role-ID prefix from the session", () => {
    expect(parseSenderId(sid(CI, REPO_ID))).toEqual({ roleId: CI, session: REPO_ID });
    expect(parseSenderId(`${CI}:${REPO_ID}:extra`)).toEqual({ roleId: CI, session: `${REPO_ID}:extra` });
  });
});

describe("sender-authorizer: unauthorized-sender metric", () => {
  it("emits one metric per rejection and none for an authorized sender", () => {
    const { authorizer, unauthorized } = make();
    authorizer.decide({ senderId: sid(SCHEDULER), eventType: "RECONCILE_TICK" });
    authorizer.decide({ senderId: sid(CI, REPO_ID), eventType: "DEPLOY_REQUESTED" });
    expect(unauthorized()).toBe(0);
    authorizer.decide({ senderId: sid(FOREIGN), eventType: "RECONCILE_TICK" });
    authorizer.decide({ senderId: undefined, eventType: "RECONCILE_TICK" });
    authorizer.decide({ senderId: sid(CI, "not-a-repository"), eventType: "DEPLOY_REQUESTED" });
    expect(unauthorized()).toBe(3);
  });

  it("the real EMF metrics object satisfies the seam and writes RejectedRequests with dimension reason=UNAUTHORIZED_SENDER", () => {
    const lines: string[] = [];
    const metrics = createMetrics({ sink: { write: (l) => void lines.push(l) }, clock: { now: () => new Date(0) } });
    createSenderAuthorizer({ principals, metrics }).decide({ senderId: sid(FOREIGN), eventType: "RECONCILE_TICK" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ RejectedRequests: 1, reason: "UNAUTHORIZED_SENDER" });
    expect(JSON.parse(lines[0] as string)._aws.CloudWatchMetrics[0]).toMatchObject({ Dimensions: [["reason"]], Metrics: [{ Name: "RejectedRequests" }] });
  });
});

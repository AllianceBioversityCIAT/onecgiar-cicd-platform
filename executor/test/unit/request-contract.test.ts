// @akili-spec changes/cicd-executor-poc design §6.1; requirements FR-03, FR-04, RL-3; tasks R-4 (AC-02 V1)
import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  parseMessageBody,
  requestIdMatches,
} from "../../src/domain/request-contract/index.js";

const ci = { repository: "example-org/example-app", workflowRef: "wf@refs/heads/main", runId: "123", runAttempt: 2, runNumber: 9 };

describe("request-contract", () => {
  it("requestId must equal `${ci.runId}-${ci.runAttempt}` (CC-2)", () => {
    expect(requestIdMatches({ requestId: "123-2", ci })).toBe(true);
    expect(requestIdMatches({ requestId: "123-1", ci })).toBe(false);
    expect(requestIdMatches({ requestId: "1232", ci })).toBe(false);
  });

  it("exposes no source-consistency check: ci.* is audit only in V1 (AC-02, design §6.1)", async () => {
    const contract = (await import("../../src/domain/request-contract/index.js")) as Record<string, unknown>;
    expect(contract["consistentWithSource"]).toBeUndefined();
  });

  it("parseMessageBody classifies bodies and never throws", () => {
    expect(parseMessageBody('{"a":1}')).toEqual({ parseable: true, value: { a: 1 } });
    expect(parseMessageBody("{")).toEqual({ parseable: false, reason: "NOT_JSON" });
    expect(parseMessageBody("[]")).toEqual({ parseable: false, reason: "NOT_AN_OBJECT" });
    expect(parseMessageBody(`{"a":"${"x".repeat(MAX_BODY_BYTES)}"}`)).toEqual({ parseable: false, reason: "BODY_TOO_LARGE" });
  });
});

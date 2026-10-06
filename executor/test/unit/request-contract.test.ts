// @akili-spec changes/cicd-executor-poc design §6.1; requirements FR-03, FR-04, RL-3
import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  consistentWithSource,
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

  it("consistency requires both ci.repository and ci.workflowRef to equal the resolved source", () => {
    const source = { repository: ci.repository, workflowRef: ci.workflowRef };
    expect(consistentWithSource({ ci }, source)).toBe(true);
    expect(consistentWithSource({ ci }, { ...source, repository: "example-org/other" })).toBe(false);
    expect(consistentWithSource({ ci }, { ...source, workflowRef: "wf@refs/heads/dev" })).toBe(false);
  });

  it("parseMessageBody classifies bodies and never throws", () => {
    expect(parseMessageBody('{"a":1}')).toEqual({ parseable: true, value: { a: 1 } });
    expect(parseMessageBody("{")).toEqual({ parseable: false, reason: "NOT_JSON" });
    expect(parseMessageBody("[]")).toEqual({ parseable: false, reason: "NOT_AN_OBJECT" });
    expect(parseMessageBody(`{"a":"${"x".repeat(MAX_BODY_BYTES)}"}`)).toEqual({ parseable: false, reason: "BODY_TOO_LARGE" });
  });
});

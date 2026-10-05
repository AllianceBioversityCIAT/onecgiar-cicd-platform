// @akili-spec changes/cicd-executor-poc design §6.1, §6.2, §6.3; requirements FR-04, FR-09, FR-10
//
// Proves the pure normalizers in src/domain/events: shape recognition
// (Lambda Destinations / EventBridge CodeBuild Build State Change) and the
// eventType classification each one must produce. Fixtures are SYNTHETIC AWS
// shapes under test/fixtures/aws/ (PROVISIONAL — see each fixture's own
// "_provisional" field; premises P-1, P-17, P-18 are UNVERIFIED per
// design.md and will be replaced by real captures in T-27/T-28).
//
// Expected eventType/status/payload values are transcribed independently
// from design §6.1's normalization table, §6.2's worker contract, §6.3's
// CodeBuild contract and FR-09's classification table — not derived from the
// module's own mapping tables — so a wrong implementation cannot satisfy
// them by construction.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MalformedEventError,
  isCodeBuildStateChangeEvent,
  isLambdaDestinationsRecord,
  normalizeCodeBuildStateChangeEvent,
  normalizeLambdaDestinationsRecord,
  type CodeBuildStateChangeEvent,
  type LambdaDestinationsRecord,
} from "../../src/domain/events/index.js";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/aws");

function loadFixture<T>(fileName: string): T {
  return JSON.parse(readFileSync(path.join(fixturesDir, fileName), "utf8")) as T;
}

describe("isLambdaDestinationsRecord / isCodeBuildStateChangeEvent — shape recognition (design §6.1)", () => {
  it("recognizes a Lambda Destinations record", () => {
    const record = loadFixture("lambda-destinations-success-passed.json");
    expect(isLambdaDestinationsRecord(record)).toBe(true);
    expect(isCodeBuildStateChangeEvent(record)).toBe(false);
  });

  it("recognizes an EventBridge CodeBuild Build State Change event", () => {
    const event = loadFixture("codebuild-state-change-succeeded.json");
    expect(isCodeBuildStateChangeEvent(event)).toBe(true);
    expect(isLambdaDestinationsRecord(event)).toBe(false);
  });

  it("rejects an arbitrary object as neither shape", () => {
    const garbage = { foo: "bar", nested: { baz: 1 } };
    expect(isLambdaDestinationsRecord(garbage)).toBe(false);
    expect(isCodeBuildStateChangeEvent(garbage)).toBe(false);
  });
});

describe("normalizeLambdaDestinationsRecord — FR-09 classification", () => {
  it("maps condition=Success, worker status=PASSED to QUALITY_COMPLETED", () => {
    const record = loadFixture<LambdaDestinationsRecord>("lambda-destinations-success-passed.json");
    const draft = normalizeLambdaDestinationsRecord(record);
    expect(draft.eventType).toBe("QUALITY_COMPLETED");
    expect(draft.executionId).toBe("prms-reporting-dev-184");
    expect(draft.stepId).toBe("server-quality");
    expect(draft.externalId).toBe("dispatch-token-0001");
    expect(draft.status).toBe("PASSED");
    expect(draft.payload?.failureCode).toBeUndefined();
  });

  it("maps condition=Success, worker status=FAILED (business failure) to QUALITY_FAILED", () => {
    const record = loadFixture<LambdaDestinationsRecord>("lambda-destinations-success-failed.json");
    const draft = normalizeLambdaDestinationsRecord(record);
    expect(draft.eventType).toBe("QUALITY_FAILED");
    expect(draft.status).toBe("FAILED");
    expect(draft.payload?.failedCommand).toBe("npm run lint");
    expect(draft.payload?.logUrl).toBe("https://<LOG_VIEWER_HOST>/prms-reporting-dev-184/client-quality");
  });

  it("maps a function error (condition=RetriesExhausted, no timeout signal) to QUALITY_FAILED with failureCode INFRA", () => {
    const record = loadFixture<LambdaDestinationsRecord>("lambda-destinations-function-error.json");
    const draft = normalizeLambdaDestinationsRecord(record);
    expect(draft.eventType).toBe("QUALITY_FAILED");
    expect(draft.payload?.failureCode).toBe("INFRA");
  });

  it("maps a function timeout (condition=RetriesExhausted, errorType=Sandbox.Timeout) to QUALITY_TIMED_OUT", () => {
    const record = loadFixture<LambdaDestinationsRecord>("lambda-destinations-timeout.json");
    const draft = normalizeLambdaDestinationsRecord(record);
    expect(draft.eventType).toBe("QUALITY_TIMED_OUT");
    expect(draft.status).toBe("TIMED_OUT");
    expect(draft.payload?.failureCode).toBeUndefined();
  });

  it("throws MalformedEventError when a Success record carries no usable responsePayload.status", () => {
    const record = loadFixture<LambdaDestinationsRecord>("lambda-destinations-success-passed.json");
    const broken: LambdaDestinationsRecord = { ...record, responsePayload: {} };
    expect(() => normalizeLambdaDestinationsRecord(broken)).toThrow(MalformedEventError);
  });
});

describe("normalizeCodeBuildStateChangeEvent — §6.3 / §7.2 classification", () => {
  it("maps build-status=SUCCEEDED to BUILD_COMPLETED, carrying imageUri/digest", () => {
    const event = loadFixture<CodeBuildStateChangeEvent>("codebuild-state-change-succeeded.json");
    const draft = normalizeCodeBuildStateChangeEvent(event);
    expect(draft.eventType).toBe("BUILD_COMPLETED");
    expect(draft.executionId).toBe("prms-reporting-dev-184");
    expect(draft.stepId).toBe("server-image");
    expect(draft.externalId).toBe(event.detail["build-id"]);
    expect(draft.payload?.imageUri).toBe("<ECR_REGISTRY>/prms-reporting-dev-server:prms-reporting-dev-184");
    expect(draft.payload?.digest).toBe("sha256:<IMAGE_DIGEST>");
  });

  it("maps build-status=FAILED to BUILD_FAILED with failureCode BUILD", () => {
    const event = loadFixture<CodeBuildStateChangeEvent>("codebuild-state-change-failed.json");
    const draft = normalizeCodeBuildStateChangeEvent(event);
    expect(draft.eventType).toBe("BUILD_FAILED");
    expect(draft.payload?.failureCode).toBe("BUILD");
  });

  it("maps build-status=STOPPED to BUILD_FAILED (design §7.2: 'Build FAILED/STOPPED' -> BUILD), same as FAILED", () => {
    const event = loadFixture<CodeBuildStateChangeEvent>("codebuild-state-change-stopped.json");
    const draft = normalizeCodeBuildStateChangeEvent(event);
    expect(draft.eventType).toBe("BUILD_FAILED");
    expect(draft.payload?.failureCode).toBe("BUILD");
  });

  it("maps build-status=TIMED_OUT to BUILD_TIMED_OUT", () => {
    const event = loadFixture<CodeBuildStateChangeEvent>("codebuild-state-change-timed-out.json");
    const draft = normalizeCodeBuildStateChangeEvent(event);
    expect(draft.eventType).toBe("BUILD_TIMED_OUT");
    expect(draft.payload?.failureCode).toBeUndefined();
  });

  it("throws MalformedEventError for a non-terminal build-status (e.g. IN_PROGRESS)", () => {
    const event = loadFixture<CodeBuildStateChangeEvent>("codebuild-state-change-succeeded.json");
    const inProgress: CodeBuildStateChangeEvent = {
      ...event,
      detail: { ...event.detail, "build-status": "IN_PROGRESS" },
    };
    expect(() => normalizeCodeBuildStateChangeEvent(inProgress)).toThrow(MalformedEventError);
  });

  it("throws MalformedEventError when EXECUTION_ID/STEP_ID overrides are missing", () => {
    const event = loadFixture<CodeBuildStateChangeEvent>("codebuild-state-change-succeeded.json");
    const withoutOverrides: CodeBuildStateChangeEvent = {
      ...event,
      detail: { ...event.detail, "additional-information": undefined },
    };
    expect(() => normalizeCodeBuildStateChangeEvent(withoutOverrides)).toThrow(MalformedEventError);
  });
});

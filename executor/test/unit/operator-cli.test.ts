// @akili-spec changes/cicd-executor-poc design §6.4, §7.7; requirements FR-24; runbook §12.2
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runOperatorCli, type CliDeps } from "../../src/operator-cli/index.js";
import { createAjv, readJsonSchema } from "../contract/support/ajv-factory.js";
import { eventSchemaPath, repoRoot } from "../contract/support/schema-paths.js";
import path from "node:path";

const validate = createAjv().compile(readJsonSchema(eventSchemaPath));
const NOW = new Date("2026-10-06T10:00:00.000Z");
const DIGEST = `sha256:${"b".repeat(64)}`;

function harness() {
  const published: Record<string, unknown>[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    clock: { now: () => NOW },
    newEventId: () => "11111111-1111-4111-8111-111111111111",
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    publisher: {
      publish: async (m) => {
        published.push(m.body);
        return { messageId: "m-1" };
      },
    },
  };
  return { deps, published, out, err };
}

describe("operator CLI", () => {
  it("open: publishes a schema-valid DEPLOY_WINDOW_OPEN_REQUESTED", async () => {
    const h = harness();
    const code = await runOperatorCli(
      ["open", "--target-id", "example-app-dev", "--opened-by", "operator-1", "--disabled", "<JOB_A>,<JOB_B>", "--disabled", "<JOB_C>", "--hours", "2", "--note", "dev test"],
      h.deps,
    );
    expect(code).toBe(0);
    const [event] = h.published;
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event).toMatchObject({
      eventType: "DEPLOY_WINDOW_OPEN_REQUESTED",
      source: "operator",
      externalJobsDisabled: ["<JOB_A>", "<JOB_B>", "<JOB_C>"],
      closesAt: "2026-10-06T12:00:00.000Z",
      note: "dev test",
    });
  });

  it("close: publishes a schema-valid DEPLOY_WINDOW_CLOSE_REQUESTED", async () => {
    const h = harness();
    expect(await runOperatorCli(["close", "--target-id", "example-app-dev", "--closed-by", "operator-1"], h.deps)).toBe(0);
    expect(validate(h.published[0]), JSON.stringify(validate.errors)).toBe(true);
    expect(h.published[0]).toMatchObject({ eventType: "DEPLOY_WINDOW_CLOSE_REQUESTED", closedBy: "operator-1" });
  });

  it("resolve-target: publishes a schema-valid TARGET_RESOLUTION_RECORDED and no ordering fields", async () => {
    const h = harness();
    const code = await runOperatorCli(
      ["resolve-target", "--target-id", "example-app-dev", "--execution-id", "exec-1", "--resolved-by", "operator-1", "--observed", `<UNIT_A>=${DIGEST}`, "--observed", `<UNIT_B>=${DIGEST}`],
      h.deps,
    );
    expect(code).toBe(0);
    const event = h.published[0] as Record<string, unknown>;
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(event["observedDigests"]).toEqual({ "<UNIT_A>": DIGEST, "<UNIT_B>": DIGEST });
    for (const field of ["lastDeployed", "highestDispatched", "highestAccepted", "sequence", "status"]) {
      expect(Object.keys(event)).not.toContain(field);
    }
  });

  it("--dry-run prints the event and does not publish", async () => {
    const h = harness();
    expect(await runOperatorCli(["close", "--target-id", "example-app-dev", "--closed-by", "o", "--dry-run"], h.deps)).toBe(0);
    expect(h.published).toEqual([]);
    expect(validate(JSON.parse(h.out[0] as string))).toBe(true);
  });

  it.each([
    [["open", "--target-id", "example-app-dev", "--opened-by", "o", "--hours", "2"]],
    [["open", "--target-id", "example-app-dev", "--opened-by", "o", "--disabled", "a"]],
    [["open", "--target-id", "example-app-dev", "--opened-by", "o", "--disabled", "a", "--hours", "1", "--closes-at", "2026-10-06T12:00:00Z"]],
    [["open", "--target-id", "example-app-dev", "--disabled", "a", "--hours", "1"]],
    [["resolve-target", "--target-id", "example-app-dev", "--execution-id", "e", "--resolved-by", "o"]],
    [["resolve-target", "--target-id", "example-app-dev", "--execution-id", "e", "--resolved-by", "o", "--observed", "u=notadigest"]],
    [["resolve-target", "--target-id", "example-app-dev", "--execution-id", "e", "--resolved-by", "o", "--observed", `u=${DIGEST}`, "--observed", `u=${DIGEST}`]],
    [["bogus"]],
    [["close", "--target-id"]],
  ])("rejects bad input %j with exit 2 and publishes nothing", async (argv) => {
    const h = harness();
    expect(await runOperatorCli(argv, h.deps)).toBe(2);
    expect(h.published).toEqual([]);
  });

  it("does not pre-judge Executor-side bounds: an over-8h closesAt is still emitted (the Executor rejects it)", async () => {
    const h = harness();
    expect(await runOperatorCli(["open", "--target-id", "example-app-dev", "--opened-by", "o", "--disabled", "a", "--hours", "9"], h.deps)).toBe(0);
    expect(validate(h.published[0])).toBe(true);
  });

  it("returns exit 1 when publishing fails", async () => {
    const h = harness();
    const deps: CliDeps = { ...h.deps, publisher: { publish: async () => Promise.reject(new Error("queue down")) } };
    expect(await runOperatorCli(["close", "--target-id", "example-app-dev", "--closed-by", "o"], deps)).toBe(1);
    expect(h.err.join("\n")).toContain("queue down");
  });

  it("the wrapper tools/resolve-target exists (runbook path)", () => {
    expect(readFileSync(path.join(repoRoot, "tools", "resolve-target"), "utf8")).toContain("resolve-target");
  });
});

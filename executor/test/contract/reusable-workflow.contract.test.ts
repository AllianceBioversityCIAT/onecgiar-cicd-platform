// @akili-spec changes/cicd-executor-poc requirements FR-22, FR-25; design DD-24, DD-26, DD-29, 6.1
//
// Static contract test for .github/workflows/deploy-request.reusable.yml (N-21, Gate A).
// The workflow is parsed as YAML and asserted by property. The request-body step and the
// guard step are also EXECUTED (bash + jq) when both are available locally; otherwise those
// tests are reported as SKIPPED, never as passed. No GitHub run happens in Gate A.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { ValidateFunction } from "ajv";
import { classifyUses } from "../../scripts/guards/action-pinning.mjs";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { deployRequestSchemaPath, repoRoot } from "./support/schema-paths.js";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  if?: string;
  [k: string]: unknown;
}
interface Job {
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  uses?: string;
  steps?: Step[];
  [k: string]: unknown;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflowPath = path.join(repoRoot, ".github", "workflows", "deploy-request.reusable.yml");
const workflowText = readFileSync(workflowPath, "utf8");
const wf = parse(workflowText) as Workflow;
const guardJob = wf.jobs["guard"]!;
const envJob = wf.jobs["push-and-send"]!;
const envSteps = envJob.steps ?? [];

/** Every string value in the parsed workflow, with its path (for scans over expressions). */
function* strings(node: unknown, at = ""): Generator<[string, string]> {
  if (typeof node === "string") yield [at, node];
  else if (Array.isArray(node)) for (const [i, v] of node.entries()) yield* strings(v, `${at}[${i}]`);
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) yield* strings(v, `${at}.${k}`);
}

function toolWorks(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0;
}
// `bash` may be a WSL stub on Windows: require that it really runs jq.
const canExecute = toolWorks("bash", ["-c", "jq --version"]);

function runScript(script: string, env: Record<string, string>) {
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
}
const posix = (p: string): string => p.split(path.sep).join("/");

describe(".github/workflows/deploy-request.reusable.yml (FR-22, FR-25, DD-24, DD-29)", () => {
  describe("triggers and permissions", () => {
    it("is a workflow_call-only workflow with deploymentId, environment and units inputs", () => {
      expect(Object.keys(wf.on)).toEqual(["workflow_call"]);
      const inputs = (wf.on["workflow_call"] as { inputs: Record<string, { type: string; required: boolean }> }).inputs;
      expect(Object.keys(inputs).sort()).toEqual(["deploymentId", "environment", "units"]);
    });

    it("grants no permissions at workflow level and none to the guard job", () => {
      expect(wf.permissions).toEqual({});
      expect(guardJob.permissions).toEqual({});
    });

    it("grants the Environment job exactly id-token: write and contents: read", () => {
      expect(envJob.permissions).toEqual({ "id-token": "write", contents: "read" });
    });
  });

  describe("guard job and event allowlist (DD-24 item 2)", () => {
    it("enforces the push / workflow_dispatch allowlist and rejects other events", () => {
      const step = guardJob.steps![0]!;
      expect(step.env?.["EVENT_NAME"]).toBe("${{ github.event_name }}");
      expect(step.run).toMatch(/push\|workflow_dispatch\)\s*;;/);
      expect(step.run).toMatch(/\*\)\s*echo[^\n]*exit 1/);
      for (const forbidden of ["pull_request", "pull_request_target", "workflow_run"]) {
        expect(step.run).not.toContain(forbidden);
      }
    });

    it("makes the Environment job depend on guard and bind an Environment from the input", () => {
      expect(envJob.needs).toBe("guard");
      expect(envJob.environment).toBe("${{ inputs.environment }}");
    });

    it("has no job-level uses (no nested reusable workflow calls)", () => {
      for (const job of Object.values(wf.jobs)) expect(job.uses).toBeUndefined();
    });
  });

  describe("bound ref (DD-24 item 2, E1)", () => {
    it("checks the bound ref in the FIRST step, before any OIDC or checkout step", () => {
      const first = envSteps[0]!;
      expect(first.uses).toBeUndefined();
      expect(first.env?.["BOUND_REF"]).toBe("${{ vars.CICD_BOUND_REF }}");
      expect(first.env?.["CURRENT_REF"]).toBe("${{ github.ref }}");
      expect(first.run).toMatch(/-z "\$\{BOUND_REF:-\}"/); // empty value fails closed
      expect(first.run).toMatch(/"\$CURRENT_REF" != "\$BOUND_REF"/);
    });

    it("references exactly the four Environment variables and uses CICD_BOUND_REF only in the first step", () => {
      const refs = [...workflowText.matchAll(/\bvars\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      expect(new Set(refs)).toEqual(
        new Set(["CICD_BOUND_REF", "CICD_AWS_REGION", "CICD_ECR_REPOSITORY", "CICD_DEPLOY_QUEUE_NAME"]),
      );
      envSteps.forEach((st, i) => {
        expect(JSON.stringify(st).includes("vars.CICD_BOUND_REF"), `step ${i}`).toBe(i === 0);
      });
    });

    it("never takes the bound ref from an input", () => {
      const first = envSteps[0]!;
      expect(JSON.stringify(first)).not.toContain("inputs.");
    });
  });

  describe("one secret, four variables, derived identifiers (gate-b-plan section 12)", () => {
    const idx = (pred: (st: Step) => boolean) => envSteps.findIndex(pred);
    const oidcIdx = idx((st) => !!st.uses?.startsWith("aws-actions/configure-aws-credentials@"));
    const loginIdx = idx((st) => !!st.uses?.startsWith("aws-actions/amazon-ecr-login@"));
    const buildIdx = idx((st) => !!st.run?.includes("docker push"));
    const sendIdx = idx((st) => !!st.run?.includes("aws sqs send-message"));

    it("reads exactly ONE secret, CICD_ROLE_ARN, anywhere", () => {
      const secrets = [...workflowText.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      expect(secrets.length).toBeGreaterThan(0);
      expect(new Set(secrets)).toEqual(new Set(["CICD_ROLE_ARN"]));
    });

    it("takes region and repository name from vars and the registry from the login step output", () => {
      expect(envSteps[oidcIdx]!.with?.["aws-region"]).toBe("${{ vars.CICD_AWS_REGION }}");
      expect(envSteps[loginIdx]!.id).toBeTruthy();
      const build = envSteps[buildIdx]!;
      expect(build.env?.["REGISTRY"]).toBe(`${"${{"} steps.${envSteps[loginIdx]!.id}.outputs.registry }}`);
      expect(build.env?.["REPOSITORY"]).toBe("${{ vars.CICD_ECR_REPOSITORY }}");
    });

    it("masks the role ARN account segment before the first step that uses the secret elsewhere", () => {
      const maskIdx = idx((st) => !!st.run?.includes("::add-mask::") && JSON.stringify(st).includes("secrets.CICD_ROLE_ARN"));
      expect(maskIdx).toBe(1);
      const firstOtherSecretUse = idx((st) => st !== envSteps[maskIdx] && JSON.stringify(st).includes("secrets."));
      expect(firstOtherSecretUse).toBeGreaterThan(maskIdx);
    });

    it("masks the account ID from get-caller-identity after OIDC and before login, build and send", () => {
      const m = idx((st) => !!st.run?.includes("sts get-caller-identity"));
      expect(m).toBeGreaterThan(oidcIdx);
      expect(envSteps[m]!.run).toMatch(/::add-mask::\$account_id/);
      expect(m).toBeLessThan(loginIdx);
      expect(m).toBeLessThan(buildIdx);
      expect(m).toBeLessThan(sendIdx);
    });

    it("sets mask-aws-account-id on the OIDC step", () => {
      expect(envSteps[oidcIdx]!.with?.["mask-aws-account-id"]).toBe(true);
    });

    it("derives the queue URL from the queue-name variable, fails closed and masks it before send-message", () => {
      const send = envSteps[sendIdx]!;
      expect(send.env?.["QUEUE_NAME"]).toBe("${{ vars.CICD_DEPLOY_QUEUE_NAME }}");
      const run = send.run!;
      const get = run.indexOf("aws sqs get-queue-url");
      const empty = run.indexOf('-z "$queue_url"');
      const mask = run.indexOf('::add-mask::$queue_url');
      const sendAt = run.indexOf("aws sqs send-message");
      expect(get).toBeGreaterThan(-1);
      expect(get).toBeLessThan(empty);
      expect(empty).toBeLessThan(mask);
      expect(mask).toBeLessThan(sendAt);
      expect(run).toContain('--queue-url "$queue_url"');
    });

    it("uses no static AWS credentials (OIDC only)", () => {
      expect(workflowText).not.toMatch(/aws-access-key-id|aws-secret-access-key|aws-session-token/i);
      expect(workflowText).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
    });

    it("carries no ARN, account ID, host, URL or IP literal", () => {
      const withoutComments = workflowText.replace(/^\s*#.*$/gm, "");
      expect(withoutComments).not.toMatch(/arn:aws/);
      expect(withoutComments).not.toMatch(/\b\d{12}\b/);
      expect(withoutComments).not.toMatch(/\.amazonaws\.com/);
      expect(withoutComments).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(withoutComments).not.toMatch(/https?:\/\//);
    });
  });

  describe("step ordering (FR-22: one request after every CI step)", () => {
    it("runs bound-ref, mask, checkout, OIDC, account mask, registry login, build+push, body, send in that order", () => {
      const kinds = envSteps.map((s) => {
        if (s.uses?.startsWith("actions/checkout@")) return "checkout";
        if (s.uses?.startsWith("aws-actions/configure-aws-credentials@")) return "oidc";
        if (s.uses?.startsWith("aws-actions/amazon-ecr-login@")) return "ecr-login";
        if (s.run?.includes("BOUND_REF")) return "bound-ref";
        if (s.run?.includes("aws sqs send-message")) return "send";
        if (s.run?.includes("sts get-caller-identity")) return "account-mask";
        if (s.run?.includes("::add-mask::")) return "mask";
        if (s.run?.includes("docker push")) return "build-push";
        if (s.run?.includes("jq -n")) return "body";
        return "unknown";
      });
      expect(kinds).toEqual(["bound-ref", "mask", "checkout", "oidc", "account-mask", "ecr-login", "build-push", "body", "send"]);
    });

    it("has exactly one send step, it is the LAST step and nothing in the workflow uses always()", () => {
      const sends = envSteps.filter((s) => s.run?.includes("aws sqs send-message"));
      expect(sends).toHaveLength(1);
      expect(envSteps.at(-1)).toBe(sends[0]);
      expect(workflowText).not.toMatch(/always\(\)/);
      for (const s of envSteps) expect(s.if).toBeUndefined();
      expect(workflowText.match(/send-message/g)).toHaveLength(1);
    });

    it("sets no continue-on-error anywhere", () => {
      expect(workflowText).not.toMatch(/continue-on-error/);
    });
  });

  describe("action pinning (DD-29, guard 7 classifier)", () => {
    const uses = [...strings(wf)].filter(([p]) => p.endsWith(".uses"));

    it("references only remote actions, each classified as immutable by guard 7", () => {
      expect(uses.length).toBe(3);
      for (const [p, v] of uses) {
        expect(classifyUses(v), p).toBeUndefined();
        expect(v.startsWith("./"), `${p} must not be local`).toBe(false);
        expect(v, p).toMatch(/@[0-9a-f]{40}$/);
      }
    });

    it("records the version as a trailing comment on every uses line", () => {
      const lines = workflowText.split("\n").filter((l) => /^\s*(- )?uses:/.test(l));
      expect(lines).toHaveLength(3);
      for (const l of lines) expect(l).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    });
  });

  describe("no deploy logic, host or SSH (NFR-01)", () => {
    it("contains no ssh, scp, host, script or deploy-target wording in executable content", () => {
      const withoutComments = workflowText.replace(/^\s*#.*$/gm, "");
      expect(withoutComments).not.toMatch(/\bssh\b|\bscp\b|\brsync\b|SSH_|\bhost\b|known_hosts|docker (run|compose|exec)|kubectl/i);
    });

    it("interpolates no ${{ }} expression into a run script (only through env)", () => {
      for (const job of Object.values(wf.jobs)) {
        for (const s of job.steps ?? []) if (s.run) expect(s.run).not.toContain("${{");
      }
    });
  });

  describe("deploy request body (design 6.1)", () => {
    const bodyStep = envSteps.find((s) => s.run?.includes("jq -n"))!;
    let validate: ValidateFunction;
    beforeAll(() => {
      validate = createAjv().compile(readJsonSchema(deployRequestSchemaPath));
    });

    it("derives requestId from run_id and run_attempt and ci.* from the run context", () => {
      expect(bodyStep.env).toMatchObject({
        RUN_ID: "${{ github.run_id }}",
        RUN_ATTEMPT: "${{ github.run_attempt }}",
        RUN_NUMBER: "${{ github.run_number }}",
        COMMIT_SHA: "${{ github.sha }}",
      });
      expect(bodyStep.run).toContain('--arg requestId "${RUN_ID}-${RUN_ATTEMPT}"');
      expect(bodyStep.run).toContain("runNumber: $runNumber");
    });

    it("emits only schema fields: no host, script, ssh, registry or repository keys", () => {
      for (const forbidden of ["host", "script", "ssh", "registry", "imageRepository", "image:"]) {
        expect(bodyStep.run!.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });

    it.skipIf(!canExecute)("builds a body (by running the real step script) that validates against the schema", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "reusable-wf-"));
      try {
        const artifacts = posix(path.join(dir, "artifacts.json"));
        const body = posix(path.join(dir, "body.json"));
        writeFileSync(artifacts, JSON.stringify({ server: `sha256:${"a".repeat(64)}`, client: `sha256:${"b".repeat(64)}` }));
        const env: Record<string, string> = {
          DEPLOYMENT_ID: "example-deployment",
          COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
          REPOSITORY_SLUG: "example-org/example-repo",
          WORKFLOW_REF: "example-org/example-repo/.github/workflows/caller.yml@refs/heads/example",
          RUN_ID: "9876543210",
          RUN_ATTEMPT: "2",
          RUN_NUMBER: "42",
          RUNNER_TEMP: posix(dir),
          ARTIFACTS_FILE: artifacts,
          BODY_FILE: body,
        };
        const r = runScript(bodyStep.run!, env);
        expect(r.status, r.stderr).toBe(0);
        const json = JSON.parse(readFileSync(body, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
        expect(json["requestId"]).toBe("9876543210-2");
        expect(json["ci"].runId).toBe("9876543210");
        expect(json["ci"].runAttempt).toBe(2);
        expect(json["ci"].runNumber).toBe(42);
        expect(Object.keys(json["artifacts"]).sort()).toEqual(["client", "server"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("guard script behavior (executed)", () => {
    const guardScript = guardJob.steps![0]!.run!;
    const okUnits = JSON.stringify([{ unit: "server", context: "server" }, { unit: "client", context: ".", dockerfile: "client/Dockerfile" }]);
    const run = (over: Record<string, string>) =>
      runScript(guardScript, { EVENT_NAME: "push", DEPLOYMENT_ID: "example-deployment", UNITS: okUnits, ...over });

    it.skipIf(!canExecute)("accepts push and workflow_dispatch with valid inputs", () => {
      expect(run({}).status).toBe(0);
      expect(run({ EVENT_NAME: "workflow_dispatch" }).status).toBe(0);
    });

    it.skipIf(!canExecute)("rejects pull_request, pull_request_target and workflow_run", () => {
      for (const e of ["pull_request", "pull_request_target", "workflow_run", "schedule"]) {
        expect(run({ EVENT_NAME: e }).status, e).toBe(1);
      }
    });

    it.skipIf(!canExecute)("rejects malformed deploymentId and unsafe or malformed units", () => {
      expect(run({ DEPLOYMENT_ID: "Bad_Id" }).status).toBe(1);
      const bad = [
        "not json",
        "[]",
        JSON.stringify([{ unit: "server", context: "../outside" }]),
        JSON.stringify([{ unit: "server", context: "/abs" }]),
        JSON.stringify([{ unit: "Server", context: "." }]),
        JSON.stringify([{ unit: "server", context: ".", host: "x" }]),
        JSON.stringify([{ unit: "a", context: "." }, { unit: "a", context: "." }]),
        JSON.stringify([{ unit: "a", context: ".", dockerfile: "../Dockerfile" }]),
        JSON.stringify([{ unit: "a", context: "--network=host" }]),
        JSON.stringify([{ unit: "a", context: "-x" }]),
        JSON.stringify([{ unit: "a", context: ".", dockerfile: "-f" }]),
      ];
      for (const u of bad) expect(run({ UNITS: u }).status, u).toBe(1);
    });
  });

  describe("digest source", () => {
    it("reads the digest from RepoDigests of the pushed repository, not from push output", () => {
      const step = envSteps.find((s) => s.run?.includes("docker push"))!;
      expect(step.run).toContain("docker inspect");
      expect(step.run).toContain("RepoDigests");
      expect(step.run).not.toMatch(/\|\s*tee\b|push-.*\.log/);
      expect(step.run).toContain("^sha256:[0-9a-f]{64}$");
    });
  });

  describe("workflow linter", () => {
    it.skipIf(!toolWorks("actionlint", ["-version"]))("passes actionlint", () => {
      const r = spawnSync("actionlint", [workflowPath], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});

describe.each([
  ["docs/examples/caller-workflow.yml", ["docs", "examples", "caller-workflow.yml"]],
  ["docs/gate-b/github/caller-workflow.example.yml", ["docs", "gate-b", "github", "caller-workflow.example.yml"]],
])("%s (FR-22, DD-29)", (_label, segments) => {
  const callerText = readFileSync(path.join(repoRoot, ...segments), "utf8");
  const caller = parse(callerText) as {
    on: Record<string, { branches?: string[] } | null>;
    permissions?: Record<string, string>;
    jobs: Record<string, Job & { with?: Record<string, string>; secrets?: unknown }>;
  };
  const deploy = caller.jobs["deploy"]!;

  it("triggers on exactly push (bound-branch placeholder) and workflow_dispatch", () => {
    expect(Object.keys(caller.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(caller.on["push"]?.branches).toEqual(["<BOUND_BRANCH>"]);
  });

  it("declares top-level permissions: {}", () => {
    expect(caller.permissions).toEqual({});
  });

  it("makes deploy depend on ci so a CI failure sends no request", () => {
    const needs = [deploy.needs].flat();
    expect(needs).toContain("ci");
  });

  it("calls the reusable workflow at an immutable SHA (placeholder or 40-hex), never a tag or branch", () => {
    expect(deploy.uses).toMatch(/\/\.github\/workflows\/deploy-request\.reusable\.yml@(<PINNED_COMMIT_SHA>|[0-9a-f]{40})$/);
  });

  it("does not inherit or pass secrets", () => {
    expect(deploy.secrets).toBeUndefined();
    expect(callerText.replace(/^\s*#.*$/gm, "")).not.toMatch(/secrets:\s*inherit/);
  });

  it("passes exactly deploymentId, environment and units", () => {
    expect(Object.keys(deploy.with ?? {}).sort()).toEqual(["deploymentId", "environment", "units"]);
  });

  it("grants the deploy job only id-token: write and contents: read", () => {
    expect(deploy.permissions).toEqual({ "id-token": "write", contents: "read" });
  });

  it("uses no forbidden trigger, no secrets.* expression and no static AWS credentials", () => {
    for (const forbidden of ["pull_request", "pull_request_target", "workflow_run"]) {
      expect(Object.keys(caller.on)).not.toContain(forbidden);
    }
    expect(callerText).not.toMatch(/\bsecrets\./);
    expect(callerText).not.toMatch(/aws-access-key-id|aws-secret-access-key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/i);
  });

  it("carries no ARN, account ID, URL or host literal", () => {
    const body = callerText.replace(/^\s*#.*$/gm, "");
    expect(body).not.toMatch(/arn:aws|\b\d{12}\b|\.amazonaws\.com|https?:\/\//);
  });
});

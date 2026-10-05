// @akili-spec changes/cicd-executor-poc design §6.1, §6.6; requirements FR-20
// Proves the PIPELINE_REQUESTED envelope this package produces validates
// against the repo-root schemas/event.schema.json (single source of truth —
// never duplicated/relaxed here).
import type { ValidateFunction } from "ajv";
import { beforeAll, describe, expect, it } from "vitest";
import { handleGithubWebhook, type HandleWebhookDeps } from "../src/core/handle-webhook.js";
import type { GithubPushPipelineDefinition } from "../src/core/ports.js";
import { createAjv, readJsonSchema } from "./support/ajv-factory.js";
import { eventSchemaPath } from "./support/schema-paths.js";
import { FakeDefinitionReader, FakeLogger, FakeQueuePublisher, FakeSecretReader, FIXED_SECRET } from "./support/fakes.js";
import { createHmac } from "node:crypto";

const REPO_URL = "<FIXTURE_GITHUB_REPO_URL>";
const BRANCH = "main";
const DELIVERY_ID = "22222222-2222-4222-8222-222222222222";

function sign(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

describe("PIPELINE_REQUESTED envelope validates against schemas/event.schema.json", () => {
  let validate: ValidateFunction;

  beforeAll(() => {
    const ajv = createAjv();
    validate = ajv.compile(readJsonSchema(eventSchemaPath));
  });

  it("produces a schema-valid envelope for a matching push", async () => {
    const definition: GithubPushPipelineDefinition = {
      pipelineId: "prms-reporting-dev",
      repositoryUrl: REPO_URL,
      branch: BRANCH,
      environment: "dev",
    };
    const queuePublisher = new FakeQueuePublisher();
    const deps: HandleWebhookDeps = {
      secretReader: new FakeSecretReader(FIXED_SECRET),
      definitionReader: new FakeDefinitionReader([definition]),
      queuePublisher,
      logger: new FakeLogger(),
      clock: () => new Date("2026-10-05T12:00:00.000Z"),
      newEventId: () => "8f14e45f-ceea-4d1a-9e65-fa93b3b0b7f9",
    };

    const payload = {
      ref: `refs/heads/${BRANCH}`,
      after: "deadbeef0000111122223333444455556666777",
      deleted: false,
      repository: { html_url: REPO_URL },
      pusher: { name: "octocat-pusher" },
    };
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");

    const result = await handleGithubWebhook(
      {
        rawBody,
        headers: {
          "x-github-event": "push",
          "x-github-delivery": DELIVERY_ID,
          "x-hub-signature-256": sign(rawBody, FIXED_SECRET),
        },
      },
      deps,
    );

    expect(result.statusCode).toBe(202);
    expect(queuePublisher.published).toHaveLength(1);

    const envelope = queuePublisher.published[0]!;
    expect(validate(envelope), JSON.stringify(validate.errors)).toBe(true);
  });
});

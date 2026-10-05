// Translated scenario titles reference design §6.6 and requirements FR-20
// (both scenarios) / FR-03 (requestId dedupe identity, DD-20).
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { handleGithubWebhook, type HandleWebhookDeps, type WebhookRequest } from "../src/core/handle-webhook.js";
import type { GithubPushPipelineDefinition } from "../src/core/ports.js";
import { FakeDefinitionReader, FakeLogger, FakeQueuePublisher, FakeSecretReader, FIXED_SECRET } from "./support/fakes.js";

const REPO_URL = "<FIXTURE_GITHUB_REPO_URL>";
const BRANCH = "main";
const DELIVERY_ID = "11111111-1111-4111-8111-111111111111";
const FIXED_TIMESTAMP = "2026-10-05T12:00:00.000Z";

function sign(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function request(
  payload: Record<string, unknown>,
  options: { githubEvent?: string; deliveryId?: string; signatureSecret?: string; signature?: string } = {},
): WebhookRequest {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const headers: Record<string, string | undefined> = {
    "content-type": "application/json",
  };
  if (options.githubEvent !== undefined) headers["x-github-event"] = options.githubEvent;
  if (options.deliveryId !== undefined) headers["x-github-delivery"] = options.deliveryId;
  const signature = options.signature ?? sign(rawBody, options.signatureSecret ?? FIXED_SECRET);
  headers["x-hub-signature-256"] = signature;
  return { rawBody, headers };
}

const pushPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: `refs/heads/${BRANCH}`,
  after: "deadbeef0000111122223333444455556666777",
  deleted: false,
  repository: { html_url: REPO_URL, clone_url: `${REPO_URL}.git` },
  pusher: { name: "octocat-pusher" },
  ...overrides,
});

const matchingDefinition: GithubPushPipelineDefinition = {
  pipelineId: "prms-reporting-dev",
  repositoryUrl: REPO_URL,
  branch: BRANCH,
  environment: "dev",
};

describe("handleGithubWebhook (design §6.6, FR-20)", () => {
  let definitionReader: FakeDefinitionReader;
  let queuePublisher: FakeQueuePublisher;
  let logger: FakeLogger;
  let deps: HandleWebhookDeps;
  let eventIdCounter: number;

  beforeEach(() => {
    definitionReader = new FakeDefinitionReader([matchingDefinition]);
    queuePublisher = new FakeQueuePublisher();
    logger = new FakeLogger();
    eventIdCounter = 0;
    deps = {
      secretReader: new FakeSecretReader(FIXED_SECRET),
      definitionReader,
      queuePublisher,
      logger,
      clock: () => new Date(FIXED_TIMESTAMP),
      newEventId: () => `event-id-${++eventIdCounter}`,
    };
  });

  describe("signature verification (disqualifier: must prove rejection, not just acceptance)", () => {
    it("rejects a missing signature with 401 and enqueues nothing", async () => {
      const req = request(pushPayload(), { githubEvent: "push", deliveryId: DELIVERY_ID });
      delete (req.headers as Record<string, string | undefined>)["x-hub-signature-256"];

      const result = await handleGithubWebhook(req, deps);

      expect(result.statusCode).toBe(401);
      expect(queuePublisher.published).toHaveLength(0);
    });

    it("rejects an invalid signature with 401 and enqueues nothing", async () => {
      const req = request(pushPayload(), {
        githubEvent: "push",
        deliveryId: DELIVERY_ID,
        signature: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      });

      const result = await handleGithubWebhook(req, deps);

      expect(result.statusCode).toBe(401);
      expect(result.reason).toBe("INVALID_SIGNATURE");
      expect(queuePublisher.published).toHaveLength(0);
    });

    it("rejects a signature signed with the wrong secret with 401 and enqueues nothing", async () => {
      const req = request(pushPayload(), {
        githubEvent: "push",
        deliveryId: DELIVERY_ID,
        signatureSecret: "a-completely-different-secret",
      });

      const result = await handleGithubWebhook(req, deps);

      expect(result.statusCode).toBe(401);
      expect(queuePublisher.published).toHaveLength(0);
    });
  });

  it("accepts a valid ping with 200 and no effect", async () => {
    const req = request({ zen: "Responsive is better than fast.", hook_id: 1 }, { githubEvent: "ping" });

    const result = await handleGithubWebhook(req, deps);

    expect(result.statusCode).toBe(200);
    expect(result.reason).toBe("PING");
    expect(queuePublisher.published).toHaveLength(0);
  });

  it("acknowledges a non-push event with 202 ignored+logged, enqueuing nothing", async () => {
    const req = request({ action: "opened" }, { githubEvent: "issues", deliveryId: DELIVERY_ID });

    const result = await handleGithubWebhook(req, deps);

    expect(result.statusCode).toBe(202);
    expect(result.reason).toBe("EVENT_IGNORED");
    expect(queuePublisher.published).toHaveLength(0);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      event: "EVENT_IGNORED",
      deliveryId: DELIVERY_ID,
      githubEvent: "issues",
    });
  });

  it("acknowledges a push to an unconfigured branch with 202 WEBHOOK_UNMATCHED, enqueuing nothing", async () => {
    const req = request(pushPayload({ ref: "refs/heads/some-other-branch" }), {
      githubEvent: "push",
      deliveryId: DELIVERY_ID,
    });

    const result = await handleGithubWebhook(req, deps);

    expect(result.statusCode).toBe(202);
    expect(result.reason).toBe("WEBHOOK_UNMATCHED");
    expect(queuePublisher.published).toHaveLength(0);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      event: "WEBHOOK_UNMATCHED",
      deliveryId: DELIVERY_ID,
      branch: "some-other-branch",
    });
    expect(logger.entries[0]!.repositoryCandidates).toEqual(
      expect.arrayContaining([REPO_URL]),
    );
  });

  it("acknowledges a push to a repo with no matching definition with 202 WEBHOOK_UNMATCHED, enqueuing nothing", async () => {
    const req = request(pushPayload({ repository: { html_url: "<ANOTHER_REPO_URL>" } }), {
      githubEvent: "push",
      deliveryId: DELIVERY_ID,
    });

    const result = await handleGithubWebhook(req, deps);

    expect(result.statusCode).toBe(202);
    expect(result.reason).toBe("WEBHOOK_UNMATCHED");
    expect(queuePublisher.published).toHaveLength(0);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      event: "WEBHOOK_UNMATCHED",
      deliveryId: DELIVERY_ID,
      branch: BRANCH,
      repositoryCandidates: ["<ANOTHER_REPO_URL>"],
    });
  });

  it("logs a MALFORMED_PAYLOAD entry without payload contents", async () => {
    const rawBody = Buffer.from("{not-json", "utf8");
    const headers: Record<string, string | undefined> = {
      "x-github-event": "push",
      "x-github-delivery": DELIVERY_ID,
      "x-hub-signature-256": sign(rawBody, FIXED_SECRET),
    };

    const result = await handleGithubWebhook({ rawBody, headers }, deps);

    expect(result.statusCode).toBe(202);
    expect(result.reason).toBe("MALFORMED_PAYLOAD");
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ event: "MALFORMED_PAYLOAD", deliveryId: DELIVERY_ID });
    expect(JSON.stringify(logger.entries[0])).not.toContain("not-json");
  });

  it("logs a MISSING_DELIVERY_ID entry without payload contents", async () => {
    const req = request(pushPayload(), { githubEvent: "push" });

    const result = await handleGithubWebhook(req, deps);

    expect(result.statusCode).toBe(202);
    expect(result.reason).toBe("MISSING_DELIVERY_ID");
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ event: "MISSING_DELIVERY_ID", githubEvent: "push" });
    expect(JSON.stringify(logger.entries[0])).not.toContain("octocat-pusher");
  });

  it("never logs the signing secret, the signature header, or the raw body (NFR-02)", async () => {
    const malformedRawBody = Buffer.from("{not-json", "utf8");
    const scenarios: WebhookRequest[] = [
      request({ action: "opened" }, { githubEvent: "issues", deliveryId: DELIVERY_ID }),
      request(pushPayload({ ref: "refs/heads/some-other-branch" }), { githubEvent: "push", deliveryId: DELIVERY_ID }),
      {
        rawBody: malformedRawBody,
        headers: {
          "x-github-event": "push",
          "x-github-delivery": DELIVERY_ID,
          "x-hub-signature-256": sign(malformedRawBody, FIXED_SECRET),
        },
      },
      request(pushPayload(), { githubEvent: "push" }),
    ];

    for (const req of scenarios) {
      await handleGithubWebhook(req, deps);
    }

    // The exact signature header and raw body bytes used by EACH scenario
    // above — not one fixed hardcoded string — so this test actually
    // discriminates: injecting any scenario's own signature/body into any
    // logged entry must fail it (falsifier: add `signatureHeader` to a log
    // call and this red; this is NOT satisfied by comparing against an
    // unrelated fixed value).
    const actualSignatureHeaders = scenarios
      .map((r) => r.headers["x-hub-signature-256"])
      .filter((s): s is string => typeof s === "string");
    const actualRawBodies = scenarios.map((r) => r.rawBody.toString("utf8"));

    const serializedEntries = logger.entries.map((e) => JSON.stringify(e));
    expect(serializedEntries.length).toBeGreaterThan(0);
    for (const serialized of serializedEntries) {
      expect(serialized).not.toContain(FIXED_SECRET);
      for (const sigHeader of actualSignatureHeaders) {
        expect(serialized).not.toContain(sigHeader);
      }
      for (const rawBody of actualRawBodies) {
        expect(serialized).not.toContain(rawBody);
      }
    }
  });

  it("ignores a branch-deleting push (deleted: true) with 202, enqueuing nothing", async () => {
    const req = request(pushPayload({ deleted: true }), { githubEvent: "push", deliveryId: DELIVERY_ID });

    const result = await handleGithubWebhook(req, deps);

    expect(result.statusCode).toBe(202);
    expect(result.reason).toBe("BRANCH_DELETED");
    expect(queuePublisher.published).toHaveLength(0);
  });

  it("enqueues one PIPELINE_REQUESTED with the right requestId/commit/triggeredBy for a matching push", async () => {
    const req = request(pushPayload(), { githubEvent: "push", deliveryId: DELIVERY_ID });

    const result = await handleGithubWebhook(req, deps);

    expect(result.statusCode).toBe(202);
    expect(result.reason).toBe("ENQUEUED");
    expect(queuePublisher.published).toHaveLength(1);

    const envelope = queuePublisher.published[0]!;
    expect(envelope.eventType).toBe("PIPELINE_REQUESTED");
    expect(envelope.pipelineId).toBe(matchingDefinition.pipelineId);
    expect(envelope.environment).toBe("dev");
    expect(envelope.source).toBe("ingress");
    expect(envelope.requestId).toBe(`${DELIVERY_ID}:${matchingDefinition.pipelineId}`);
    expect(envelope.payload.after).toBe("deadbeef0000111122223333444455556666777");
    expect(envelope.payload.triggeredBy).toBe("octocat-pusher");
  });

  it("takes `environment` from the matched definition rather than hardcoding it", async () => {
    // PoC schema closes `environment` to "dev" (schemas/pipeline.schema.json), so a
    // real fixture can't produce a value that discriminates "read from the
    // definition" from "hardcoded dev". This bypasses the compile-time literal
    // (unenforced at runtime) to prove the implementation reads
    // `definition.environment`: a hardcoded "dev" would fail this, a read
    // passes it through verbatim.
    const customDefinition = {
      ...matchingDefinition,
      environment: "not-dev-proves-its-read-from-the-definition",
    } as unknown as GithubPushPipelineDefinition;
    definitionReader = new FakeDefinitionReader([customDefinition]);
    deps = { ...deps, definitionReader };
    const req = request(pushPayload(), { githubEvent: "push", deliveryId: DELIVERY_ID });

    await handleGithubWebhook(req, deps);

    expect(queuePublisher.published[0]!.environment as string).toBe(
      "not-dev-proves-its-read-from-the-definition",
    );
  });

  it("omits `after` from the envelope payload (does not send \"\") when the push carries no `after` commit", async () => {
    const payload = pushPayload();
    delete payload.after;
    const req = request(payload, { githubEvent: "push", deliveryId: DELIVERY_ID });

    const result = await handleGithubWebhook(req, deps);

    expect(result.statusCode).toBe(202);
    const envelope = queuePublisher.published[0]!;
    expect("after" in envelope.payload).toBe(false);
  });

  it("enqueues one PIPELINE_REQUESTED per matching definition when several pipelines share repo+branch", async () => {
    const secondDefinition: GithubPushPipelineDefinition = {
      pipelineId: "prms-reporting-dev-mirror",
      repositoryUrl: REPO_URL,
      branch: BRANCH,
      environment: "dev",
    };
    definitionReader = new FakeDefinitionReader([matchingDefinition, secondDefinition]);
    deps = { ...deps, definitionReader };

    const req = request(pushPayload(), { githubEvent: "push", deliveryId: DELIVERY_ID });

    const result = await handleGithubWebhook(req, deps);

    expect(result.statusCode).toBe(202);
    expect(queuePublisher.published).toHaveLength(2);
    const pipelineIds = queuePublisher.published.map((e) => e.pipelineId).sort();
    expect(pipelineIds).toEqual([matchingDefinition.pipelineId, secondDefinition.pipelineId].sort());

    const requestIds = queuePublisher.published.map((e) => e.requestId).sort();
    expect(requestIds).toEqual(
      [
        `${DELIVERY_ID}:${matchingDefinition.pipelineId}`,
        `${DELIVERY_ID}:${secondDefinition.pipelineId}`,
      ].sort(),
    );
  });

  it("produces the same requestId on a GitHub retry (same delivery id resent)", async () => {
    const req1 = request(pushPayload(), { githubEvent: "push", deliveryId: DELIVERY_ID });
    const req2 = request(pushPayload(), { githubEvent: "push", deliveryId: DELIVERY_ID });

    await handleGithubWebhook(req1, deps);
    await handleGithubWebhook(req2, deps);

    expect(queuePublisher.published).toHaveLength(2);
    expect(queuePublisher.published[0]!.requestId).toBe(queuePublisher.published[1]!.requestId);
    expect(queuePublisher.published[0]!.requestId).toBe(`${DELIVERY_ID}:${matchingDefinition.pipelineId}`);
  });

  it("responds 202 only AFTER enqueueing (publish resolves before the handler returns)", async () => {
    let publishResolved = false;
    const orderedPublisher: FakeQueuePublisher = Object.assign(new FakeQueuePublisher(), {
      publish: async (envelope: Parameters<FakeQueuePublisher["publish"]>[0]) => {
        await Promise.resolve();
        publishResolved = true;
        queuePublisher.published.push(envelope);
      },
    });
    deps = { ...deps, queuePublisher: orderedPublisher };

    const req = request(pushPayload(), { githubEvent: "push", deliveryId: DELIVERY_ID });
    const result = await handleGithubWebhook(req, deps);

    expect(publishResolved).toBe(true);
    expect(result.statusCode).toBe(202);
  });
});

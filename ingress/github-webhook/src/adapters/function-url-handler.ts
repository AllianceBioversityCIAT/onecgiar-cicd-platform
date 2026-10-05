// @akili-spec changes/cicd-executor-poc design §6.6
// Lambda handler shape for a Function URL (API Gateway v2 payload format).
// Pure glue: decode the native event into the core's WebhookRequest, call
// the pure core, re-encode its WebhookResult as the native response. All
// AWS SDK calls live in the injected deps (sqs-queue-publisher.ts,
// env-secret-reader.ts, yaml-pipeline-definition-reader.ts), never here.
import { randomUUID } from "node:crypto";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handleGithubWebhook, type HandleWebhookDeps, type WebhookRequest } from "../core/handle-webhook.js";
import { EnvSecretReader } from "./env-secret-reader.js";
import { SqsQueuePublisher } from "./sqs-queue-publisher.js";
import { StdoutJsonLogger } from "./stdout-json-logger.js";
import { YamlPipelineDefinitionReader } from "./yaml-pipeline-definition-reader.js";

function toWebhookRequest(event: APIGatewayProxyEventV2): WebhookRequest {
  const rawBody = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
  return { rawBody, headers: event.headers };
}

function toApiResponse(result: Awaited<ReturnType<typeof handleGithubWebhook>>): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: result.statusCode,
    headers: { "content-type": "application/json" },
    body: result.body,
  };
}

/** Lazily built once per execution environment (Lambda cold-start reuse); overridable for tests. */
let cachedDeps: HandleWebhookDeps | undefined;

function defaultDeps(): HandleWebhookDeps {
  if (cachedDeps) return cachedDeps;

  const queueUrl = process.env.PIPELINE_REQUEST_QUEUE_URL;
  if (!queueUrl) {
    throw new Error(
      "refusing to start: environment variable PIPELINE_REQUEST_QUEUE_URL is not set (Gate B deployment concern).",
    );
  }

  cachedDeps = {
    secretReader: new EnvSecretReader(),
    definitionReader: new YamlPipelineDefinitionReader(),
    queuePublisher: new SqsQueuePublisher({ client: new SQSClient({}), queueUrl }),
    logger: new StdoutJsonLogger(),
    clock: () => new Date(),
    newEventId: () => randomUUID(),
  };
  return cachedDeps;
}

export async function handler(
  event: APIGatewayProxyEventV2,
  deps: HandleWebhookDeps = defaultDeps(),
): Promise<APIGatewayProxyStructuredResultV2> {
  const result = await handleGithubWebhook(toWebhookRequest(event), deps);
  return toApiResponse(result);
}

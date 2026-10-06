// @akili-spec changes/cicd-executor-poc design §7 (sqs-consumer row), DD-02, DD-14; requirements FR-04 (RL-3), NFR-03
// Emulator tests: the SQS consumer against a real queue implementation (ElasticMQ, no Docker).
// Run with `npm run test:sqs-emulator`, which starts the emulator and sets SQS_LOCAL_ENDPOINT.
// Without SQS_LOCAL_ENDPOINT the whole suite is reported as SKIPPED by vitest (never as passed).
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createSqsQueuePublisher } from "../../src/adapters/sqs-publisher/index.js";
import { createSqsConsumer, type InboundMessage } from "../../src/inbound/sqs-consumer/index.js";
import { createLogger, createMetrics } from "../../src/observability/index.js";

const endpoint = process.env["SQS_LOCAL_ENDPOINT"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for: ${what}`);
}

describe.skipIf(endpoint === undefined)("SQS consumer against the ElasticMQ emulator", () => {
  let client: SQSClient;
  const createdQueues: string[] = [];
  const consumers: { stop(): Promise<void> }[] = [];

  beforeAll(() => {
    client = new SQSClient({ endpoint: endpoint as string, region: "us-east-1" });
  });

  afterEach(async () => {
    for (const consumer of consumers.splice(0)) {
      await consumer.stop();
    }
  });

  afterAll(async () => {
    for (const url of createdQueues) {
      await client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
    }
    client.destroy();
  });

  async function createQueue(name: string, attributes: Record<string, string> = {}): Promise<string> {
    const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
    if (QueueUrl === undefined) {
      throw new Error("emulator returned no queue URL");
    }
    createdQueues.push(QueueUrl);
    return QueueUrl;
  }

  async function createQueueWithDlq(name: string): Promise<{ queueUrl: string; dlqUrl: string }> {
    const dlqUrl = await createQueue(`${name}-dlq`);
    const attrs = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
    const queueUrl = await createQueue(name, {
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attrs.Attributes?.["QueueArn"], maxReceiveCount: 5 }),
    });
    return { queueUrl, dlqUrl };
  }

  function makeConsumer(
    queueUrl: string,
    handle: (message: InboundMessage) => Promise<{ ack: boolean }>,
    extra: Partial<Parameters<typeof createSqsConsumer>[0]> = {},
  ): ReturnType<typeof createSqsConsumer> {
    const clock = { now: () => new Date() };
    const consumer = createSqsConsumer({
      client,
      queueUrl,
      handle,
      logger: createLogger({ sink: { write: () => undefined }, clock }),
      metrics: createMetrics({ sink: { write: () => undefined }, clock }),
      waitTimeSeconds: 1,
      receiveErrorBackoffMs: 200,
      ...extra,
    });
    consumers.push(consumer);
    return consumer;
  }

  async function rawReceive(queueUrl: string): Promise<number> {
    const result = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1, VisibilityTimeout: 1 }));
    return result.Messages?.length ?? 0;
  }

  test("a poison message is received 5 times, never acknowledged, then lands in the DLQ without blocking others (FR-04 RL-3)", async () => {
    const { queueUrl, dlqUrl } = await createQueueWithDlq("poison");
    const publisher = createSqsQueuePublisher({ client, queueUrl });
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "not-json{" }));
    await publisher.publish({ body: { eventType: "GOOD" } });

    const poisonReceives: number[] = [];
    const goodReceives: string[] = [];
    const consumer = makeConsumer(
      queueUrl,
      (message) => {
        if (message.body === "not-json{") {
          poisonReceives.push(message.approximateReceiveCount);
          return Promise.resolve({ ack: false });
        }
        goodReceives.push(message.messageId);
        return Promise.resolve({ ack: true });
      },
      { visibilityTimeoutSeconds: 1, heartbeatIntervalSeconds: 60 },
    );
    await consumer.start();

    await waitFor(async () => (await rawReceive(dlqUrl)) > 0, 40_000, "poison message in the DLQ");
    expect(poisonReceives).toEqual([1, 2, 3, 4, 5]);
    expect(goodReceives).toHaveLength(1);
  }, 60_000);

  test("the visibility heartbeat keeps a slow handler's message invisible; without it the message is redelivered (DD-14)", async () => {
    const queueUrl = await createQueue("heartbeat");
    const publisher = createSqsQueuePublisher({ client, queueUrl });

    async function run(heartbeatIntervalSeconds: number): Promise<{ stolen: number; handled: number }> {
      await publisher.publish({ body: { eventType: "SLOW" } });
      let handled = 0;
      const consumer = makeConsumer(
        queueUrl,
        async () => {
          handled += 1;
          await sleep(4_500);
          return { ack: true };
        },
        { visibilityTimeoutSeconds: 2, heartbeatIntervalSeconds },
      );
      await consumer.start();
      await waitFor(() => handled === 1, 10_000, "handler started");
      // A competing receiver polls while the handler is slow: it must not see the message.
      let stolen = 0;
      const until = Date.now() + 4_000;
      while (Date.now() < until) {
        stolen += await rawReceive(queueUrl);
      }
      await consumer.stop();
      return { stolen, handled };
    }

    const control = await run(60);
    expect(control.stolen).toBeGreaterThan(0);
    // The control run leaves a stolen, never-deleted message behind: purge it.
    await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    await sleep(500);

    const withHeartbeat = await run(1);
    expect(withHeartbeat.stolen).toBe(0);
    expect(withHeartbeat.handled).toBe(1);
    await sleep(2_500);
    expect(await rawReceive(queueUrl)).toBe(0);
  }, 90_000);

  test("a crash or stop before the ack redelivers the message and a restart resumes it (NFR-03)", async () => {
    const queueUrl = await createQueue("restart");
    const publisher = createSqsQueuePublisher({ client, queueUrl });
    await publisher.publish({ body: { eventType: "DEPLOY_REQUESTED", requestId: "r-1" } });

    let started = false;
    const first = makeConsumer(
      queueUrl,
      () => {
        started = true;
        return new Promise<{ ack: boolean }>(() => undefined); // never finishes: the process "dies" mid-handling
      },
      { visibilityTimeoutSeconds: 2, heartbeatIntervalSeconds: 60, shutdownTimeoutMs: 200 },
    );
    await first.start();
    await waitFor(() => started, 10_000, "first consumer to start handling");
    await first.stop();

    const redelivered: InboundMessage[] = [];
    const second = makeConsumer(
      queueUrl,
      (message) => {
        redelivered.push(message);
        return Promise.resolve({ ack: true });
      },
      { visibilityTimeoutSeconds: 2, heartbeatIntervalSeconds: 60 },
    );
    await second.start();
    await waitFor(() => redelivered.length === 1, 15_000, "redelivery after restart");

    expect(JSON.parse(redelivered[0]?.body ?? "{}")).toMatchObject({ requestId: "r-1" });
    expect(redelivered[0]?.approximateReceiveCount).toBe(2);
    await second.stop();
    await sleep(2_500);
    expect(await rawReceive(queueUrl)).toBe(0);
  }, 60_000);

  test("publisher delay: a message sent with delaySeconds is not visible before the delay elapses (design 7.6)", async () => {
    const queueUrl = await createQueue("delay");
    const publisher = createSqsQueuePublisher({ client, queueUrl });
    const sentAt = Date.now();
    await publisher.publish({ body: { eventType: "LOCK_RETRY_REQUESTED" }, delaySeconds: 2 });

    expect(await rawReceive(queueUrl)).toBe(0);
    await waitFor(async () => (await rawReceive(queueUrl)) === 1, 10_000, "delayed message to appear");
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(1_900);
  }, 30_000);

  test.todo("SenderId is populated on receipt and mapped to InboundMessage.senderId (real SQS only) — DEFERRED to N-26");
});

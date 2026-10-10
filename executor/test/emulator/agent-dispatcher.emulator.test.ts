// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §8, AP-1
//
// The real SQS FIFO agent dispatcher against the ElasticMQ emulator (local only, no AWS): a re-send of the same
// dispatch (same MessageDeduplicationId = commandId) is absorbed by the queue, a new dispatch is not, and commands
// and queries of one target are delivered in order within its message group. The real SenderId and the 5-minute
// deduplication window of Amazon SQS are verified in AWS at E5; ElasticMQ only proves the adapter's use of FIFO.
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSqsAgentDispatcher } from "../../src/adapters/sqs-agent-dispatcher/index.js";
import { commandIdOf, fifo } from "../../src/domain/agent-protocol/index.js";

const endpoint = process.env["SQS_LOCAL_ENDPOINT"];

describe.skipIf(endpoint === undefined)("SQS FIFO agent dispatcher against the ElasticMQ emulator", () => {
  let client: SQSClient;
  let queueUrl: string;

  beforeAll(async () => {
    client = new SQSClient({ endpoint: endpoint as string, region: "us-east-1" });
    const created = await client.send(
      new CreateQueueCommand({ QueueName: `cicd-agent-test-${String(Date.now())}-cmd.fifo`, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }),
    );
    queueUrl = created.QueueUrl as string;
  });

  afterAll(async () => {
    await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
    client.destroy();
  });

  async function receiveAll(): Promise<Record<string, unknown>[]> {
    const bodies: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i += 1) {
      const out = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }));
      for (const m of out.Messages ?? []) bodies.push(JSON.parse(m.Body as string) as Record<string, unknown>);
      if ((out.Messages ?? []).length === 0 && bodies.length > 0) break;
    }
    return bodies;
  }

  test("a re-sent command is delivered once; a new dispatch and a query follow in the target's group order", async () => {
    const dispatcher = createSqsAgentDispatcher({ client });
    const first = commandIdOf("example-app-dev-1", "0f8b3c1e-2a4d-4b6f-8c9e-1a2b3c4d5e6f");
    const second = commandIdOf("example-app-dev-1", "1f8b3c1e-2a4d-4b6f-8c9e-1a2b3c4d5e6f");
    const send = (commandId: string, type: string, dedup: string) =>
      dispatcher.send({ queueUrl, body: { type, commandId }, groupId: fifo.commandGroup("example-app-dev"), deduplicationId: dedup });

    await send(first, "AGENT_COMMAND", fifo.commandDeduplication(first));
    await send(first, "AGENT_COMMAND", fifo.commandDeduplication(first)); // re-send of the SAME dispatch
    await send(first, "AGENT_QUERY", fifo.queryDeduplication(first, 1));
    await send(second, "AGENT_COMMAND", fifo.commandDeduplication(second)); // a NEW dispatch

    const bodies = await receiveAll();
    expect(bodies.map((b) => `${String(b["type"])}:${String(b["commandId"])}`)).toEqual([
      `AGENT_COMMAND:${first}`,
      `AGENT_QUERY:${first}`,
      `AGENT_COMMAND:${second}`,
    ]);
  });

  test("refuses a non-FIFO queue URL before calling SQS", async () => {
    const dispatcher = createSqsAgentDispatcher({ client });
    await expect(dispatcher.send({ queueUrl: queueUrl.replace(/\.fifo$/, ""), body: {}, groupId: "g", deduplicationId: "d" })).rejects.toThrow(/FIFO/);
  });
});

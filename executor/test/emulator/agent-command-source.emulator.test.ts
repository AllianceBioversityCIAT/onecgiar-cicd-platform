// @akili-spec changes/cicd-executor-poc architecture-change-04 §10.3, §10.6, §23
//
// The agent's real SQS command source against the ElasticMQ emulator (local only, no AWS): what happens to commands
// while the agent stops. A command handed back by a stopping agent (visibility 0) is received again at once and still
// before the later commands of its target; a command in flight never blocks another target; the shutdown aborts an
// in-flight 20 s long poll immediately. FIFO gives no order between different groups (targets), so none is assumed.
// Retention, the visibility timeout and the DLQ redrive of the real queues come from the E4 templates (E5 in AWS).
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSqsCommandSource } from "../../src/agent/adapters.js";
import type { ReceivedCommandMessage } from "../../src/agent/ports.js";

const endpoint = process.env["SQS_LOCAL_ENDPOINT"];

describe.skipIf(endpoint === undefined)("agent SQS command source against the ElasticMQ emulator", () => {
  let client: SQSClient;
  const queues: string[] = [];

  beforeAll(() => {
    client = new SQSClient({ endpoint: endpoint as string, region: "us-east-1" });
  });

  afterAll(async () => {
    for (const q of queues) await client.send(new DeleteQueueCommand({ QueueUrl: q })).catch(() => undefined);
    client.destroy();
  });

  async function newQueue(): Promise<string> {
    const created = await client.send(
      new CreateQueueCommand({ QueueName: `cicd-agent-src-${String(Date.now())}-${String(queues.length)}-cmd.fifo`, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }),
    );
    queues.push(created.QueueUrl as string);
    return created.QueueUrl as string;
  }

  const send = (queueUrl: string, id: string, group: string) =>
    client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ id }), MessageGroupId: group, MessageDeduplicationId: id }));
  const ids = (messages: readonly ReceivedCommandMessage[]) => messages.map((m) => (JSON.parse(m.body) as { id: string }).id);
  const only = (messages: readonly ReceivedCommandMessage[]): ReceivedCommandMessage => {
    expect(messages).toHaveLength(1);
    return messages[0] as ReceivedCommandMessage;
  };

  test("a command handed back by a stopping agent is received again at once, still before its target's later commands", async () => {
    const queueUrl = await newQueue();
    const source = createSqsCommandSource(client, queueUrl);
    await send(queueUrl, "a-1", "app-a-dev");
    await send(queueUrl, "a-2", "app-a-dev");

    const held = only(await source.receive(1));
    expect(ids([held])).toEqual(["a-1"]);
    await source.extendVisibility(held.receiptHandle, 0); // what the shutdown does with a command waiting for a slot

    const again = only(await source.receive(1));
    expect(ids([again])).toEqual(["a-1"]);
    await source.delete(again.receiptHandle);
    const next = only(await source.receive(1));
    expect(ids([next])).toEqual(["a-2"]);
    await source.delete(next.receiptHandle);
  });

  test("a command in flight never blocks another target's commands", async () => {
    const queueUrl = await newQueue();
    const source = createSqsCommandSource(client, queueUrl);
    await send(queueUrl, "a-1", "app-a-dev");
    await send(queueUrl, "b-1", "app-b-dev");

    const first = only(await source.receive(1));
    const second = only(await source.receive(1)); // the first is still in flight (not deleted)
    expect(new Set(ids([first, second]))).toEqual(new Set(["a-1", "b-1"]));
    await source.delete(first.receiptHandle);
    await source.delete(second.receiptHandle);
  });

  test("the shutdown aborts an in-flight 20 s long poll at once", async () => {
    const queueUrl = await newQueue();
    const source = createSqsCommandSource(client, queueUrl);
    const abort = new AbortController();
    const started = Date.now();
    const polling = source.receive(10, abort.signal);
    setTimeout(() => abort.abort(), 200);
    await expect(polling).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await source.receive(10, abort.signal)).toEqual([]); // an aborted signal never starts a new poll
  });
});

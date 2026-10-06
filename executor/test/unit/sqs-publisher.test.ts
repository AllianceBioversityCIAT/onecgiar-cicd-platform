// @akili-spec changes/cicd-executor-poc design §6.1, §7.6
// Unit tests for the SQS QueuePublisher: serialization, optional integer delay 0-900.
import type { SQSClient } from "@aws-sdk/client-sqs";
import { describe, expect, test } from "vitest";
import { createSqsQueuePublisher } from "../../src/adapters/sqs-publisher/index.js";

function fakeClient(): { client: SQSClient; inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  const client = {
    send: (command: { input: Record<string, unknown> }) => {
      inputs.push(command.input);
      return Promise.resolve({ MessageId: "msg-1" });
    },
  } as unknown as SQSClient;
  return { client, inputs };
}

describe("createSqsQueuePublisher", () => {
  test("sends the JSON body to the queue and returns the message id, without DelaySeconds when none is given", async () => {
    const { client, inputs } = fakeClient();
    const publisher = createSqsQueuePublisher({ client, queueUrl: "http://queue.invalid/events" });

    await expect(publisher.publish({ body: { eventType: "RECONCILE_TICK" } })).resolves.toEqual({ messageId: "msg-1" });

    expect(inputs).toEqual([{ QueueUrl: "http://queue.invalid/events", MessageBody: '{"eventType":"RECONCILE_TICK"}' }]);
  });

  test.each([0, 30, 900])("passes an integer delay of %i seconds as DelaySeconds", async (delaySeconds) => {
    const { client, inputs } = fakeClient();
    const publisher = createSqsQueuePublisher({ client, queueUrl: "http://queue.invalid/events" });

    await publisher.publish({ body: { eventType: "LOCK_RETRY_REQUESTED" }, delaySeconds });

    expect(inputs[0]?.["DelaySeconds"]).toBe(delaySeconds);
  });

  test.each([-1, 901, 1.5, Number.NaN])("rejects an invalid delay (%s) without calling SQS", async (delaySeconds) => {
    const { client, inputs } = fakeClient();
    const publisher = createSqsQueuePublisher({ client, queueUrl: "http://queue.invalid/events" });

    await expect(publisher.publish({ body: {}, delaySeconds })).rejects.toThrow(RangeError);
    expect(inputs).toEqual([]);
  });
});

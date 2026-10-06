// @akili-spec changes/cicd-executor-poc design §4.2, §6.1, §7.6 (DD-02)
// QueuePublisher implementation over SQS: puts an envelope back on the single
// event queue, optionally with a per-message delay (LOCK_RETRY_REQUESTED, §7.6).
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { QueueMessage, QueuePublisher } from "../../ports/queue-publisher.js";

/** SQS per-message delay ceiling in seconds (design §7.6, P-22). */
export const MAX_DELAY_SECONDS = 900;

export interface SqsQueuePublisherDeps {
  readonly client: SQSClient;
  readonly queueUrl: string;
}

function assertValidDelay(delaySeconds: number): void {
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS) {
    throw new RangeError(
      `delaySeconds must be an integer between 0 and ${String(MAX_DELAY_SECONDS)} (got ${String(delaySeconds)})`,
    );
  }
}

export function createSqsQueuePublisher(deps: SqsQueuePublisherDeps): QueuePublisher {
  return {
    async publish(message: QueueMessage): Promise<{ messageId: string }> {
      if (message.delaySeconds !== undefined) {
        assertValidDelay(message.delaySeconds);
      }
      const result = await deps.client.send(
        new SendMessageCommand({
          QueueUrl: deps.queueUrl,
          MessageBody: JSON.stringify(message.body),
          ...(message.delaySeconds !== undefined ? { DelaySeconds: message.delaySeconds } : {}),
        }),
      );
      if (result.MessageId === undefined) {
        throw new Error("SQS SendMessage returned no MessageId");
      }
      return { messageId: result.MessageId };
    },
  };
}

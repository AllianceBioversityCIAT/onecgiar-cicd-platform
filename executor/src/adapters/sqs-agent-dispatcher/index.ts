// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §8, AP-1
// SQS FIFO adapter of the AgentDispatcher port: one SendMessage with MessageGroupId (targetId) and
// MessageDeduplicationId (commandId). The body is serialized as is; it was built and validated by the caller.
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { AgentDispatcher, AgentQueueMessage } from "../../ports/agent-dispatcher.js";

// https is enforced by the agent-record schema for every real queue; plain http is accepted only so the local
// ElasticMQ emulator test can exercise the real adapter.
const FIFO_QUEUE_URL = /^https?:\/\/[^\s]+\.fifo$/;

export function createSqsAgentDispatcher(deps: { readonly client: SQSClient }): AgentDispatcher {
  return {
    async send(message: AgentQueueMessage): Promise<{ readonly messageId: string }> {
      if (!FIFO_QUEUE_URL.test(message.queueUrl)) throw new Error("agent command queues are FIFO queues (architecture-change-04 AP-1)");
      const result = await deps.client.send(
        new SendMessageCommand({
          QueueUrl: message.queueUrl,
          MessageBody: JSON.stringify(message.body),
          MessageGroupId: message.groupId,
          MessageDeduplicationId: message.deduplicationId,
        }),
      );
      if (result.MessageId === undefined) throw new Error("SQS SendMessage returned no MessageId");
      return { messageId: result.MessageId };
    },
  };
}

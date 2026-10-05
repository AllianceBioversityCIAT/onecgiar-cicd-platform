// @akili-spec changes/cicd-executor-poc design §6.6
// AWS adapter: publishes a PIPELINE_REQUESTED envelope onto the Executor's
// inbound SQS queue. The core never imports @aws-sdk/*; only this file does.
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { PipelineRequestedEnvelope, QueuePublisher } from "../core/ports.js";

export interface SqsQueuePublisherOptions {
  readonly client: SQSClient;
  readonly queueUrl: string;
}

export class SqsQueuePublisher implements QueuePublisher {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor(options: SqsQueuePublisherOptions) {
    this.client = options.client;
    this.queueUrl = options.queueUrl;
  }

  async publish(envelope: PipelineRequestedEnvelope): Promise<void> {
    // design §4 (queue choice, rejected alternatives): a standard queue, not
    // FIFO — "FIFO: adds no correctness". Dedup is DynamoDB-based (DD-20),
    // not SQS content-based dedup, so no MessageGroupId/MessageDeduplicationId here.
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(envelope),
      }),
    );
  }
}

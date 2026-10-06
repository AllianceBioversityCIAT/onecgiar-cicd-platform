// @akili-spec changes/cicd-executor-poc design §4.2 (tools/), DD-21
// Process entry point of the operator CLI. Publishes through the real SQS
// publisher (`adapters/sqs-publisher`); the queue comes from the environment
// (`CICD_QUEUE_URL`, `AWS_REGION`) and AWS credentials from the SDK standard
// chain (DD-16, OD-Q12 open). `--dry-run` never touches the queue: the
// publisher is only built when an event is actually sent.
import { SQSClient } from "@aws-sdk/client-sqs";
import { createSqsQueuePublisher } from "../adapters/sqs-publisher/index.js";
import type { QueuePublisher } from "../ports/queue-publisher.js";
import { runOperatorCli } from "./index.js";

let publisher: QueuePublisher | undefined;
const lazyPublisher: QueuePublisher = {
  publish(message) {
    if (publisher === undefined) {
      const queueUrl = process.env["CICD_QUEUE_URL"]?.trim();
      const region = process.env["AWS_REGION"]?.trim();
      if (!queueUrl || !region) return Promise.reject(new Error("CICD_QUEUE_URL and AWS_REGION are required to publish (use --dry-run to only print the event)"));
      publisher = createSqsQueuePublisher({ client: new SQSClient({ region }), queueUrl });
    }
    return publisher.publish(message);
  },
};

const code = await runOperatorCli(process.argv.slice(2), {
  clock: { now: () => new Date() },
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  publisher: lazyPublisher,
});
process.exitCode = code;

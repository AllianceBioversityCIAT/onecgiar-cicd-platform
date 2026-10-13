// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §11.2, §11.3, §12
// Production adapters of the agent ports. SQS uses @aws-sdk/client-sqs. S3 (logs) and STS (script roles) are bound
// through small functions so the agent core never depends on those packages; `main.ts` binds them to
// @aws-sdk/client-s3 and @aws-sdk/client-sts.
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { CommandSource, EventSink, LogStore, ReceivedCommandMessage, ScriptCredentials } from "./ports.js";

export function createSqsCommandSource(client: SQSClient, queueUrl: string): CommandSource {
  return {
    async receive(maxMessages, signal) {
      if (signal?.aborted === true) return [];
      const out = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: Math.max(1, Math.min(10, maxMessages)),
          WaitTimeSeconds: 20,
          VisibilityTimeout: 120,
          MessageSystemAttributeNames: ["SenderId", "SentTimestamp"],
        }),
        signal === undefined ? {} : { abortSignal: signal },
      );
      return (out.Messages ?? [])
        .filter((m) => m.MessageId !== undefined && m.ReceiptHandle !== undefined && m.Body !== undefined)
        .map((m): ReceivedCommandMessage => ({
          messageId: m.MessageId as string,
          receiptHandle: m.ReceiptHandle as string,
          body: m.Body as string,
          ...(m.Attributes?.SenderId === undefined ? {} : { senderId: m.Attributes.SenderId }),
        }));
    },
    async delete(receiptHandle) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
    },
    async extendVisibility(receiptHandle, seconds) {
      await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
    },
  };
}

export function createSqsEventSink(client: SQSClient, queueUrl: string): EventSink {
  return {
    async send(message) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message.body),
          MessageGroupId: message.groupId,
          MessageDeduplicationId: message.deduplicationId,
        }),
      );
    },
  };
}

/** S3 PutObject, bound in main.ts; every object is private and SSE-S3 encrypted (AP-6). */
export type PutObjectFn = (input: {
  Bucket: string;
  Key: string;
  Body: Uint8Array;
  ContentType: string;
  ContentEncoding?: string;
  ServerSideEncryption: "AES256";
}) => Promise<void>;

export function createS3LogStore(putObject: PutObjectFn): LogStore {
  return {
    async put(object) {
      await putObject({
        Bucket: object.bucket,
        Key: object.key,
        Body: object.body,
        ContentType: object.contentType,
        ...(object.contentEncoding === undefined ? {} : { ContentEncoding: object.contentEncoding }),
        ServerSideEncryption: "AES256",
      });
    },
  };
}

/** STS AssumeRole, bound in main.ts: 1 h, session name = execution id (CloudTrail). */
export type AssumeRoleFn = (input: { RoleArn: string; RoleSessionName: string; DurationSeconds: number }) => Promise<{
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
}>;

export function createStsScriptCredentials(assumeRole: AssumeRoleFn): ScriptCredentials {
  return {
    async forScript(roleArn, sessionName) {
      const c = await assumeRole({ RoleArn: roleArn, RoleSessionName: sessionName.slice(0, 64), DurationSeconds: 3600 });
      if (c.AccessKeyId === undefined || c.SecretAccessKey === undefined || c.SessionToken === undefined) throw new Error("AssumeRole returned no credentials");
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
    },
  };
}

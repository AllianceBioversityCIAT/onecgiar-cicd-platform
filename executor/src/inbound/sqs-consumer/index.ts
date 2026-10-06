// @akili-spec changes/cicd-executor-poc design §7 (sqs-consumer row), DD-14, DD-25; requirements FR-04 (RL-3), NFR-03
// Long-poll consumer: visibility heartbeat, ack/no-ack. No business logic.
//
// Contract:
//  - requests SenderId + ApproximateReceiveCount on receipt (DD-25);
//  - while the handler runs, visibility is extended every heartbeat interval (DD-14)
//    and the extension stops the moment the handler settles;
//  - the message is deleted (acknowledged) ONLY after the handler resolves
//    with `ack: true`. `ack: false` or a thrown error leaves the message on
//    the queue: SQS redelivers it and, after maxReceiveCount (5), moves it to
//    the DLQ (FR-04 / RL-3);
//  - the message body is never logged.
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { Logger, Metrics } from "../../observability/index.js";

export interface InboundMessage {
  readonly messageId: string;
  readonly body: string;
  /** SQS `SenderId` system attribute (DD-25); absent when the queue does not populate it. */
  readonly senderId?: string;
  readonly approximateReceiveCount: number;
}

export interface SqsConsumerDeps {
  readonly client: SQSClient;
  readonly queueUrl: string;
  readonly handle: (message: InboundMessage) => Promise<{ ack: boolean }>;
  readonly logger: Logger;
  /** Reserved for consumer metrics; the observability module defines none for the consumer yet. */
  readonly metrics: Metrics;
  /** Visibility timeout requested on receipt and re-applied by each heartbeat. Default 120. */
  readonly visibilityTimeoutSeconds?: number;
  /** Heartbeat period while a handler runs. Default 60 (design §7). */
  readonly heartbeatIntervalSeconds?: number;
  /** Long-poll wait. Default 20 (design §7). */
  readonly waitTimeSeconds?: number;
  /** Messages per receive. Default 1. */
  readonly maxMessages?: number;
  /** Upper bound that `stop()` waits for in-flight handlers. Default 30 000 ms. */
  readonly shutdownTimeoutMs?: number;
  /** Pause after a failed receive before polling again. Default 1 000 ms. */
  readonly receiveErrorBackoffMs?: number;
}

export interface SqsConsumer {
  /** Resolves once the polling loop is running (it does not wait for the loop to end). */
  start(): Promise<void>;
  /** Stops polling, waits (bounded) for in-flight handlers, then returns. */
  stop(): Promise<void>;
}

const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 120;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_MAX_MESSAGES = 1;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_RECEIVE_ERROR_BACKOFF_MS = 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toInboundMessage(message: Message): InboundMessage | undefined {
  if (message.MessageId === undefined || message.ReceiptHandle === undefined || message.Body === undefined) {
    return undefined;
  }
  const attributes = message.Attributes ?? {};
  const receiveCount = Number.parseInt(attributes["ApproximateReceiveCount"] ?? "", 10);
  const senderId = attributes["SenderId"];
  return {
    messageId: message.MessageId,
    body: message.Body,
    ...(senderId !== undefined ? { senderId } : {}),
    approximateReceiveCount: Number.isNaN(receiveCount) ? 1 : receiveCount,
  };
}

export function createSqsConsumer(deps: SqsConsumerDeps): SqsConsumer {
  const visibilityTimeoutSeconds = deps.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS;
  const heartbeatIntervalSeconds = deps.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
  const waitTimeSeconds = deps.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS;
  const maxMessages = deps.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const receiveErrorBackoffMs = deps.receiveErrorBackoffMs ?? DEFAULT_RECEIVE_ERROR_BACKOFF_MS;

  let running = false;
  let loop: Promise<void> | undefined;
  let pollAbort: AbortController | undefined;
  let wakeBackoff: (() => void) | undefined;
  const inFlight = new Set<Promise<void>>();
  const heartbeatStoppers = new Set<() => void>();

  /** Starts the DD-14 heartbeat for one message; returns a stopper that also drains an in-flight extension. */
  function startHeartbeat(messageId: string, receiptHandle: string): () => Promise<void> {
    let stopped = false;
    let pending: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped) {
        return;
      }
      pending = pending.then(async () => {
        if (stopped) {
          return;
        }
        try {
          await deps.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: deps.queueUrl,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: visibilityTimeoutSeconds,
            }),
          );
        } catch (error) {
          deps.logger.warn("visibility heartbeat failed", { messageId, error: errorMessage(error) });
        }
      });
    }, heartbeatIntervalSeconds * 1000);
    const stop = (): void => {
      stopped = true;
      clearInterval(timer);
    };
    heartbeatStoppers.add(stop);
    return async () => {
      stop();
      heartbeatStoppers.delete(stop);
      await pending;
    };
  }

  async function processMessage(raw: Message): Promise<void> {
    const message = toInboundMessage(raw);
    if (message === undefined || raw.ReceiptHandle === undefined) {
      deps.logger.warn("received an SQS message without id, receipt handle or body; leaving it on the queue");
      return;
    }
    const receiptHandle = raw.ReceiptHandle;
    const log = { messageId: message.messageId, approximateReceiveCount: message.approximateReceiveCount };
    const stopHeartbeat = startHeartbeat(message.messageId, receiptHandle);
    let ack = false;
    try {
      ack = (await deps.handle(message)).ack;
    } catch (error) {
      deps.logger.error("message handler threw; leaving the message for redelivery", {
        ...log,
        error: errorMessage(error),
      });
    } finally {
      // The extension stops first: nothing may extend a message that is about to be deleted.
      await stopHeartbeat();
    }
    if (!ack) {
      deps.logger.info("message not acknowledged; SQS will redeliver or dead-letter it", log);
      return;
    }
    try {
      await deps.client.send(new DeleteMessageCommand({ QueueUrl: deps.queueUrl, ReceiptHandle: receiptHandle }));
      deps.logger.info("message acknowledged", log);
    } catch (error) {
      // Redelivery after a failed delete is safe: processing is idempotent (DD-20).
      deps.logger.error("failed to delete an acknowledged message; it will be redelivered", {
        ...log,
        error: errorMessage(error),
      });
    }
  }

  function track(raw: Message): Promise<void> {
    const task: Promise<void> = processMessage(raw).finally(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);
    return task;
  }

  function backoff(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        wakeBackoff = undefined;
        resolve();
      };
      const timer = setTimeout(done, receiveErrorBackoffMs);
      wakeBackoff = done;
    });
  }

  async function pollLoop(): Promise<void> {
    while (running) {
      const abort = new AbortController();
      pollAbort = abort;
      let messages: Message[] = [];
      try {
        const result = await deps.client.send(
          new ReceiveMessageCommand({
            QueueUrl: deps.queueUrl,
            MaxNumberOfMessages: maxMessages,
            WaitTimeSeconds: waitTimeSeconds,
            VisibilityTimeout: visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ["SenderId", "ApproximateReceiveCount"],
          }),
          { abortSignal: abort.signal },
        );
        messages = result.Messages ?? [];
      } catch (error) {
        if (!running) {
          break;
        }
        deps.logger.error("SQS receive failed; retrying", { error: errorMessage(error) });
        await backoff();
        continue;
      } finally {
        pollAbort = undefined;
      }
      // Messages already received are always processed, even if stop() was
      // requested meanwhile: stop() waits for them (bounded).
      await Promise.all(messages.map(track));
    }
  }

  return {
    start(): Promise<void> {
      if (running) {
        return Promise.resolve();
      }
      running = true;
      loop = pollLoop().catch((error: unknown) => {
        deps.logger.error("SQS polling loop terminated unexpectedly", { error: errorMessage(error) });
      });
      return Promise.resolve();
    },

    async stop(): Promise<void> {
      running = false;
      pollAbort?.abort();
      wakeBackoff?.();
      const drained = Promise.all([loop, ...inFlight]).then(() => true);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), shutdownTimeoutMs);
      });
      const completed = await Promise.race([drained, timedOut]);
      clearTimeout(timer);
      if (!completed) {
        // Un-acked messages simply become visible again after their timeout (NFR-03).
        deps.logger.warn("shutdown timeout: abandoning in-flight handlers; their messages stay on the queue", {
          inFlight: inFlight.size,
        });
        for (const stopHeartbeat of heartbeatStoppers) {
          stopHeartbeat();
        }
      }
    },
  };
}

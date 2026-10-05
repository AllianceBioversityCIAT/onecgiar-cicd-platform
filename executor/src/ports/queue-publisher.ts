// @akili-spec changes/cicd-executor-poc design §6.1, §7
// Port: publishes envelopes (design §6.1) back onto the event queue —
// used by step-dispatcher, reconciler and deploy-window-service. Generic
// message shape only — no SQS SDK types here.

export interface QueueMessage {
  readonly body: Record<string, unknown>;
  /** Delay before the message becomes visible, in seconds (max 900, design §7.6). */
  readonly delaySeconds?: number;
}

export interface QueuePublisher {
  publish(message: QueueMessage): Promise<{ messageId: string }>;
}

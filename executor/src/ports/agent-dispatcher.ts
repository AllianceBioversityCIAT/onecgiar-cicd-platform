// @akili-spec changes/cicd-executor-poc architecture-change-04 §6, §8, AG-D1, AP-1
// Port: delivery of AGENT_COMMAND and AGENT_QUERY to ONE agent's FIFO command queue. The queue URL comes from the
// execution's snapshot (resolved from AGENT#{agentId} at X1), never from a message. Sending is fire-and-forget for
// the Executor: no response is awaited here; the agent's events arrive on the results queue.

export interface AgentQueueMessage {
  /** The agent's FIFO command queue (snapshot `commandQueueUrl`). */
  readonly queueUrl: string;
  /** Schema-valid AGENT_COMMAND or AGENT_QUERY body. */
  readonly body: Readonly<Record<string, unknown>>;
  /** FIFO MessageGroupId: the targetId (per-target order of commands, re-sends and queries). */
  readonly groupId: string;
  /** FIFO MessageDeduplicationId: the commandId (a re-send of the same dispatch is absorbed) or `<commandId>:q<n>`. */
  readonly deduplicationId: string;
}

export interface AgentDispatcher {
  /** Throws when SQS refuses or cannot be reached; the caller keeps the outbox state and the reconciler re-drives. */
  send(message: AgentQueueMessage): Promise<{ readonly messageId: string }>;
}

// @akili-spec changes/cicd-executor-poc architecture-change-04 §3, §6, §11.4
// Handler of the shared FIFO results queue: AGENT_EVENT and AGENT_HEARTBEAT, each authenticated by the role id of
// the SQS SenderId (set by SQS from the caller's credentials, never by the sender). Independent of the request
// consumer: no handler here waits for a deploy. Acknowledgement rules:
//   - applied, duplicate, late, refused or not-evidence events are acknowledged (state is in DynamoDB, audit written);
//   - RETRY (a concurrent writer moved the execution) is NOT acknowledged: SQS redelivers and the event is re-applied
//     on fresh state (FIFO keeps the execution's later events behind it);
//   - an unparseable or unknown message is NOT acknowledged, so it ends in the DLQ (alarm) instead of vanishing.
import type { InboundMessage } from "../sqs-consumer/index.js";
import type { AgentTransport } from "../../application/agent-transport/index.js";
import type { Logger } from "../../observability/logger/index.js";

export interface AgentResultsHandlerDeps {
  readonly agent: Pick<AgentTransport, "applyEvent" | "applyHeartbeat">;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
  /** Called after an event closed an execution or released a hold (notifications, best effort). */
  readonly onOutcome?: (executionId: string) => void;
}

/** `AROA...:session` -> `AROA...` (an agent role); `AIDA...` as is (the shared agent user); undefined when SQS supplied no SenderId. */
function roleIdOf(senderId: string | undefined): string | undefined {
  if (senderId === undefined) return undefined;
  const separator = senderId.indexOf(":");
  return separator > 0 ? senderId.slice(0, separator) : senderId;
}

export function createAgentResultsHandler(deps: AgentResultsHandlerDeps): (message: InboundMessage) => Promise<{ ack: boolean }> {
  return async (message) => {
    let body: unknown;
    try {
      body = JSON.parse(message.body);
    } catch {
      deps.logger.warn("agent results: unparseable message left for the dead-letter queue", { messageId: message.messageId });
      return { ack: false };
    }
    const type = typeof body === "object" && body !== null ? (body as { type?: unknown }).type : undefined;
    const senderRoleId = roleIdOf(message.senderId);

    if (type === "AGENT_HEARTBEAT") {
      const out = await deps.agent.applyHeartbeat(body, senderRoleId);
      if (out !== "RECORDED") deps.logger.warn("agent heartbeat not recorded", { messageId: message.messageId, outcome: out });
      return { ack: true };
    }
    if (type !== "AGENT_EVENT") {
      deps.logger.warn("agent results: unknown message type left for the dead-letter queue", { messageId: message.messageId });
      return { ack: false };
    }

    const out = await deps.agent.applyEvent(body, senderRoleId);
    const executionId = (body as { executionId?: unknown }).executionId;
    switch (out.outcome) {
      case "RETRY":
        return { ack: false };
      case "CLOSED":
        deps.logger.info("agent event closed the execution", { executionId, transitionId: out.transitionId, status: out.status });
        if (typeof executionId === "string") deps.onOutcome?.(executionId);
        return { ack: true };
      case "HOLD_RELEASED":
        deps.logger.info("agent evidence released the hold", { executionId });
        if (typeof executionId === "string") deps.onOutcome?.(executionId);
        return { ack: true };
      case "INVALID":
        deps.logger.warn("agent event invalid", { messageId: message.messageId, problems: out.problems });
        return { ack: true };
      case "REFUSED":
        deps.logger.warn("agent event refused", { messageId: message.messageId, executionId, reason: out.reason });
        return { ack: true };
      case "OPERATOR_REQUIRED":
        deps.logger.warn("late agent result on a held target: operator resolution required", { executionId });
        return { ack: true };
      default:
        return { ack: true };
    }
  };
}

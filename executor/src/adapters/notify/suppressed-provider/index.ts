// @akili-spec changes/cicd-executor-poc design §6.6, DD-12; requirements FR-14
// NotificationProvider used instead of Slack when the operator sets
// `CICD_NOTIFICATIONS_DISABLED=true` (tests or maintenance outside working
// hours). It sends nothing: it reads no secret, opens no connection and only
// logs `notification suppressed` with the event kind and execution id. The
// notification service still claims its `EVT#` mark before calling it, so the
// audit trail is the same as with Slack; no thread reference is returned.
import type { NotificationEvent, NotificationProvider } from "../../../ports/notification-provider.js";
import type { Logger } from "../../../observability/logger/index.js";

export interface CreateSuppressedProviderDeps {
  readonly logger: Pick<Logger, "info">;
}

export function createSuppressedNotificationProvider(deps: CreateSuppressedProviderDeps): NotificationProvider {
  return {
    name: "suppressed",
    async notify(event: NotificationEvent): Promise<{ threadRef?: string }> {
      // Only the kind and the execution id: never the message, channel or token reference.
      deps.logger.info("notification suppressed", {
        eventType: "NOTIFICATION_SUPPRESSED",
        kind: event.kind,
        ...(event.executionId !== undefined ? { executionId: event.executionId } : {}),
      });
      return {};
    },
  };
}

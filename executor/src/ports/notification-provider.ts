// @akili-spec changes/cicd-executor-poc design DD-12, §7
// Port: fan-out target for notification-service (e.g. Slack in the PoC).
// Best-effort; never influences execution/step state.

export interface NotificationEvent {
  readonly executionId: string;
  readonly kind: string;
  readonly message: string;
  /** Thread/conversation reference to reply into, when the provider supports it. */
  readonly threadRef?: string;
}

export interface NotificationProvider {
  readonly name: string;
  notify(event: NotificationEvent): Promise<{ threadRef?: string }>;
}

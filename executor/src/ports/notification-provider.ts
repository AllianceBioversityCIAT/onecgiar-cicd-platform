// @akili-spec changes/cicd-executor-poc design DD-12, §6.6, §7
// Port: fan-out target for notification-service (e.g. Slack in the PoC).
// Best-effort; never influences execution state (FR-14).

export interface NotificationEvent {
  /** Execution the message belongs to; absent for REJECTED (no execution exists). */
  readonly executionId?: string;
  readonly kind: string;
  /** Already redacted, secret-free text. */
  readonly message: string;
  /** Logical references; the provider resolves them (channel to an identifier, token via `SecretProvider` at point of use). */
  readonly channelRef: string;
  readonly tokenRef: string;
  /** Thread/conversation reference to reply into, when the provider supports it. */
  readonly threadRef?: string;
  /** When set together with `threadRef`, the thread root is rewritten with this text (design §6.6: root updated with the outcome and duration). */
  readonly rootText?: string;
}

export interface NotificationProvider {
  readonly name: string;
  notify(event: NotificationEvent): Promise<{ threadRef?: string }>;
}

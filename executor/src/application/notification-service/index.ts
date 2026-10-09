// @akili-spec changes/cicd-executor-poc design §6.6, §5.1, §7, DD-12; requirements FR-14, FR-17
// Deploy-lifecycle notifications (accepted, rejected, superseded, lock
// timeout, window closed, failure, unknown target state, success) fanned out
// to interchangeable providers. Best-effort and never state-changing:
//   - `notify` never throws; a provider or mark-store failure is logged
//     (redacted) and counted, nothing else.
//   - Dedupe: an `EVT#{eventKey}` mark (`attribute_not_exists`) is claimed
//     BEFORE sending, so a redelivered or replayed event yields one message.
//     Consequence (accepted, best-effort): a failed send is not retried.
//   - CI failures are never posted here (OD-A5).
// Message text is built only from logical names, executionId, short commit,
// the GitHub run link and a logs link; the final text is redacted again.
import type { NotificationProvider } from "../../ports/notification-provider.js";
import type { Logger } from "../../observability/logger/index.js";
import type { Metrics } from "../../observability/metrics/index.js";
import { redactString } from "../../observability/logger/redaction.js";

const MARK_TTL_SECONDS = 7 * 24 * 60 * 60;
const SHORT_SHA_LENGTH = 7;

/** Presence-only mark port; satisfied by `EventMarkRepository` (N-08). */
export interface EventMarkStore {
  markOnce(executionId: string, eventKey: string, expiresAt: number): Promise<boolean>;
}

export interface NotificationDestination {
  readonly channelRef: string;
  readonly tokenRef: string;
}

interface ExecutionNotificationBase {
  readonly executionId: string;
  /** V1 deploy identity (design §1.2, §6.6). */
  readonly targetId: string;
  readonly commitSha: string;
  readonly runUrl: string;
  readonly logsUrl?: string;
  readonly destination: NotificationDestination;
  /** Slack root reference (`slackThreadTs`); required for replies, absent only for the root message. */
  readonly threadRef?: string;
  readonly durationMs?: number;
}

export type NotificationInput =
  | (ExecutionNotificationBase & { readonly kind: "ACCEPTED" })
  | (ExecutionNotificationBase & { readonly kind: "SUPERSEDED"; readonly supersededByExecutionId?: string })
  | (ExecutionNotificationBase & { readonly kind: "DEPLOY_WINDOW_CLOSED" })
  | (ExecutionNotificationBase & { readonly kind: "LOCK_TIMEOUT" })
  | (ExecutionNotificationBase & { readonly kind: "DEPLOY_FAILED"; readonly code: string })
  | (ExecutionNotificationBase & { readonly kind: "UNKNOWN_TARGET_STATE"; readonly runbookUrl: string })
  | (ExecutionNotificationBase & {
      readonly kind: "SUCCEEDED";
      /** AC-03 G-D7: whether the script's report proves the requested version (absent on executions finished before AC-03). */
      readonly versionCheck?: "VERIFIED" | "MISMATCH" | "NOT_REPORTED";
      readonly versionGuaranteed?: boolean;
    })
  | {
      /** Goes to the platform channel: reason and sender REFERENCE only (design §6.6). */
      readonly kind: "REJECTED";
      readonly rejectionId: string;
      readonly reason: string;
      readonly senderRef: string;
      readonly destination: NotificationDestination;
    };

export interface NotificationServiceDeps {
  readonly providers: readonly NotificationProvider[];
  readonly marks: EventMarkStore;
  readonly logger: Logger;
  readonly metrics: Pick<Metrics, "recordNotificationFailed">;
  readonly clock: { now(): Date };
}

export interface NotificationService {
  /** Resolves with the root thread reference when a provider returned one; never rejects. */
  notify(input: NotificationInput): Promise<{ threadRef?: string }>;
}

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function formatDuration(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

function eventKeyFor(input: NotificationInput): string {
  return input.kind === "DEPLOY_FAILED" ? `${input.kind}:${input.code}` : input.kind;
}

function markScopeFor(input: NotificationInput): string {
  return input.kind === "REJECTED" ? `REJECT#${input.rejectionId}` : input.executionId;
}

function detailLine(input: ExecutionNotificationBase): string {
  const parts = [
    `target ${input.targetId}`,
    `execution ${input.executionId}`,
    `commit ${shortSha(input.commitSha)}`,
    `run ${input.runUrl}`,
  ];
  if (input.logsUrl !== undefined) parts.push(`logs ${input.logsUrl}`);
  return parts.join(" | ");
}

function versionLabel(check: "VERIFIED" | "MISMATCH" | "NOT_REPORTED" | undefined, guaranteed: boolean | undefined): string {
  if (check === undefined) return "";
  const text = check === "VERIFIED" ? "version verified" : check === "MISMATCH" ? "VERSION MISMATCH: the deployed version differs from the request" : "version not verified";
  return ` | ${text}${guaranteed === false ? " (not guaranteed: the script runs without arguments)" : ""}`;
}

function buildMessage(input: NotificationInput): { message: string; rootText?: string } {
  if (input.kind === "REJECTED") {
    return { message: `Request rejected: ${input.reason} (sender ref ${input.senderRef})` };
  }
  const details = detailLine(input);
  const duration = input.durationMs !== undefined ? ` in ${formatDuration(input.durationMs)}` : "";
  switch (input.kind) {
    case "ACCEPTED":
      return { message: `Deploy queued: ${details}` };
    case "SUPERSEDED":
      return {
        message:
          `Superseded${input.supersededByExecutionId !== undefined ? ` by execution ${input.supersededByExecutionId}` : ""}` +
          ` | ${details}`,
        rootText: `Deploy superseded | ${details}`,
      };
    case "DEPLOY_WINDOW_CLOSED":
      return { message: `DEPLOY_WINDOW_CLOSED | ${details}`, rootText: `Deploy failed: DEPLOY_WINDOW_CLOSED${duration} | ${details}` };
    case "LOCK_TIMEOUT":
      return { message: `LOCK_TIMEOUT | ${details}`, rootText: `Deploy failed: LOCK_TIMEOUT${duration} | ${details}` };
    case "DEPLOY_FAILED":
      return { message: `Deploy failed: ${input.code} | ${details}`, rootText: `Deploy failed: ${input.code}${duration} | ${details}` };
    case "UNKNOWN_TARGET_STATE":
      return {
        message: `UNKNOWN_TARGET_STATE: target state needs operator review, see ${input.runbookUrl} | ${details}`,
        rootText: `Deploy failed: UNKNOWN_TARGET_STATE${duration} | ${details}`,
      };
    case "SUCCEEDED": {
      // AC-03 G-D7: "script succeeded" is never presented as "version verified" without evidence.
      const version = versionLabel(input.versionCheck, input.versionGuaranteed);
      return { message: `Deploy succeeded${duration}${version} | ${details}`, rootText: `Deploy succeeded${duration}${version} | ${details}` };
    }
  }
}

export function createNotificationService(deps: NotificationServiceDeps): NotificationService {
  const { providers, marks, logger, metrics, clock } = deps;

  function logFailure(message: string, input: NotificationInput, error: unknown, provider?: string): void {
    try {
      logger.error(message, {
        eventType: "NOTIFICATION_FAILED",
        kind: input.kind,
        ...(input.kind !== "REJECTED" ? { executionId: input.executionId } : {}),
        ...(provider !== undefined ? { provider } : {}),
        error: redactString(error instanceof Error ? error.message : String(error)),
      });
    } catch {
      // Logging must never throw into the caller (FR-14).
    }
  }

  return {
    async notify(input) {
      try {
        const eventKey = eventKeyFor(input);
        const expiresAt = Math.floor(clock.now().getTime() / 1000) + MARK_TTL_SECONDS;
        let claimed: boolean;
        try {
          claimed = await marks.markOnce(markScopeFor(input), eventKey, expiresAt);
        } catch (error) {
          logFailure("notification skipped: event mark write failed", input, error);
          return {};
        }
        if (!claimed) return {};

        const built = buildMessage(input);
        const message = redactString(built.message);
        const rootText = built.rootText !== undefined ? redactString(built.rootText) : undefined;
        const threadRef = input.kind === "REJECTED" ? undefined : input.threadRef;

        let resultingThreadRef: string | undefined;
        for (const provider of providers) {
          try {
            const result = await provider.notify({
              ...(input.kind !== "REJECTED" ? { executionId: input.executionId } : {}),
              kind: input.kind,
              message,
              channelRef: input.destination.channelRef,
              tokenRef: input.destination.tokenRef,
              ...(threadRef !== undefined ? { threadRef } : {}),
              ...(threadRef !== undefined && rootText !== undefined ? { rootText } : {}),
            });
            resultingThreadRef ??= result.threadRef;
          } catch (error) {
            logFailure("notification provider failed", input, error, provider.name);
            try {
              metrics.recordNotificationFailed(provider.name);
            } catch {
              // Metrics must never throw into the caller (FR-14).
            }
          }
        }
        return resultingThreadRef !== undefined ? { threadRef: resultingThreadRef } : {};
      } catch (error) {
        logFailure("notification failed unexpectedly", input, error);
        return {};
      }
    },
  };
}

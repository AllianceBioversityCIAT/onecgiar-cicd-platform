// @akili-spec changes/cicd-executor-poc design §3.3, §7 (main); requirements FR-04, FR-12, FR-14, FR-21
// Shared fixtures for the composition tests: the REAL bundled definitions with
// fake resolved values, an in-memory loopback queue that stamps `SenderId` the
// way SQS would, a fake deploy transport and a recording notification provider.
import { findRepoRoot, BundledDefinitionSource } from "../../src/adapters/bundled-definition-source/index.js";
import type { InboundMessage } from "../../src/inbound/sqs-consumer/index.js";
import type { DeploySession, DeployTransport, ScriptExecOutcome, ScriptExecRequest, SshTarget } from "../../src/ports/deploy-transport.js";
import type { NotificationEvent, NotificationProvider } from "../../src/ports/notification-provider.js";
import type { QueueMessage, QueuePublisher } from "../../src/ports/queue-publisher.js";
import { FakeSecretProvider } from "./fake-secret-provider.js";

export const CI_ROLE = "FAKECIROLEID";
export const EXECUTOR_ROLE = "FAKEEXECUTORROLEID";
export const SCHEDULER_ROLE = "FAKESCHEDULERROLEID";
export const OPERATOR_ROLE = "FAKEOPERATORROLEID";

export const KNOWN_REFS: Record<string, string> = {
  "<PRMS_REPORTING_REPO_REF>": "example-org/example-app",
  "<PRMS_REPORTING_DEPLOY_WORKFLOW_REF>": "resolved-workflow",
  "<PRMS_REPORTING_GITHUB_ENVIRONMENT_REF>": "resolved-environment",
  "<PRMS_REPORTING_CI_ROLE_REF>": CI_ROLE,
  "<PRMS_REPORTING_SERVER_HEALTH_URL_REF>": "resolved-server-health",
  "<PRMS_REPORTING_CLIENT_HEALTH_URL_REF>": "resolved-client-health",
  "<PRMS_REPORTING_SLACK_CHANNEL_REF>": "resolved-slack-channel",
  "<CI_PRINCIPAL_REF>": CI_ROLE,
  "<EXECUTOR_PRINCIPAL_REF>": EXECUTOR_ROLE,
  "<SCHEDULER_PRINCIPAL_REF>": SCHEDULER_ROLE,
  "<OPERATOR_PRINCIPAL_REF>": OPERATOR_ROLE,
  "<SLACK_TOKEN_REF>": "resolved-slack-token",
  "<PLATFORM_SLACK_CHANNEL_REF>": "resolved-platform-channel",
  "<PLATFORM_SLACK_TOKEN_REF>": "resolved-platform-token",
  "<PRMS_REPORTING_DEV_CONNECTION_REF>": JSON.stringify({ host: "resolved-host", port: 22, user: "deploy" }),
  "<PRMS_REPORTING_DEV_HOST_KEY_REF>": "resolved-host-key",
  "<PRMS_REPORTING_DEV_SSH_CREDENTIAL_REF>": "resolved-ssh-credential",
  "<PRMS_REPORTING_DEV_EXTERNAL_DEPLOYERS_REF>": JSON.stringify(["<JENKINS_JOB_A>", "<JENKINS_JOB_B>"]),
  "<SERVER_CONTAINER>": "server-container",
  "<PRMS_REPORTING_SERVER_IMAGE_REPOSITORY_REF>": "server-repo",
  "<PRMS_REPORTING_SERVER_PORT_REF>": "8080:3000",
  "<CLIENT_CONTAINER>": "client-container",
  "<PRMS_REPORTING_CLIENT_IMAGE_REPOSITORY_REF>": "client-repo",
  "<PRMS_REPORTING_CLIENT_PORT_REF>": "8081:4001",
};

/** The runtime secret reference of the application is DELIBERATELY not resolvable: the Executor must never ask for it (NFR-01). */
export function fakeSecrets(): FakeSecretProvider {
  return new FakeSecretProvider(KNOWN_REFS);
}

export function validEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CICD_TABLE_NAME: "cicd-executor-test",
    CICD_REGISTRY_TABLE_NAME: "cicd-registry-test",
    CICD_QUEUE_URL: "https://queue.example.invalid/<AWS_ACCOUNT_ID>/events",
    AWS_REGION: "us-east-1",
    CICD_CI_PRINCIPAL_REF: "<CI_PRINCIPAL_REF>",
    CICD_EXECUTOR_PRINCIPAL_REF: "<EXECUTOR_PRINCIPAL_REF>",
    CICD_SCHEDULER_PRINCIPAL_REF: "<SCHEDULER_PRINCIPAL_REF>",
    CICD_OPERATOR_PRINCIPAL_REF: "<OPERATOR_PRINCIPAL_REF>",
    CICD_PLATFORM_SLACK_CHANNEL_REF: "<PLATFORM_SLACK_CHANNEL_REF>",
    CICD_PLATFORM_SLACK_TOKEN_REF: "<PLATFORM_SLACK_TOKEN_REF>",
    CICD_LOGS_URL_TEMPLATE: "https://logs.example.invalid/search?q={executionId}",
    CICD_RUNBOOK_URL: "https://runbook.example.invalid/unknown-target-state",
    CICD_DEFINITION_REF: "test-definition-ref",
    CICD_HEALTHCHECK_PATH: "health.test.tmp",
    ...over,
  } as NodeJS.ProcessEnv;
}

/** The real bundled definitions of the repository (deployment-definitions/, schemas/, deploy-scripts/). */
export function bundledDefinitions(): BundledDefinitionSource {
  const root = findRepoRoot(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return new BundledDefinitionSource({ repoRoot: root, env: { CICD_DEFINITION_REF: "test-definition-ref" } });
}

/** In-memory loopback queue: what the Executor publishes is delivered back to it, stamped with the executor principal like SQS would. */
export class LoopbackQueue implements QueuePublisher {
  public readonly published: QueueMessage[] = [];
  private readonly inbox: InboundMessage[] = [];
  private counter = 0;

  public async publish(message: QueueMessage): Promise<{ messageId: string }> {
    this.published.push(message);
    this.counter += 1;
    const messageId = `loop-${String(this.counter)}`;
    this.inbox.push({ messageId, body: JSON.stringify(message.body), senderId: `${EXECUTOR_ROLE}:executor-session`, approximateReceiveCount: 1 });
    return { messageId };
  }

  /** Delivers everything queued (ignoring delays) to `handle` until the queue is empty. */
  public async drain(handle: (m: InboundMessage) => Promise<{ ack: boolean }>): Promise<void> {
    for (let guard = 0; guard < 50 && this.inbox.length > 0; guard += 1) {
      const next = this.inbox.shift() as InboundMessage;
      await handle(next);
    }
  }
}

export class RecordingProvider implements NotificationProvider {
  public readonly name = "recording";
  public readonly events: NotificationEvent[] = [];
  public async notify(event: NotificationEvent): Promise<{ threadRef?: string }> {
    this.events.push(event);
    return { threadRef: event.threadRef ?? "1700000000.000100" };
  }
}

/** A transport whose script "succeeds"; it records every SSH target and exec it receives (AC-02 V1: nothing is delivered). */
export function successfulTransport(calls: ScriptExecRequest[] = [], exit: ScriptExecOutcome = {
  kind: "EXIT",
  exitCode: 0,
  cicdResult: { status: "SUCCESS", deployedImages: { "server-container": "server-repo@sha256:aa" }, healthy: true },
}, targets: SshTarget[] = []): DeployTransport {
  return {
    async connect(target: SshTarget): Promise<DeploySession> {
      targets.push(target);
      return {
        async exec(request) {
          calls.push(request);
          return exit;
        },
        async close() {},
      };
    },
  };
}

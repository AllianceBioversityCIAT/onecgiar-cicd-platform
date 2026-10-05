// @akili-spec changes/cicd-executor-poc design §6.6
// In-memory fakes for the core's ports. No AWS SDK anywhere in this file or
// in any test that uses it — the brief requires "no AWS SDK calls in tests".
import type {
  GithubPushPipelineDefinition,
  Logger,
  PipelineDefinitionReader,
  PipelineRequestedEnvelope,
  QueuePublisher,
  SecretReader,
} from "../../src/core/ports.js";

export class FakeSecretReader implements SecretReader {
  constructor(private readonly secret: string) {}
  async getWebhookSecret(): Promise<string> {
    return this.secret;
  }
}

export class FakeDefinitionReader implements PipelineDefinitionReader {
  constructor(private readonly definitions: readonly GithubPushPipelineDefinition[]) {}
  async listGithubPushDefinitions(): Promise<readonly GithubPushPipelineDefinition[]> {
    return this.definitions;
  }
}

export class FakeQueuePublisher implements QueuePublisher {
  readonly published: PipelineRequestedEnvelope[] = [];
  async publish(envelope: PipelineRequestedEnvelope): Promise<void> {
    this.published.push(envelope);
  }
}

export class FakeLogger implements Logger {
  readonly entries: Record<string, unknown>[] = [];
  log(entry: Readonly<Record<string, unknown>>): void {
    this.entries.push({ ...entry });
  }
}

export const FIXED_SECRET = "<WEBHOOK_SECRET_REF>-test-value";

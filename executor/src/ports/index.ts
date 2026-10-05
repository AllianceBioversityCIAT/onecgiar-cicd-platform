// @akili-spec changes/cicd-executor-poc design §3.2, §4.2, §7
// Barrel export for all outbound ports. Domain and application code depend
// only on these interfaces; adapters/* provide the implementations wired
// together in src/main.

export type { Clock } from "./clock.js";
export type {
  StateStore,
  StateItemKey,
  WriteCondition,
} from "./state-store.js";
export type { ArtifactStore, ArtifactLocation } from "./artifact-store.js";
export type { QueuePublisher, QueueMessage } from "./queue-publisher.js";
export type {
  DefinitionSource,
  DefinitionContent,
} from "./definition-source.js";
export type { SecretProvider } from "./secret-provider.js";
export type { GitClient } from "./git-client.js";
export type {
  StepHandler,
  StepContext,
  DispatchResult,
} from "./step-handler.js";
export type {
  NotificationProvider,
  NotificationEvent,
} from "./notification-provider.js";

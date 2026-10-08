// @akili-spec changes/cicd-executor-poc design §1.2, §3.3, §4.2, §7 (all module rows), §12, DD-14, DD-16, DD-19 (superseded in V1), DD-23, DD-25; architecture-change-02 AC2-6, AC2-7; requirements FR-04, FR-05, FR-14, FR-15, FR-21, NFR-03, NFR-04; tasks R-6
// Composition root (N-17b): wires ports to adapters and services, in the
// order of design §4.2. Pure wiring: every business rule lives in the module
// it names. Order matters:
//   1. configuration (fail fast, all problems at once);
//   2. platform configuration (AC-02 V1, R-6): the principal refs resolve to
//      role IDs and the platform Slack channel and token secrets must exist
//      (AC2-6, AC2-7); a missing one prevents startup naming the ref. No
//      Deployment Definition is loaded and no target is read: zero targets is
//      a valid starting state. Only the bundled `schemas/` are read;
//   3. adapters and services, the consumer last (nothing is read from the
//      queue before everything it can reach is wired).
// AWS credentials come from the SDK standard chain (DD-16; OD-Q12 open): no
// credential is configured or read here. Application secrets are never read
// (NFR-01).
// AC-02 V1 (R-4, R-5): requests and the deploy path never use a definition.
// The router resolves the named target with one GetItem on the Target
// Registry (R-3) and authorizes its source repository (option A); the deploy
// path runs from the execution snapshot.
import { SQSClient } from "@aws-sdk/client-sqs";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BundledSchemaSource } from "../adapters/bundled-schema-source/index.js";
import {
  DeployTransactions,
  DeployWindowRepository,
  DynamoDbStateStore,
  EventMarkRepository,
  ExecutionRepository,
  LockRepository,
  RejectionRepository,
  ResolutionAuditRepository,
  SequenceRepository,
  TargetStateRepository,
  DedupeRepository,
  createDocumentClient,
} from "../adapters/dynamodb-state-store/index.js";
import { createSlackProvider } from "../adapters/notify/slack-provider/index.js";
import { createSqsQueuePublisher } from "../adapters/sqs-publisher/index.js";
import { Ssh2DeployTransport } from "../adapters/ssh-deployer/index.js";
import { DynamoDbTargetRegistry } from "../adapters/dynamodb-target-registry/index.js";
import { createDeployCoordinator, DEFAULT_SSH_CONCURRENCY, Semaphore } from "../application/deploy-coordinator/index.js";
import { DeployWindowService, TargetResolutionService } from "../application/deploy-window-service/index.js";
import { createExecutionService } from "../application/execution-service/index.js";
import { createMessageValidators, routeMessage } from "../application/message-router/index.js";
import { createNotificationService } from "../application/notification-service/index.js";
import { resolvePlatformConfig } from "../application/platform-config/index.js";
import { createReconciler } from "../application/reconciler/index.js";
import { createSenderAuthorizer } from "../application/sender-authorizer/index.js";
import { createSqsConsumer, type InboundMessage } from "../inbound/sqs-consumer/index.js";
import {
  createFsHealthcheckWriter,
  createHeartbeat,
  createLogger,
  createMetrics,
  type HealthcheckWriter,
  type Logger,
  type LogSink,
  type Metrics,
  type MetricsSink,
} from "../observability/index.js";
import type { Clock } from "../ports/clock.js";
import type { DeployTransport } from "../ports/deploy-transport.js";
import type { NotificationProvider } from "../ports/notification-provider.js";
import type { QueuePublisher } from "../ports/queue-publisher.js";
import type { SchemaSource } from "../ports/schema-source.js";
import type { SecretProvider } from "../ports/secret-provider.js";
import {
  createExecutionLookup,
  createLockOwnerLookup,
  createResolutionAuditWriter,
  createTargetOrderingPort,
  createUnresolvedStore,
} from "../composition/adapters.js";
import { loadConfig, type ExecutorConfig } from "../composition/config.js";
import { createMessageHandlers, withNotifications } from "../composition/handlers.js";
import { createLifecycleNotifier } from "../composition/lifecycle-notifier.js";
import { createPendingTasks } from "../composition/pending-tasks.js";

/** The queue consumer seam: production is `createSqsConsumer`; the composition test substitutes an in-memory queue. */
export interface ConsumerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BootstrapOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Resolves the Executor's OWN operational refs (DD-23). Required: the Secrets Manager adapter is wired by the entry point. */
  readonly secrets: SecretProvider;
  readonly clock?: Clock;
  readonly logSink?: LogSink & { flush?(): Promise<void> | void };
  readonly metricsSink?: MetricsSink;
  readonly healthcheckWriter?: HealthcheckWriter;
  /** The bundled JSON Schemas; default: `schemas/` under `CICD_DEFINITIONS_ROOT` (AC-02 V1: nothing else is read from it). */
  readonly schemas?: SchemaSource;
  readonly documentClient?: DynamoDBDocumentClient;
  /** Replaces the SSH transport (the composition test uses a fake). */
  readonly createTransport?: () => DeployTransport;
  readonly notificationProviders?: readonly NotificationProvider[];
  /** Publishes back onto the event queue; default: the SQS publisher of N-17a. */
  readonly publisher?: QueuePublisher;
  /** Builds the consumer around the composed `handle`; default: the SQS long-poll consumer of N-17a. */
  readonly createConsumer?: (deps: {
    handle: (message: InboundMessage) => Promise<{ ack: boolean }>;
    logger: Logger;
    metrics: Metrics;
  }) => ConsumerHandle;
  readonly healthcheckIntervalMs?: number;
}

export interface Executor {
  readonly config: ExecutorConfig;
  /** Routes one raw message exactly as the consumer would (used by the consumer and by tests). */
  handle(message: InboundMessage): Promise<{ ack: boolean }>;
  start(): Promise<void>;
  /** Ordered shutdown (idempotent): stop the consumer, wait for in-flight work, then flush logs. */
  stop(): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };

export async function bootstrap(options: BootstrapOptions): Promise<Executor> {
  // 1. Configuration.
  const config = loadConfig(options.env);
  const clock = options.clock ?? systemClock;
  const stdoutSink: LogSink & MetricsSink = { write: (line) => void process.stdout.write(`${line}\n`) };
  const logSink: LogSink & { flush?(): Promise<void> | void } = options.logSink ?? stdoutSink;
  const logger = createLogger({ sink: logSink, clock });
  const metrics = createMetrics({ sink: options.metricsSink ?? stdoutSink, clock });
  const secrets = options.secrets;

  // 2. Platform configuration (AC2-6, AC2-7) and the bundled schemas. Any failure prevents startup.
  const platform = await resolvePlatformConfig(secrets, { principalRefs: config.principalRefs, platformSlack: config.platformSlack });
  const schemas = options.schemas ?? new BundledSchemaSource(config.definitionsRoot === undefined ? {} : { root: config.definitionsRoot });
  const validators = await createMessageValidators(schemas);
  const targetRecordSchema = JSON.parse((await schemas.getSchema("target-record.schema.json")).content) as object;

  // 3. Adapters over the single table (design §5.1).
  const client = options.documentClient ?? createDocumentClient({ tableName: config.tableName, region: config.region, ...(config.dynamoEndpoint === undefined ? {} : { endpoint: config.dynamoEndpoint }) });
  const table = config.tableName;
  const executions = new ExecutionRepository(client, table);
  const targets = new TargetStateRepository(client, table);
  const locks = new LockRepository(client, table);
  const windowsRepo = new DeployWindowRepository(client, table);
  const stateStore = new DynamoDbStateStore(client, table);
  const transactions = new DeployTransactions(client, executions, targets);
  const dedupe = new DedupeRepository(client, table);
  // Target Registry (AC-02 V1, design §5.3): a separate table read with GetItem only; validated with the R-1 schema.
  const registry = new DynamoDbTargetRegistry({
    client,
    tableName: config.registryTableName,
    schema: targetRecordSchema,
  });

  const sqs = options.publisher === undefined || options.createConsumer === undefined ? new SQSClient({ region: config.region }) : undefined;
  const publisher = options.publisher ?? createSqsQueuePublisher({ client: sqs as SQSClient, queueUrl: config.queueUrl });

  const pending = createPendingTasks();
  const providers = options.notificationProviders ?? [createSlackProvider({ secrets, resolveChannel: (ref) => secrets.getSecret(ref) })];
  const notifications = createNotificationService({
    providers,
    marks: new EventMarkRepository(client, table),
    logger,
    metrics,
    clock,
  });
  const notifier = createLifecycleNotifier({
    notifications,
    executions,
    platformSlack: config.platformSlack,
    logsUrlTemplate: config.logsUrlTemplate,
    runbookUrl: config.runbookUrl,
    metrics,
    logger,
    pending,
  });

  // 4. Services.
  const windows = new DeployWindowService({ windows: windowsRepo, targets: registry, clock });
  const transport = options.createTransport?.() ?? new Ssh2DeployTransport({ secrets, logger });
  const rawCoordinator = createDeployCoordinator({
    executions,
    transactions,
    locks,
    target: targets,
    windows,
    transport,
    queue: publisher,
    clock,
    semaphore: new Semaphore(config.sshConcurrency),
    onCleanupError: (error, resource) => logger.warn("coordinator cleanup failed", { resource, error: error instanceof Error ? error.message : String(error) }),
  });
  const coordinator = withNotifications(rawCoordinator, notifier, pending);
  const executionService = createExecutionService({
    dedupe,
    sequences: new SequenceRepository(client, table),
    executions,
    rejections: new RejectionRepository(client, table),
    target: createTargetOrderingPort({ targets, clock }),
    clock,
  });
  const reconciler = createReconciler({
    index: stateStore,
    executions,
    transactions,
    windows: windowsRepo,
    target: targets,
    coordinator,
    queue: publisher,
    metrics,
    clock,
    onTransitioned: (info) => notifier.outcomeInBackground(info.executionId),
  });
  const resolution = new TargetResolutionService({
    unresolved: createUnresolvedStore({ targets, clock }),
    executions: createExecutionLookup(executions),
    locks: createLockOwnerLookup(locks),
    audit: createResolutionAuditWriter(new ResolutionAuditRepository(client, table)),
    clock,
  });

  // 5. Router: sender authorization (DD-25: the shared CI role and the platform principals), the Target Registry
  //    lookup and source authorization (option A), handlers bound to the services.
  const authorizer = createSenderAuthorizer({ principals: platform.principals, metrics });
  const handlers = createMessageHandlers({ executionService, coordinator, reconciler, windows, resolution, notifier, metrics, logger, pending });
  const routerDeps = { validators, authorizer, targets: registry, dedupe, clock, handlers };

  async function handle(message: InboundMessage): Promise<{ ack: boolean }> {
    const result = await routeMessage(
      { body: message.body, messageId: message.messageId, ...(message.senderId === undefined ? {} : { senderId: message.senderId }) },
      routerDeps,
    );
    if (result.outcome === "UNROUTABLE") {
      logger.warn("unroutable message left for the dead-letter queue", {
        messageId: message.messageId,
        reason: result.reason,
        approximateReceiveCount: message.approximateReceiveCount,
      });
    }
    return { ack: result.ack };
  }

  // 6. Consumer and liveness (design §12): the heartbeat metric and the healthcheck file; the consumer keeps SQS visibility alive (DD-14).
  // NFR-04: one long deploy (up to the deploy timeout) occupies a poller for its whole run, because the consumer awaits its
  // handlers before polling again. A single poller would therefore starve every other deployment's lock retries, so the
  // composition runs several independent single-message pollers: one per SSH slot (the semaphore bound) plus two reserved for
  // lock retries, reconcile ticks and window events. `maxMessages` stays 1 on purpose: a batch would be held until its slowest
  // handler finishes.
  const pollers = (config.sshConcurrency ?? DEFAULT_SSH_CONCURRENCY) + 2;
  const consumers: ConsumerHandle[] = Array.from(
    { length: pollers },
    () =>
      options.createConsumer?.({ handle, logger, metrics }) ??
      createSqsConsumer({ client: sqs as SQSClient, queueUrl: config.queueUrl, handle, logger, metrics, maxMessages: 1 }),
  );
  const heartbeat = createHeartbeat({
    metrics,
    clock,
    healthcheckWriter: options.healthcheckWriter ?? createFsHealthcheckWriter(),
    healthcheckPath: config.healthcheckPath,
    logger,
    ...(options.healthcheckIntervalMs === undefined ? {} : { intervalMs: options.healthcheckIntervalMs }),
  });

  let stopping: Promise<void> | undefined;
  return {
    config,
    handle,
    async start() {
      heartbeat.start();
      await Promise.all(consumers.map((c) => c.start()));
      logger.info("executor started");
    },
    stop() {
      stopping ??= (async () => {
        logger.info("executor stopping");
        await Promise.all(consumers.map((c) => c.stop())); // no new work; waits (bounded) for in-flight handlers
        await pending.idle(); // best-effort background writes still running
        heartbeat.stop();
        await logSink.flush?.();
      })();
      return stopping;
    },
  };
}

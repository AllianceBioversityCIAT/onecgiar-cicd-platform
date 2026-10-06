// @akili-spec changes/cicd-executor-poc design §3.3, §4.2, §6.2, §7 (all module rows), §12, DD-14, DD-16, DD-19, DD-23, DD-25; requirements FR-04, FR-05, FR-14, FR-15, FR-21, NFR-03, NFR-04
// Composition root (N-17b): wires ports to adapters and services, in the
// order of design §4.2. Pure wiring: every business rule lives in the module
// it names. Order matters:
//   1. configuration (fail fast, all problems at once);
//   2. `validateForStartup` over EVERY bundled deployment definition: an
//      invalid set prevents startup (design §6.2, DD-23). Definitions are
//      served to the core ONLY from that validated result (`StartupCatalog`);
//   3. adapters and services, the consumer last (nothing is read from the
//      queue before everything it can reach is wired).
// AWS credentials come from the SDK standard chain (DD-16; OD-Q12 open): no
// credential is configured or read here. Application secrets are never read
// (NFR-01).
import { SQSClient } from "@aws-sdk/client-sqs";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BundledDefinitionSource } from "../adapters/bundled-definition-source/index.js";
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
import { createDeployCoordinator, DEFAULT_SSH_CONCURRENCY, Semaphore } from "../application/deploy-coordinator/index.js";
import { DeployWindowService, TargetResolutionService } from "../application/deploy-window-service/index.js";
import { validateForStartup, UnresolvedReferenceError } from "../application/definition-service/index.js";
import { createExecutionService } from "../application/execution-service/index.js";
import { createMessageValidators, routeMessage } from "../application/message-router/index.js";
import { createNotificationService } from "../application/notification-service/index.js";
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
import type { DefinitionSource } from "../ports/definition-source.js";
import type { DeployTransport } from "../ports/deploy-transport.js";
import type { NotificationProvider } from "../ports/notification-provider.js";
import type { QueuePublisher } from "../ports/queue-publisher.js";
import type { SecretProvider } from "../ports/secret-provider.js";
import { createStartupCatalog } from "../composition/catalog.js";
import {
  createExecutionLookup,
  createLockOwnerLookup,
  createResolutionAuditWriter,
  createTargetOrderingPort,
  createTargetResolver,
  createUnresolvedStore,
} from "../composition/adapters.js";
import { loadConfig, type ExecutorConfig } from "../composition/config.js";
import { createMessageHandlers, withNotifications } from "../composition/handlers.js";
import { createLifecycleNotifier } from "../composition/lifecycle-notifier.js";
import { createPendingTasks } from "../composition/pending-tasks.js";
import { createPlanResolver, verifyPlansAtStartup } from "../composition/plan-resolver.js";

/** A `DefinitionSource` that can also enumerate the deployment ids it bundles (a property of the adapter, not of the port). */
export type EnumerableDefinitionSource = DefinitionSource & { listDeploymentIds(): Promise<readonly string[]> };

/** The queue consumer seam: production is `createSqsConsumer`; the composition test substitutes an in-memory queue. */
export interface ConsumerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Callbacks the composition hands to whichever transport it builds. */
export interface TransportHooks {
  /** FR-12: persist the sha256 of the script that was actually delivered on the execution (best effort; awaited via the pending tracker). */
  readonly onScriptDelivered: (info: { executionId: string; sha256: string; definitionRef: string }) => void;
}

export interface BootstrapOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Resolves the Executor's OWN operational refs (DD-23). Required: the Secrets Manager adapter is wired by the entry point. */
  readonly secrets: SecretProvider;
  readonly clock?: Clock;
  readonly logSink?: LogSink & { flush?(): Promise<void> | void };
  readonly metricsSink?: MetricsSink;
  readonly healthcheckWriter?: HealthcheckWriter;
  readonly definitions?: EnumerableDefinitionSource;
  readonly documentClient?: DynamoDBDocumentClient;
  /** Replaces the SSH transport (the composition test uses a fake). It receives the checksum hook the real transport is given (FR-12). */
  readonly createTransport?: (hooks: TransportHooks) => DeployTransport;
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
  readonly deploymentIds: readonly string[];
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

  // 2. Startup validation over ALL bundled definitions (design §6.2). Any failure prevents startup.
  const definitions: EnumerableDefinitionSource =
    options.definitions ?? new BundledDefinitionSource({ env: { ...options.env, ...(config.definitionsRoot === undefined ? {} : { CICD_DEFINITIONS_ROOT: config.definitionsRoot }) } });
  const deploymentIds = await definitions.listDeploymentIds();
  if (deploymentIds.length === 0) throw new Error("refusing to start: no deployment definitions were found (design §6.2)");
  const startup = await validateForStartup({ definitionSource: definitions, secretProvider: secrets, principalRefs: config.principalRefs }, deploymentIds);
  for (const ref of [config.platformSlack.channelRef, config.platformSlack.tokenRef]) {
    if (!(await secrets.exists(ref))) throw new UnresolvedReferenceError(ref);
  }
  const catalog = createStartupCatalog(startup);
  await verifyPlansAtStartup({ catalog, secrets });

  // 3. Adapters over the single table (design §5.1).
  const client = options.documentClient ?? createDocumentClient({ tableName: config.tableName, region: config.region, ...(config.dynamoEndpoint === undefined ? {} : { endpoint: config.dynamoEndpoint }) });
  const table = config.tableName;
  const executions = new ExecutionRepository(client, table);
  const targets = new TargetStateRepository(client, table);
  const locks = new LockRepository(client, table);
  const windowsRepo = new DeployWindowRepository(client, table);
  const stateStore = new DynamoDbStateStore(client, table);
  const transactions = new DeployTransactions(client, executions, targets);

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
    catalog,
    platformSlack: config.platformSlack,
    logsUrlTemplate: config.logsUrlTemplate,
    runbookUrl: config.runbookUrl,
    metrics,
    logger,
    pending,
  });

  // 4. Services.
  const windows = new DeployWindowService({ windows: windowsRepo, targets: catalog, clock });
  const hooks: TransportHooks = {
    onScriptDelivered: (info) => {
      pending.track(
        executions.setAuditOnce(info.executionId, "scriptChecksum", info.sha256).catch((error: unknown) => {
          logger.error("could not persist the delivered-script checksum", {
            executionId: info.executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    },
  };
  const transport =
    options.createTransport?.(hooks) ??
    new Ssh2DeployTransport({ secrets, definitions, targets: createTargetResolver(catalog), logger, onScriptDelivered: hooks.onScriptDelivered });
  const rawCoordinator = createDeployCoordinator({
    executions,
    transactions,
    locks,
    target: targets,
    windows,
    plans: createPlanResolver({ catalog, secrets }),
    transport,
    queue: publisher,
    clock,
    semaphore: new Semaphore(config.sshConcurrency),
    onCleanupError: (error, resource) => logger.warn("coordinator cleanup failed", { resource, error: error instanceof Error ? error.message : String(error) }),
  });
  const coordinator = withNotifications(rawCoordinator, notifier, pending);
  const executionService = createExecutionService({
    catalog,
    dedupe: new DedupeRepository(client, table),
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

  // 5. Router: sender authorization (DD-25) over the validated startup result, handlers bound to the services.
  const validators = await createMessageValidators(definitions);
  const authorizer = createSenderAuthorizer({ allowedSenders: startup.resolvedAllowedSenders, principals: startup.resolvedPrincipals, metrics });
  const handlers = createMessageHandlers({ executionService, coordinator, reconciler, windows, resolution, notifier, metrics, logger, pending });
  const routerDeps = { validators, authorizer, sources: catalog, handlers };

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
  // NFR-04: one long deploy (up to the definition timeout) occupies a poller for its whole run, because the consumer awaits its
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
    deploymentIds,
    handle,
    async start() {
      heartbeat.start();
      await Promise.all(consumers.map((c) => c.start()));
      logger.info("executor started", { deployments: deploymentIds.length });
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

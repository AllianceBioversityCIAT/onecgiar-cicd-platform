// @akili-spec changes/cicd-executor-poc design §3.3, §4.2, §7 (main), DD-16, DD-23, DD-25; requirements FR-21, NFR-03
// Executor configuration read from the environment (N-17b). Only LOGICAL
// references and non-sensitive settings live here (DD-23): the principal refs
// are `<PLACEHOLDER>` names resolved through the SecretProvider at startup,
// never role IDs. AWS credentials are NOT configuration (DD-16: the SDK
// standard chain; OD-Q12 stays open). Every problem is collected and reported
// at once so a misconfigured deployment fails fast with ONE clear message.
import { secretIdPrefixProblem } from "../adapters/secrets-manager-provider/index.js";
import type { CiRepositoryBindingRef, PlatformPrincipalRefs } from "../application/platform-config/index.js";

export class ConfigError extends Error {
  public readonly problems: readonly string[];
  public constructor(problems: readonly string[]) {
    super(`invalid Executor configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface ExecutorConfig {
  readonly tableName: string;
  /** Target Registry table (AC-02 V1, design §5.3); read with GetItem only. */
  readonly registryTableName: string;
  readonly queueUrl: string;
  readonly region: string;
  /** Non-AWS endpoint override (DynamoDB Local / emulators); absent in AWS. */
  readonly dynamoEndpoint?: string;
  /** Root holding the bundled `schemas/` (AC-02 V1, R-6: the only content the Executor reads from it; the variable keeps its name until R-9). */
  readonly definitionsRoot?: string;
  readonly principalRefs: PlatformPrincipalRefs;
  /** Platform channel and token (logical refs) for REJECTED notifications (design §6.6). */
  readonly platformSlack: { readonly channelRef: string; readonly tokenRef: string };
  /** Template with `{executionId}`; always supplied to notifications. */
  readonly logsUrlTemplate: string;
  readonly runbookUrl: string;
  readonly healthcheckPath: string;
  readonly sshConcurrency?: number;
  /** `CICD_NOTIFICATIONS_DISABLED=true`: external notifications (Slack) are logged as suppressed instead of sent. */
  readonly notificationsDisabled: boolean;
  /** Prefix prepended to the logical name to form the Secrets Manager secret id; empty by default. */
  readonly secretIdPrefix: string;
}

const LOGICAL_REF = /^<[A-Z][A-Z0-9_]*>$/;
const REPOSITORY_ID = /^[0-9]{1,20}$/;

/**
 * Multi-repository CI (owner decision D2): optional `CICD_CI_REPOSITORY_BINDINGS`, a comma-separated list of
 * `<GitHub repository_id>=<LOGICAL_REF>`; each reference resolves at startup to the ID of the CI role that only
 * that repository can assume. Absent or empty means none (the shared CI role alone, as before).
 */
function parseCiRepositoryBindings(raw: string | undefined, problems: string[]): CiRepositoryBindingRef[] {
  const name = "CICD_CI_REPOSITORY_BINDINGS";
  if (raw === undefined || raw.trim() === "") return [];
  const bindings: CiRepositoryBindingRef[] = [];
  const repositories = new Set<string>();
  const refs = new Set<string>();
  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    const repositoryId = separator < 0 ? "" : entry.slice(0, separator).trim();
    const principalRef = separator < 0 ? "" : entry.slice(separator + 1).trim();
    if (!REPOSITORY_ID.test(repositoryId) || !LOGICAL_REF.test(principalRef)) {
      problems.push(`${name} entries must be <repositoryId>=<LOGICAL_REF> with a numeric repository_id and a logical reference (DD-23)`);
      return [];
    }
    if (repositories.has(repositoryId) || refs.has(principalRef)) {
      problems.push(`${name} must not repeat a repository_id or a reference`);
      return [];
    }
    repositories.add(repositoryId);
    refs.add(principalRef);
    bindings.push({ repositoryId, principalRef });
  }
  return bindings;
}

export function loadConfig(env: NodeJS.ProcessEnv): ExecutorConfig {
  const problems: string[] = [];
  const value = (name: string): string => {
    const v = env[name]?.trim();
    if (v === undefined || v === "") {
      problems.push(`${name} is required`);
      return "";
    }
    return v;
  };
  const ref = (name: string): string => {
    const v = value(name);
    if (v !== "" && !LOGICAL_REF.test(v)) problems.push(`${name} must be a logical <PLACEHOLDER> reference (DD-23)`);
    return v;
  };

  const tableName = value("CICD_TABLE_NAME");
  const registryTableName = value("CICD_REGISTRY_TABLE_NAME");
  const queueUrl = value("CICD_QUEUE_URL");
  const region = value("AWS_REGION");
  const principalRefs: PlatformPrincipalRefs = {
    ciPrincipalRef: ref("CICD_CI_PRINCIPAL_REF"),
    executorPrincipalRef: ref("CICD_EXECUTOR_PRINCIPAL_REF"),
    schedulerPrincipalRef: ref("CICD_SCHEDULER_PRINCIPAL_REF"),
    operatorPrincipalRef: ref("CICD_OPERATOR_PRINCIPAL_REF"),
    ciRepositoryBindingRefs: parseCiRepositoryBindings(env["CICD_CI_REPOSITORY_BINDINGS"], problems),
  };
  const sharedCiRef = principalRefs.ciPrincipalRef;
  if (principalRefs.ciRepositoryBindingRefs?.some((b) => b.principalRef === sharedCiRef)) {
    problems.push("CICD_CI_REPOSITORY_BINDINGS must not reuse the shared CI role reference CICD_CI_PRINCIPAL_REF");
  }
  const platformSlack = { channelRef: ref("CICD_PLATFORM_SLACK_CHANNEL_REF"), tokenRef: ref("CICD_PLATFORM_SLACK_TOKEN_REF") };
  const logsUrlTemplate = value("CICD_LOGS_URL_TEMPLATE");
  if (logsUrlTemplate !== "" && !logsUrlTemplate.includes("{executionId}")) {
    problems.push("CICD_LOGS_URL_TEMPLATE must contain the {executionId} placeholder");
  }
  const runbookUrl = value("CICD_RUNBOOK_URL");
  const healthcheckPath = env["CICD_HEALTHCHECK_PATH"]?.trim() || "/tmp/cicd-executor.health";

  let sshConcurrency: number | undefined;
  const rawConcurrency = env["CICD_SSH_CONCURRENCY"]?.trim();
  if (rawConcurrency !== undefined && rawConcurrency !== "") {
    sshConcurrency = Number(rawConcurrency);
    if (!Number.isInteger(sshConcurrency) || sshConcurrency < 1) problems.push("CICD_SSH_CONCURRENCY must be a positive integer");
  }

  // Optional switch, exact values only: absent or empty keeps notifications on (the default), anything but
  // `true` or `false` is refused so a typo never silently disables or enables them.
  const rawNotificationsDisabled = env["CICD_NOTIFICATIONS_DISABLED"];
  const notificationsDisabled = rawNotificationsDisabled === "true";
  if (rawNotificationsDisabled !== undefined && rawNotificationsDisabled !== "" && rawNotificationsDisabled !== "true" && rawNotificationsDisabled !== "false") {
    problems.push("CICD_NOTIFICATIONS_DISABLED must be exactly true or false");
  }

  const secretIdPrefix = env["CICD_SECRET_ID_PREFIX"]?.trim() ?? "";
  const prefixProblem = secretIdPrefixProblem(secretIdPrefix);
  if (prefixProblem !== undefined) problems.push(`CICD_SECRET_ID_PREFIX ${prefixProblem}`);

  if (problems.length > 0) throw new ConfigError(problems);
  const dynamoEndpoint = env["CICD_DYNAMODB_ENDPOINT"]?.trim();
  const definitionsRoot = env["CICD_DEFINITIONS_ROOT"]?.trim();
  return {
    tableName,
    registryTableName,
    queueUrl,
    region,
    ...(dynamoEndpoint ? { dynamoEndpoint } : {}),
    ...(definitionsRoot ? { definitionsRoot } : {}),
    principalRefs,
    platformSlack,
    logsUrlTemplate,
    runbookUrl,
    healthcheckPath,
    notificationsDisabled,
    secretIdPrefix,
    ...(sshConcurrency === undefined ? {} : { sshConcurrency }),
  };
}

// @akili-spec changes/cicd-executor-poc design §5.3, §6.3, §11.2; architecture-change-02 AC2-4, V1-R2, V1-R3; requirements FR-02, FR-21; tasks R-7
// OWNER-RUN administrative tool for the runtime Target Registry `cicd-registry-<stage>`
// (AC-02 V1). It is the only writer of the registry: the Executor role can only GetItem it
// (R-2) and the CI role has no access. Registry write access is equivalent to redirecting a
// target's deploys and, with option A, to choosing which repository may deploy it (AC2-4),
// so the tool:
//   - validates the full record against schemas/target-record.schema.json (R-1) before any
//     AWS call, reporting rule and path only, never a value;
//   - enforces that `credentialRef` is a secret name under the Executor's secret id prefix,
//     the same rule the Executor's SecretProvider applies when it reads it;
//   - owns `schemaVersion`, `version`, `updatedAt` and `updatedBy` (an input that sets them
//     is refused) and writes with a condition on `version` (create: absent; update: the
//     expected version, bumped by one);
//   - runs only with an explicit administrative `--profile`, never the Executor profile,
//     never with static keys or the Executor's isolated AWS files in the environment;
//   - requires `--checklist-confirmed` for a write (the onboarding checklist, V1-R2, V1-R3,
//     the option A B2 gate).
// It never reads a secret, never connects to a target and never touches GitHub. There is no
// delete command (PITR and Retain protect the table; removing a target is an owner console
// action).
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { FormatsPluginOptions } from "ajv-formats";
import { createRequire } from "node:module";
import { credentialRefProblem } from "../../adapters/secrets-manager-provider/index.js";
import type { Clock } from "../../ports/clock.js";

// ajv and ajv-formats are CommonJS packages: see executor/test/contract/support/ajv-factory.ts.
const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

/** The Executor's AWS profile name in the Gate B runbook (05, section 3); this tool never runs with it. */
export const EXECUTOR_PROFILE = "cicd-executor";

/**
 * Environment variables that could supply credentials other than `--profile` (static keys, web identity, container
 * credentials; the SDK chain falls through to them if the profile cannot be resolved) or point at the Executor's
 * isolated AWS files. Instance metadata is disabled by the entry point (main.ts).
 */
const FORBIDDEN_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
] as const;

/** Fields the tool sets; an input record must not carry them. `pk`/`sk` are the item key. */
const TOOL_OWNED_FIELDS = ["schemaVersion", "version", "updatedAt", "updatedBy", "pk", "sk"] as const;

const TARGET_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
const PROFILE = /^[A-Za-z0-9_.+=@-]{1,128}$/;
const SORT_KEY = "META";

export const CHECKLIST = [
  "ONBOARDING CHECKLIST (confirm every item, then pass --checklist-confirmed)",
  "1. sourceRepositoryId is the numeric GitHub repository_id of the ONE repository allowed to deploy this target",
  "   (e.g. `gh api repos/<OWNER>/<REPO> --jq .id`), not its name.",
  "2. Exactly one caller workflow in that repository deploys this target (single-source rule, V1-R2).",
  "3. The deployScript is installed at exactly that path on the target; the script, its parent directories and every",
  "   file it sources or reads as configuration are owned by an administrator and not writable by the deploy user",
  "   (V1-R3). If the deploy user can run docker directly, it is root-equivalent and this restriction is moot.",
  "4. The script implements the design §6.5 interface (--target-id, --execution-id, --fencing-token, --commit-sha,",
  "   --artifact unit=sha256:<digest>) including the target-side mutex, derived from the reference script.",
  "5. The host key lines were obtained out of band and compared with ssh-keyscan (runbook 06).",
  "6. The credentialRef secret exists under the Executor's secret prefix and holds only the deploy user's private key.",
  "7. Backward compatibility of migrations with the version in service is the application team's responsibility (FR-13).",
  "8. Option A gate: a second repository is NOT added to the CI role trust until the B2 positive and negative tests of",
  "   P-R1/P-R2 pass, including the real SQS SenderId suffix (P-A4).",
  "9. This tool runs with the administrative profile only: never the Executor profile, never the CI role.",
];

export const USAGE = [
  "Usage:",
  "  tools/target-registry put --file <record.json> --updated-by <who> --secret-id-prefix <PREFIX>",
  "                            --registry-table <TABLE> --region <REGION> --profile <ADMIN_PROFILE>",
  "                            [--expected-version <N>] --checklist-confirmed",
  "  tools/target-registry put --file <record.json> --updated-by <who> --secret-id-prefix <PREFIX> [--expected-version <N>] --dry-run",
  "  tools/target-registry get --target-id <TARGET_ID> --registry-table <TABLE> --region <REGION> --profile <ADMIN_PROFILE>",
  "  tools/target-registry checklist",
  "",
  "  <record.json> holds targetId, project, environment, host, port (optional), user, hostKey, credentialRef,",
  "  deployScript, deployWindowPolicy and sourceRepositoryId. The tool sets schemaVersion, version, updatedAt",
  "  and updatedBy. Without --expected-version the target must not exist yet; with it, the stored version must",
  "  equal <N> and becomes <N+1>. Exit codes: 0 done, 1 refused (record, condition, AWS), 2 usage error.",
].join("\n");

/** Minimal document-client surface (the real DynamoDBDocumentClient satisfies it). */
export interface RegistryDocumentClient {
  send(command: PutCommand | GetCommand): Promise<unknown>;
}

export type RegistryClientFactory = (config: { readonly region: string; readonly profile: string }) => RegistryDocumentClient;

export interface TargetRegistryToolDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly clock: Clock;
  /** Parsed schemas/target-record.schema.json. */
  readonly schema: object;
  readonly readFile: (path: string) => Promise<string>;
  readonly createClient: RegistryClientFactory;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

class UsageError extends Error {}
class RefusedError extends Error {}

const VALUED = new Set(["file", "updated-by", "secret-id-prefix", "registry-table", "region", "profile", "expected-version", "target-id"]);
const BOOLEAN = new Set(["dry-run", "checklist-confirmed"]);
const ALLOWED: Record<string, readonly string[]> = {
  put: ["file", "updated-by", "secret-id-prefix", "registry-table", "region", "profile", "expected-version", "dry-run", "checklist-confirmed"],
  get: ["target-id", "registry-table", "region", "profile"],
  checklist: [],
};

function parse(argv: readonly string[]): { command: string; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  if (command === undefined || !(command in ALLOWED)) throw new UsageError(`unknown or missing command: ${String(command ?? "")}`);
  const allowed = ALLOWED[command] as readonly string[];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    const name = token.startsWith("--") ? token.slice(2) : "";
    if (!allowed.includes(name)) throw new UsageError(`unknown argument for ${command}: ${token}`);
    if (flags.has(name)) throw new UsageError(`--${name} given twice`);
    if (BOOLEAN.has(name)) {
      flags.set(name, "true");
      continue;
    }
    if (!VALUED.has(name)) throw new UsageError(`unknown argument: ${token}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
    i += 1;
  }
  return { command, flags };
}

function required(flags: Map<string, string>, name: string, pattern?: RegExp): string {
  const value = flags.get(name)?.trim() ?? "";
  if (value === "") throw new UsageError(`--${name} is required`);
  if (pattern !== undefined && !pattern.test(value)) throw new UsageError(`--${name} has an invalid value`);
  return value;
}

/** The administrative identity: an explicit profile, never the Executor's, with nothing in the environment overriding it. */
function adminProfile(flags: Map<string, string>, env: NodeJS.ProcessEnv): string {
  for (const name of FORBIDDEN_ENV) {
    if ((env[name] ?? "").trim() !== "") {
      throw new UsageError(`refusing to run: ${name} is set; unset it (it could supply credentials other than --profile, or point at the Executor's isolated AWS files)`);
    }
  }
  if ((env["AWS_PROFILE"] ?? "").trim() === EXECUTOR_PROFILE) throw new UsageError(`refusing to run: AWS_PROFILE is the Executor profile (${EXECUTOR_PROFILE})`);
  const profile = required(flags, "profile", PROFILE);
  if (profile === EXECUTOR_PROFILE) throw new UsageError(`refusing to run: --profile is the Executor profile (${EXECUTOR_PROFILE}); use the administrative profile`);
  return profile;
}

function describeErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((e) => {
    const params = e.params as { additionalProperty?: string; missingProperty?: string };
    const property = params.additionalProperty ?? params.missingProperty ?? "";
    return `${e.instancePath || "(root)"} ${e.keyword}${property ? ` ${property}` : ""}`;
  });
}

function awsName(error: unknown): string {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return typeof name === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(name) ? name : "UnknownError";
}

async function buildRecord(flags: Map<string, string>, deps: TargetRegistryToolDeps): Promise<{ record: Record<string, unknown>; expected?: number }> {
  const file = required(flags, "file");
  const updatedBy = required(flags, "updated-by");
  const prefix = required(flags, "secret-id-prefix");
  const rawExpected = flags.get("expected-version");
  let expected: number | undefined;
  if (rawExpected !== undefined) {
    if (!/^[1-9][0-9]{0,8}$/.test(rawExpected)) throw new UsageError("--expected-version must be a positive integer");
    expected = Number(rawExpected);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await deps.readFile(file));
  } catch {
    throw new RefusedError(`cannot read ${file} as JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new RefusedError(`${file} must hold one JSON object`);
  const owned = TOOL_OWNED_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(parsed, field));
  if (owned.length > 0) throw new RefusedError(`the record must not set ${owned.join(", ")}: the tool sets them`);

  const record: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
    schemaVersion: 1,
    version: expected === undefined ? 1 : expected + 1,
    updatedAt: deps.clock.now().toISOString(),
    updatedBy,
  };
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(deps.schema);
  if (!validate(record)) throw new RefusedError(`invalid target record: ${describeErrors(validate).join("; ")}`);
  const problem = credentialRefProblem(prefix, String(record.credentialRef));
  if (problem !== undefined) throw new RefusedError(`invalid target record: credentialRef ${problem}`);
  return expected === undefined ? { record } : { record, expected };
}

async function put(flags: Map<string, string>, deps: TargetRegistryToolDeps): Promise<number> {
  const dryRun = flags.has("dry-run");
  if (!dryRun) {
    // Identity and confirmation are checked before the record file is even read.
    adminProfile(flags, deps.env);
    if (!flags.has("checklist-confirmed")) {
      CHECKLIST.forEach((line) => deps.err(line));
      throw new UsageError("a write requires --checklist-confirmed after you have confirmed every checklist item");
    }
  }
  const { record, expected } = await buildRecord(flags, deps);
  if (dryRun) {
    deps.out(JSON.stringify(record, null, 2));
    CHECKLIST.forEach((line) => deps.out(line));
    deps.out(`dry run: ${expected === undefined ? "would create" : `would update from version ${String(expected)}`} ${String(record.targetId)}; nothing was written`);
    return 0;
  }
  const table = required(flags, "registry-table", TABLE_NAME);
  const region = required(flags, "region", REGION);
  const client = deps.createClient({ region, profile: adminProfile(flags, deps.env) });
  const targetId = String(record.targetId);
  const condition =
    expected === undefined
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expected } };
  try {
    await client.send(new PutCommand({ TableName: table, Item: { pk: `TARGET#${targetId}`, sk: SORT_KEY, ...record }, ...condition }));
  } catch (error) {
    if (awsName(error) === "ConditionalCheckFailedException") {
      throw new RefusedError(
        expected === undefined
          ? `target ${targetId} already exists; read its version with \`get\` and pass --expected-version`
          : `target ${targetId} does not exist or its version is not ${String(expected)}; nothing was written`,
      );
    }
    throw new RefusedError(`write failed: ${awsName(error)}`);
  }
  deps.out(`${expected === undefined ? "created" : "updated"} ${targetId} at version ${String(record.version)}`);
  return 0;
}

async function get(flags: Map<string, string>, deps: TargetRegistryToolDeps): Promise<number> {
  const targetId = required(flags, "target-id", TARGET_ID);
  const table = required(flags, "registry-table", TABLE_NAME);
  const region = required(flags, "region", REGION);
  const client = deps.createClient({ region, profile: adminProfile(flags, deps.env) });
  let output: { Item?: Record<string, unknown> };
  try {
    output = (await client.send(new GetCommand({ TableName: table, Key: { pk: `TARGET#${targetId}`, sk: SORT_KEY }, ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  } catch (error) {
    throw new RefusedError(`read failed: ${awsName(error)}`);
  }
  if (output.Item === undefined) throw new RefusedError(`target ${targetId} does not exist`);
  const attributes = Object.fromEntries(Object.entries(output.Item).filter(([name]) => name !== "pk" && name !== "sk"));
  deps.out(JSON.stringify(attributes, null, 2));
  return 0;
}

export async function runTargetRegistryTool(argv: readonly string[], deps: TargetRegistryToolDeps): Promise<number> {
  try {
    const { command, flags } = parse(argv);
    if (command === "checklist") {
      CHECKLIST.forEach((line) => deps.out(line));
      return 0;
    }
    return command === "put" ? await put(flags, deps) : await get(flags, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`target-registry: ${error.message}`);
      deps.err(USAGE);
      return 2;
    }
    if (error instanceof RefusedError) {
      deps.err(`target-registry: ${error.message}`);
      return 1;
    }
    deps.err(`target-registry: unexpected failure: ${awsName(error)}`);
    return 1;
  }
}

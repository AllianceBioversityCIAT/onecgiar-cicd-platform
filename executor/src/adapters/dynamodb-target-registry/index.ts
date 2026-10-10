// @akili-spec changes/cicd-executor-poc design §5.3, §6.3, §11.2; requirements FR-02; tasks R-3
// DynamoDB adapter of the TargetRegistry port (AC-02 V1): one GetItem on
// `TARGET#{targetId}` / `META` of `cicd-registry-<stage>`, then validation of the
// stored record against schemas/target-record.schema.json (R-1). Read-only by
// construction: the only DynamoDB command used here is GetCommand, matching the
// Executor role's `dynamodb:GetItem`-only permission (R-2). Nothing is logged here;
// a DynamoDB failure is thrown unchanged, never reported as a missing or invalid target.
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { FormatsPluginOptions } from "ajv-formats";
import { createRequire } from "node:module";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AgentBinding, TargetLookup, TargetRecord, TargetRegistry } from "../../ports/target-registry.js";

// ajv and ajv-formats are CommonJS packages: see
// executor/test/contract/support/ajv-factory.ts for the NodeNext interop note.
const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

const SORT_KEY = "META";
const targetPartitionKey = (targetId: string): string => `TARGET#${targetId}`;
const agentPartitionKey = (agentId: string): string => `AGENT#${agentId}`;

export interface DynamoDbTargetRegistryOptions {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  /** Parsed schemas/target-record.schema.json; compiled once here. */
  readonly schema: object;
  /**
   * architecture-change-04: parsed schemas/agent-record.schema.json. Without it the agent transport is disabled and
   * every sqs-agent target is TARGET_INVALID (safe mode: no agent results queue, nothing to dispatch to).
   */
  readonly agentSchema?: object;
}

/** `<instancePath> <keyword>[ <property>]` per violated rule: names the rule and the path, never the stored value. */
function describeErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((e) => {
    const params = e.params as { additionalProperty?: string; missingProperty?: string };
    const property = params.additionalProperty ?? params.missingProperty ?? "";
    return `${e.instancePath || "(root)"} ${e.keyword}${property ? ` ${property}` : ""}`;
  });
}

export class DynamoDbTargetRegistry implements TargetRegistry {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #validate: ValidateFunction;
  readonly #validateAgent: ValidateFunction | undefined;

  public constructor(options: DynamoDbTargetRegistryOptions) {
    this.#client = options.client;
    this.#tableName = options.tableName;
    const ajv = new Ajv2020Ctor({ allErrors: true, strict: true });
    addFormats(ajv);
    this.#validate = ajv.compile(options.schema);
    this.#validateAgent = options.agentSchema === undefined ? undefined : ajv.compile(options.agentSchema);
  }

  /** architecture-change-04 §5: AGENT#{agentId} must exist, be schema-valid and list the target; otherwise the target is invalid. */
  async #agentFor(agentId: string, targetId: string): Promise<{ readonly agent: AgentBinding } | { readonly problem: string }> {
    if (this.#validateAgent === undefined) return { problem: "/transport sqs-agent is not enabled in this Executor (no agent configuration)" };
    const partitionKey = agentPartitionKey(agentId);
    const output = await this.#client.send(
      new GetCommand({ TableName: this.#tableName, Key: { pk: partitionKey, sk: SORT_KEY }, ConsistentRead: true }),
    );
    if (output.Item === undefined) return { problem: "/agentId names no agent record" };
    const { pk, sk, ...agent } = structuredClone(output.Item) as Record<string, unknown>;
    if (pk !== partitionKey || sk !== SORT_KEY) return { problem: "(agent key) pk/sk do not match" };
    if (!this.#validateAgent(agent)) return { problem: `agent record invalid: ${describeErrors(this.#validateAgent).join("; ")}` };
    if (agent.agentId !== agentId) return { problem: "/agentId does not match the agent record key" };
    if (!(agent.targets as readonly string[]).includes(targetId)) return { problem: "/agentId does not serve this target (agent record targets)" };
    return {
      agent: {
        agentId,
        roleId: agent.roleId as string,
        commandQueueUrl: agent.commandQueueUrl as string,
        minAgentVersion: agent.minAgentVersion as string,
      },
    };
  }

  /** architecture-change-04: the role id of a valid AGENT#{agentId} (agent heartbeats); undefined otherwise. */
  public async agentRoleId(agentId: string): Promise<string | undefined> {
    if (this.#validateAgent === undefined) return undefined;
    const partitionKey = agentPartitionKey(agentId);
    const output = await this.#client.send(
      new GetCommand({ TableName: this.#tableName, Key: { pk: partitionKey, sk: SORT_KEY }, ConsistentRead: true }),
    );
    if (output.Item === undefined) return undefined;
    const { pk, sk, ...agent } = structuredClone(output.Item) as Record<string, unknown>;
    if (pk !== partitionKey || sk !== SORT_KEY) return undefined;
    return this.#validateAgent(agent) && agent.agentId === agentId ? (agent.roleId as string) : undefined;
  }

  public async getTarget(targetId: string): Promise<TargetLookup> {
    const partitionKey = targetPartitionKey(targetId);
    const output = await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: partitionKey, sk: SORT_KEY },
        ConsistentRead: true,
      }),
    );
    const item = output.Item;
    if (item === undefined) return { kind: "missing" };

    // Work on a deep copy so the caller can never alias the SDK's object.
    const { pk, sk, ...attributes } = structuredClone(item) as Record<string, unknown>;
    if (pk !== partitionKey || sk !== SORT_KEY) return { kind: "invalid", problems: ["(key) pk/sk do not match the requested target"] };
    if (!this.#validate(attributes)) return { kind: "invalid", problems: describeErrors(this.#validate) };
    if (attributes.targetId !== targetId) return { kind: "invalid", problems: ["/targetId does not match the item key"] };
    // architecture-change-04: an sqs-agent target needs a valid agent that serves it; otherwise it is TARGET_INVALID
    // (fail closed: never handed to the SSH path, never dispatched).
    if (attributes.transport === "sqs-agent") {
      const resolved = await this.#agentFor(String(attributes.agentId), targetId);
      if ("problem" in resolved) return { kind: "invalid", problems: [resolved.problem] };
      return { kind: "found", target: { ...attributes, agent: resolved.agent } as unknown as TargetRecord };
    }
    return { kind: "found", target: attributes as unknown as TargetRecord };
  }
}

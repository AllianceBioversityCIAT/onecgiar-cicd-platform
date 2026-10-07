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
import type { TargetLookup, TargetRecord, TargetRegistry } from "../../ports/target-registry.js";

// ajv and ajv-formats are CommonJS packages: see
// executor/test/contract/support/ajv-factory.ts for the NodeNext interop note.
const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

const SORT_KEY = "META";
const targetPartitionKey = (targetId: string): string => `TARGET#${targetId}`;

export interface DynamoDbTargetRegistryOptions {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  /** Parsed schemas/target-record.schema.json; compiled once here. */
  readonly schema: object;
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

  public constructor(options: DynamoDbTargetRegistryOptions) {
    this.#client = options.client;
    this.#tableName = options.tableName;
    const ajv = new Ajv2020Ctor({ allErrors: true, strict: true });
    addFormats(ajv);
    this.#validate = ajv.compile(options.schema);
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
    return { kind: "found", target: attributes as unknown as TargetRecord };
  }
}

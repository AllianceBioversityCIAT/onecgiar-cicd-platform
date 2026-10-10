// @akili-spec changes/cicd-executor-poc architecture-change-04 §6
// Compiles the four agent message schemas (bundled `schemas/`) into the AgentContractValidators port. Same Ajv
// options as the registry adapter (strict). Problems name the rule and the path, never a value.
import type { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { FormatsPluginOptions } from "ajv-formats";
import { createRequire } from "node:module";
import type { SchemaSource } from "../../ports/schema-source.js";
import type { AgentContractValidators } from "./index.js";

const require = createRequire(import.meta.url);
const Ajv2020Ctor: new (opts?: object) => Ajv2020 = require("ajv/dist/2020.js").Ajv2020;
const addFormats: (ajv: Ajv2020, opts?: FormatsPluginOptions) => void = require("ajv-formats");

function problemsOf(validate: ValidateFunction, body: unknown): readonly string[] | undefined {
  if (validate(body)) return undefined;
  return (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.keyword}`);
}

export async function createAgentContractValidators(schemas: SchemaSource): Promise<AgentContractValidators> {
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: true });
  addFormats(ajv);
  const compile = async (name: string): Promise<ValidateFunction> => ajv.compile(JSON.parse((await schemas.getSchema(name)).content) as object);
  const command = await compile("agent-command.schema.json");
  const query = await compile("agent-query.schema.json");
  const event = await compile("agent-event.schema.json");
  const heartbeat = await compile("agent-heartbeat.schema.json");
  return {
    command: (body) => problemsOf(command, body),
    query: (body) => problemsOf(query, body),
    event: (body) => problemsOf(event, body),
    heartbeat: (body) => problemsOf(heartbeat, body),
  };
}

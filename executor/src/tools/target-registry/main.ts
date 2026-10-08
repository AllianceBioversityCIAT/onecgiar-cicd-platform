// @akili-spec changes/cicd-executor-poc design §5.3, §11.2; architecture-change-02 AC2-4; tasks R-7
// Process entry point of the owner-run Target Registry tool (launcher: tools/target-registry).
// The DynamoDB client is built only for a real read or write, with the administrative
// `--profile` and the region given on the command line; the schema is the bundled
// schemas/target-record.schema.json.
import { readFile } from "node:fs/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BundledSchemaSource } from "../../adapters/bundled-schema-source/index.js";
import { runTargetRegistryTool } from "./index.js";

// No fallback to instance metadata credentials if the administrative profile cannot be resolved.
process.env["AWS_EC2_METADATA_DISABLED"] = "true";

const schema = JSON.parse((await new BundledSchemaSource().getSchema("target-record.schema.json")).content) as object;

const code = await runTargetRegistryTool(process.argv.slice(2), {
  env: process.env,
  clock: { now: () => new Date() },
  schema,
  readFile: (path) => readFile(path, "utf8"),
  createClient: ({ region, profile }) => DynamoDBDocumentClient.from(new DynamoDBClient({ region, profile })),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
process.exitCode = code;

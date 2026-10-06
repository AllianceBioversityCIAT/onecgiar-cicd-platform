// @akili-spec changes/cicd-executor-poc design DD-24, DD-25, §5.1 (Gate B, B0)
// Parses a CloudFormation/SAM YAML template without any AWS tooling: the short-form
// intrinsic tags (!Ref, !Sub, !GetAtt, ...) are resolved to their long-form JSON shape
// (`{ Ref: ... }`, `{ "Fn::Sub": ... }`), so tests assert on plain objects.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { CollectionTag, ScalarTag } from "yaml";
import { repoRoot } from "./schema-paths.js";

export const samTemplatePath = path.join(repoRoot, "infra", "sam", "template.yaml");
export const samParametersExamplePath = path.join(repoRoot, "infra", "sam", "parameters.example.json");
export const samConfigExamplePath = path.join(repoRoot, "infra", "sam", "samconfig.example.toml");

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface CfnTemplate {
  Parameters: Record<string, { AllowedPattern?: string; AllowedValues?: string[]; Default?: string }>;
  Rules?: Record<string, Json>;
  Conditions: Record<string, Json>;
  Resources: Record<string, CfnResource>;
  Outputs: Record<string, { Description?: string; Value: Json }>;
  [key: string]: unknown;
}
export interface CfnResource {
  Type: string;
  Condition?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties: Record<string, Json>;
}

/** Tags whose scalar and sequence forms both map to `{ "Fn::<Name>": value }`. */
const FN_TAGS = [
  "Sub", "If", "Equals", "Not", "And", "Or", "Join", "Select", "Split", "FindInMap",
  "ImportValue", "Base64", "GetAZs", "Cidr",
] as const;

const scalar = (tag: string, wrap: (s: string) => Json): ScalarTag => ({
  tag,
  resolve: (str: string) => wrap(str) as unknown as string,
});
const seq = (tag: string, wrap: (items: Json[]) => Json): CollectionTag => ({
  tag,
  collection: "seq",
  // The resolved sequence is kept as a YAMLSeq node and flattened by `toJS` below.
  resolve: (node: unknown) => {
    const items = (node as { toJSON(): Json[] }).toJSON();
    return wrap(items) as never;
  },
});

const customTags = [
  scalar("!Ref", (s) => ({ Ref: s })),
  scalar("!Condition", (s) => ({ Condition: s })),
  // `!GetAtt A.B` -> { "Fn::GetAtt": ["A", "B"] } (the attribute may itself contain dots).
  scalar("!GetAtt", (s) => ({ "Fn::GetAtt": [s.slice(0, s.indexOf(".")), s.slice(s.indexOf(".") + 1)] })),
  seq("!GetAtt", (items) => ({ "Fn::GetAtt": items })),
  ...FN_TAGS.map((name) => scalar(`!${name}`, (s) => ({ [`Fn::${name}`]: s }))),
  ...FN_TAGS.map((name) => seq(`!${name}`, (items) => ({ [`Fn::${name}`]: items }))),
  seq("!Ref", (items) => ({ Ref: items as unknown as string })),
];

export function parseCfnYaml(text: string): CfnTemplate {
  return parse(text, { customTags, schema: "core" }) as CfnTemplate;
}

export function loadSamTemplate(): CfnTemplate {
  return parseCfnYaml(readFileSync(samTemplatePath, "utf8"));
}

export function resourcesOfType(template: CfnTemplate, type: string): [string, CfnResource][] {
  return Object.entries(template.Resources).filter(([, r]) => r.Type === type);
}

export interface PolicyStatement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource?: Json;
  Principal?: Json;
  Condition?: Record<string, Record<string, Json>>;
}

export const asArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/** Identity (inline) policy statements of one `AWS::IAM::Role`. */
export function rolePolicyStatements(role: CfnResource): PolicyStatement[] {
  const policies = role.Properties.Policies as unknown as { PolicyDocument: { Statement: PolicyStatement[] } }[];
  return policies.flatMap((p) => p.PolicyDocument.Statement);
}

export function roleTrustStatements(role: CfnResource): PolicyStatement[] {
  return (role.Properties.AssumeRolePolicyDocument as unknown as { Statement: PolicyStatement[] }).Statement;
}

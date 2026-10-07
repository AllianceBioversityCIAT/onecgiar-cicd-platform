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

const isObj = (v: Json | undefined): v is { [key: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Which side of `Equals [Ref param, ""]` a condition puts the parameter on: "empty" when the
 * condition is true for an empty value, "non-empty" when it is true for a non-empty one, or
 * undefined when the condition (resolved through the Conditions section) does not test that
 * parameter against "" directly.
 */
function emptinessOfCondition(template: CfnTemplate, cond: Json | undefined, param: string): "empty" | "non-empty" | undefined {
  if (typeof cond === "string") return emptinessOfCondition(template, template.Conditions[cond], param);
  if (isObj(cond) && typeof cond.Condition === "string") return emptinessOfCondition(template, template.Conditions[cond.Condition], param);
  if (!isObj(cond)) return undefined;
  const eq = cond["Fn::Equals"];
  if (Array.isArray(eq) && eq.length === 2) {
    const [a, b] = eq;
    const isParam = isObj(a) && a.Ref === param;
    if (isParam && b === "") return "empty";
  }
  const not = cond["Fn::Not"];
  if (Array.isArray(not) && not.length === 1) {
    const inner = emptinessOfCondition(template, not[0], param);
    if (inner) return inner === "empty" ? "non-empty" : "empty";
  }
  return undefined;
}

/**
 * Finds every `{ Ref: <param> }` of a parameter whose Default is "" that is NOT guarded: a
 * guarded Ref sits in the branch of an `Fn::If` whose condition tests that same parameter for
 * "" and where the parameter is non-empty. cfn-lint (W1030) otherwise resolves the Ref to the
 * empty default and validates it against the property's format. Returns JSON-path style
 * locations of the unguarded occurrences.
 */
export function unguardedEmptyDefaultRefs(template: CfnTemplate): string[] {
  const sentinels = Object.entries(template.Parameters).filter(([, p]) => p.Default === "").map(([n]) => n);
  const offenders: string[] = [];
  const walk = (node: Json | undefined, where: string, safe: ReadonlySet<string>): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${where}[${i}]`, safe));
      return;
    }
    if (!isObj(node)) return;
    if (typeof node.Ref === "string" && sentinels.includes(node.Ref) && !safe.has(node.Ref)) {
      offenders.push(`${where}: Ref ${node.Ref}`);
    }
    const branches = node["Fn::If"];
    if (Array.isArray(branches) && branches.length === 3) {
      walk(branches[0], `${where}/Fn::If[0]`, safe);
      [1, 2].forEach((idx) => {
        const extra = new Set(safe);
        for (const param of sentinels) {
          const side = emptinessOfCondition(template, branches[0], param);
          if ((side === "non-empty" && idx === 1) || (side === "empty" && idx === 2)) extra.add(param);
        }
        walk(branches[idx], `${where}/Fn::If[${idx}]`, extra);
      });
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${where}/${k}`, safe);
  };
  for (const [id, r] of Object.entries(template.Resources)) walk(r as unknown as Json, `Resources/${id}`, new Set());
  for (const [id, o] of Object.entries(template.Outputs ?? {})) walk(o as unknown as Json, `Outputs/${id}`, new Set());
  return offenders;
}

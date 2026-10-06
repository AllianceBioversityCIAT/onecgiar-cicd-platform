// @akili-spec changes/cicd-executor-poc design §6.5, §7 (deploy-coordinator, definition-service rows), DD-19, DD-23; requirements FR-12, NFR-01
// DeployPlanResolver (N-17b): turns a validated definition + registry entry +
// the execution's immutable artifact digests into the deploy script's argument
// vector (design §6.5), one array element per argument (never a shell string).
//
// NFR-01 boundary: only IDENTIFIER references (the explicit allowlist the
// definition-service already uses) are resolved here, through the
// SecretProvider, and only through `IdentifierResolver`, which refuses
// anything else. `runtimeSecretRefs` VALUES and `containers[].envSecretRef` are
// never resolved: the runtime secret reference travels to the target as the
// opaque reference it is (OD-Q5 stays open: which reference form the target
// expects is NOT decided here).
import type { SecretProvider } from "../ports/secret-provider.js";
import type { DeployPlan, DeployPlanResolver } from "../application/deploy-coordinator/index.js";
import {
  collectDeploymentAllowlistedRefs,
  collectRegistryAllowlistedRefs,
  isLogicalRef,
} from "../application/definition-service/reference-resolution.js";
import { parseResolvedPortMapping } from "../application/definition-service/registry-rules.js";
import { assertSafeScriptArgs } from "../adapters/ssh-deployer/index.js";
import type { ExecutionItem } from "../adapters/dynamodb-state-store/types.js";
import type { StartupCatalog } from "./catalog.js";

/** Resolves ONLY references on the identifier allowlist; anything else (an envSecretRef, a runtime secret value) is refused. */
export class IdentifierResolver {
  private readonly allowed = new Set<string>();
  private readonly cache = new Map<string, string>();

  public constructor(
    private readonly secrets: SecretProvider,
    catalog: StartupCatalog,
  ) {
    const entries: Record<string, Record<string, unknown>> = {};
    for (const id of catalog.deploymentIds()) {
      const view = catalog.deployment(id);
      if (view === undefined) continue;
      collectDeploymentAllowlistedRefs(view.definition as Record<string, unknown>, this.allowed);
      entries[view.targetId] = view.target as Record<string, unknown>;
    }
    collectRegistryAllowlistedRefs(entries, this.allowed);
  }

  public async resolve(value: string): Promise<string> {
    if (!isLogicalRef(value)) return value; // already a literal identifier
    if (!this.allowed.has(value)) {
      throw new Error(`reference ${value} is not on the identifier allowlist and is never resolved by the Executor (NFR-01)`);
    }
    const cached = this.cache.get(value);
    if (cached !== undefined) return cached;
    const resolved = await this.secrets.getSecret(value);
    this.cache.set(value, resolved);
    return resolved;
  }
}

type Obj = Record<string, unknown>;
const asArray = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function createPlanResolver(deps: { readonly catalog: StartupCatalog; readonly secrets: SecretProvider }): DeployPlanResolver {
  const identifiers = new IdentifierResolver(deps.secrets, deps.catalog);

  return {
    async resolve(execution): Promise<DeployPlan> {
      const view = deps.catalog.deployment(execution.deploymentId);
      if (view === undefined) throw new Error(`no validated definition for deployment "${execution.deploymentId}"`);
      const def = view.definition as Obj;
      const args: string[] = ["--execution-id", execution.executionId, "--unit", execution.deploymentId, "--lock-key", execution.lockKey];

      const deployed = new Set<string>();
      for (const artifact of asArray(def["artifacts"])) {
        const unit = asString(artifact["unit"]);
        const digest = unit === undefined ? undefined : execution.artifacts[unit];
        if (unit === undefined || digest === undefined) {
          throw new Error(`execution ${execution.executionId} has no digest for a declared unit`);
        }
        const container = await identifiers.resolve(asString(artifact["container"]) ?? "");
        const repository = await identifiers.resolve(asString(artifact["imageRepositoryRef"]) ?? "");
        deployed.add(container);
        args.push("--artifact", `${container}=${repository}@${digest}`);
      }

      // Ports come from the registry (design §6.5), for the containers this deployment deploys.
      for (const container of asArray(view.target["containers"])) {
        const name = await identifiers.resolve(asString(container["name"]) ?? "");
        const portRef = asString(container["portRef"]);
        if (!deployed.has(name) || portRef === undefined) continue;
        const parsed = parseResolvedPortMapping(portRef, await identifiers.resolve(portRef));
        args.push("--port", `${name}=${parsed.hostPort}:${parsed.containerPort}`);
      }

      // Runtime secrets: container (identifier) = the reference, passed through UNRESOLVED (NFR-01, OD-Q5).
      for (const [containerRef, secretRef] of Object.entries((def["runtimeSecretRefs"] ?? {}) as Record<string, unknown>)) {
        const secret = asString(secretRef);
        if (secret !== undefined) args.push("--runtime-secret", `${await identifiers.resolve(containerRef)}=${secret}`);
      }

      const migration = def["migration"] as Obj | undefined;
      if (migration !== undefined) {
        args.push("--migrate", await identifiers.resolve(asString(migration["container"]) ?? ""));
        const check = asString(migration["checkCommand"]);
        const run = asString(migration["runCommand"]);
        const mode = asString(migration["mode"]);
        if (check !== undefined) args.push("--migration-check", check);
        if (run !== undefined) args.push("--migration-run", run);
        if (mode !== undefined) args.push("--migration-mode", mode);
      }

      for (const [containerRef, check] of Object.entries((def["health"] ?? {}) as Record<string, unknown>)) {
        const url = asString((check as Obj)["url"]);
        if (url !== undefined) args.push("--health", `${await identifiers.resolve(containerRef)}=${await identifiers.resolve(url)}`);
      }

      const plan: DeployPlan = {
        targetRef: view.targetId,
        timeoutMinutes: typeof def["timeoutMinutes"] === "number" ? def["timeoutMinutes"] : 20,
        scriptArgs: (fencingToken) => [...args, "--fencing-token", String(fencingToken)],
      };
      // Reject an unsafe argument HERE, before any X9 intent: an unsafe value would otherwise surface as an X16
      // (UNKNOWN_TARGET_STATE) after the intent instead of a clean pre-dispatch failure (N-13 forward pointer).
      assertSafeScriptArgs(plan.scriptArgs(0));
      return plan;
    },
  };
}

/**
 * Startup check (design §6.2: an invalid set prevents startup): resolves the plan of EVERY validated deployment with a synthetic
 * execution and so applies `assertSafeScriptArgs` to every resolved identifier that would reach a script argument (for example a
 * Secrets Manager value with a trailing newline). Refuses with the deployment id and the position only, never the value. The
 * runtime throw in `resolve` stays as a defensive backstop.
 */
export async function verifyPlansAtStartup(deps: { readonly catalog: StartupCatalog; readonly secrets: SecretProvider }): Promise<void> {
  const resolver = createPlanResolver(deps);
  for (const deploymentId of deps.catalog.deploymentIds()) {
    const info = await deps.catalog.getDeployment(deploymentId);
    const execution = {
      executionId: `startup-check-${deploymentId}`,
      deploymentId,
      lockKey: info?.lockKey ?? "",
      artifacts: Object.fromEntries((info?.units ?? []).map((unit) => [unit, `sha256:${"0".repeat(64)}`])),
    } as unknown as ExecutionItem;
    try {
      await resolver.resolve(execution);
    } catch (error) {
      throw new Error(
        `refusing to start: deployment "${deploymentId}" cannot produce a safe deploy plan (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
  }
}

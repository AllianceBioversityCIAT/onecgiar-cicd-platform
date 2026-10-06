// @akili-spec changes/cicd-executor-poc design §6.2, §6.3, §7 (definition-service row), DD-19, DD-25, DD-27; requirements FR-01, FR-02
// Serves definitions to the core ONLY from the validated startup result
// (`validateForStartup`, N-17b): no adapter below reads a definition file or
// the registry again, so an unvalidated definition can never be served. The
// catalog is a pure projection of `StartupValidationResult`.
import type { StartupValidationResult } from "../application/definition-service/index.js";
import type { DeploymentCatalog, DeploymentInfo } from "../application/execution-service/index.js";
import type { DeploymentSourceLookup } from "../application/message-router/index.js";
import type { TargetPolicyLookup } from "../application/deploy-window-service/index.js";
import type { TargetWindowPolicy } from "../domain/window-policy/index.js";

export interface NotificationDestinationRefs {
  readonly channelRef: string;
  readonly tokenRef: string;
}

export interface ValidatedDeploymentView {
  readonly deploymentId: string;
  readonly definitionRef: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly targetId: string;
  readonly target: Readonly<Record<string, unknown>>;
}

export interface StartupCatalog extends DeploymentCatalog, DeploymentSourceLookup, TargetPolicyLookup {
  deploymentIds(): readonly string[];
  deployment(deploymentId: string): ValidatedDeploymentView | undefined;
  /** Per-definition Slack destination (logical refs), when the definition declares one. */
  notificationDestination(deploymentId: string): NotificationDestinationRefs | undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function createStartupCatalog(startup: StartupValidationResult): StartupCatalog {
  const views = new Map<string, ValidatedDeploymentView>();
  const byLockKey = new Map<string, string>();
  for (const d of startup.deployments) {
    const targetId = str(d.definition["targetRef"]) ?? "";
    const target = startup.registry.entries[targetId];
    if (target === undefined) {
      throw new Error(`validated deployment "${d.deploymentId}" references an unknown target (validation invariant broken)`);
    }
    views.set(d.deploymentId, { deploymentId: d.deploymentId, definitionRef: d.definitionRef, definition: d.definition, targetId, target });
  }
  for (const [targetId, entry] of Object.entries(startup.registry.entries)) {
    const lockKey = str(entry["lockKey"]);
    if (lockKey !== undefined) byLockKey.set(lockKey, targetId);
  }

  return {
    deploymentIds: () => [...views.keys()],
    deployment: (id) => views.get(id),

    async getDeployment(deploymentId): Promise<DeploymentInfo | undefined> {
      const view = views.get(deploymentId);
      const source = startup.resolvedSources[deploymentId];
      if (view === undefined || source === undefined) return undefined;
      const artifacts = Array.isArray(view.definition["artifacts"]) ? (view.definition["artifacts"] as Array<Record<string, unknown>>) : [];
      return {
        definitionRef: view.definitionRef,
        lockKey: str(view.target["lockKey"]) ?? "",
        units: artifacts.map((a) => str(a["unit"]) ?? ""),
        source,
      };
    },

    async resolveSource(deploymentId) {
      const source = startup.resolvedSources[deploymentId];
      // The router's consistency check compares the request's `ci.workflowRef` with the resolved workflow reference (DD-27; value pinned by DD-29/N-24).
      return source === undefined ? undefined : { repository: source.repository, workflowRef: source.workflow };
    },

    async resolve(lockKey): Promise<TargetWindowPolicy | undefined> {
      const targetId = byLockKey.get(lockKey);
      if (targetId === undefined) return undefined;
      const entry = startup.registry.entries[targetId] as Record<string, unknown>;
      return {
        deployWindowPolicy: entry["deployWindowPolicy"] === "required" ? "required" : "not-required",
        externalDeployers: startup.resolvedExternalDeployers[targetId] ?? [],
      };
    },

    notificationDestination(deploymentId) {
      const slack = (views.get(deploymentId)?.definition["notifications"] as Record<string, unknown> | undefined)?.["slack"] as
        | Record<string, unknown>
        | undefined;
      const channelRef = str(slack?.["channelRef"]);
      const tokenRef = str(slack?.["tokenRef"]);
      return channelRef !== undefined && tokenRef !== undefined ? { channelRef, tokenRef } : undefined;
    },
  };
}

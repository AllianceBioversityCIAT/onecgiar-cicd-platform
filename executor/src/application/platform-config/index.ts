// @akili-spec changes/cicd-executor-poc design §7 (platform-config row), DD-23, DD-25; architecture-change-02 AC2-6, AC2-7; requirements FR-14, FR-21; tasks R-6
// Platform configuration at startup (AC-02 V1). Resolves the platform
// identifier references through the SecretProvider (AC2-7: the CI, Executor,
// Scheduler and Operator role IDs are non-sensitive identifiers resolved as
// before AC-02) and checks that the platform Slack channel and token secrets
// EXIST (AC2-6). The token is a credential: it is never read here, only by the
// Slack provider at point of use. Any failure aborts startup naming only the
// logical reference, never a resolved value. No definition and no target is
// read: zero targets is a valid starting state.
import type { SecretProvider } from "../../ports/secret-provider.js";

// definition-service (removed by R-9) keeps its own copies of these types and of the error, because a guard
// transpiles it in isolation; R-9 deletes that duplicate.

/** Platform-config principal references (DD-25): logical `<PLACEHOLDER>` refs that resolve to role IDs. */
export interface PlatformPrincipalRefs {
  /** The CI role shared by the authorized repositories (AC-02 V1, DD-25). */
  readonly ciPrincipalRef: string;
  readonly executorPrincipalRef: string;
  readonly schedulerPrincipalRef: string;
  readonly operatorPrincipalRef: string;
}

/** Resolved role IDs of the platform principals (DD-25). */
export interface ResolvedPrincipals {
  /** The CI role shared by the authorized repositories (AC-02 V1). */
  readonly ci: string;
  readonly executor: string;
  readonly scheduler: string;
  readonly operator: string;
}

export interface PlatformConfigRefs {
  readonly principalRefs: PlatformPrincipalRefs;
  /** Platform Slack channel and token (logical refs); existence-checked only. */
  readonly platformSlack: { readonly channelRef: string; readonly tokenRef: string };
}

export interface ResolvedPlatformConfig {
  readonly principals: ResolvedPrincipals;
}

export class UnresolvedReferenceError extends Error {
  readonly ref: string;
  constructor(ref: string, cause?: unknown) {
    super(
      `unresolved reference at startup: "${ref}" did not resolve via SecretProvider` +
        (cause instanceof Error ? ` (${cause.message})` : ""),
    );
    this.name = "UnresolvedReferenceError";
    this.ref = ref;
  }
}

async function resolve(secrets: SecretProvider, ref: string): Promise<string> {
  try {
    return await secrets.getSecret(ref);
  } catch (cause) {
    throw new UnresolvedReferenceError(ref, cause);
  }
}

async function mustExist(secrets: SecretProvider, ref: string): Promise<void> {
  let found: boolean;
  try {
    found = await secrets.exists(ref);
  } catch (cause) {
    throw new UnresolvedReferenceError(ref, cause);
  }
  if (!found) throw new UnresolvedReferenceError(ref);
}

/** Fails fast on the first reference that does not resolve (principals) or does not exist (Slack channel and token). */
export async function resolvePlatformConfig(secrets: SecretProvider, refs: PlatformConfigRefs): Promise<ResolvedPlatformConfig> {
  const { principalRefs, platformSlack } = refs;
  const principals: ResolvedPrincipals = {
    ci: await resolve(secrets, principalRefs.ciPrincipalRef),
    executor: await resolve(secrets, principalRefs.executorPrincipalRef),
    scheduler: await resolve(secrets, principalRefs.schedulerPrincipalRef),
    operator: await resolve(secrets, principalRefs.operatorPrincipalRef),
  };
  await mustExist(secrets, platformSlack.channelRef);
  await mustExist(secrets, platformSlack.tokenRef);
  return { principals };
}

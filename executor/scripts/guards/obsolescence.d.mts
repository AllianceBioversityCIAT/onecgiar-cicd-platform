// @akili-spec changes/cicd-executor-poc design §15
// Hand-written ambient declarations for obsolescence.mjs — see
// dockerfile-boundary.d.mts for the pattern this mirrors.
export interface Violation {
  readonly guard: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface ObsolescenceEntry {
  readonly path: string;
  readonly status: "DELETED" | "PENDING";
  readonly owner?: string;
  readonly symbol?: string;
  readonly reason?: string;
}

export interface PendingObsolescence {
  readonly path: string;
  readonly symbol: string | undefined;
  readonly owner: string;
  readonly present: boolean;
}

export declare const OBSOLESCENCE_ENTRIES: readonly ObsolescenceEntry[];
export declare function runObsolescenceGuard(
  repoRoot: string,
  entries?: readonly ObsolescenceEntry[],
): Promise<readonly Violation[]>;
export declare function listPendingObsolescence(
  repoRoot: string,
  entries?: readonly ObsolescenceEntry[],
): readonly PendingObsolescence[];

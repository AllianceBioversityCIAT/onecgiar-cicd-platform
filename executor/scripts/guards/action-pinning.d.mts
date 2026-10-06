// @akili-spec changes/cicd-executor-poc requirements FR-22, NFR-02; design DD-29
// Hand-written ambient declarations for action-pinning.mjs.
export interface Violation {
  readonly guard: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export declare function classifyUses(value: unknown): string | undefined;

export declare function runActionPinningGuard(
  repoRoot: string,
  overrides?: { readonly workflowsDir?: string; readonly requireWorkflow?: boolean },
): Promise<readonly Violation[]>;

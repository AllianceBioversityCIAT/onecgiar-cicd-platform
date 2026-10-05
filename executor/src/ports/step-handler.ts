// @akili-spec changes/cicd-executor-poc design DD-05, §7
// Port: one handler per step type, looked up by its `type` tag in a closed
// registry built at startup (DD-05/Strategy). dispatch() is the "intent"
// half of intent-then-act (DD-04): it performs the external call and
// returns the externalRef the step-dispatcher persists before the step
// moves to RUNNING. No business/per-project logic here (NFR-01).

export interface StepContext {
  readonly executionId: string;
  readonly stepId: string;
  readonly dispatchToken: string;
  readonly attempt: number;
}

export interface DispatchResult {
  readonly externalRef: string;
}

export interface StepHandler<TStepConfig = unknown> {
  /** Step type tag, matched against the closed vocabulary in the schema (DD-05). */
  readonly type: string;

  dispatch(step: TStepConfig, ctx: StepContext): Promise<DispatchResult>;
}

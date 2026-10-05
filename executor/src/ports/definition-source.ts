// @akili-spec changes/cicd-executor-poc design DD-19, §7
// Port: the ONLY way the core (definition-service, planner, handlers) reads
// pipeline definitions, the target registry, schemas or the deploy script.
// Returns content plus its definitionRef (DD-19); the core never knows
// whether the implementation bundles files in the image (PoC,
// `bundled-definition-source`) or fetches them externally by commit.

export interface DefinitionContent {
  readonly content: string;
  /** Version identifier recorded per execution (FR-01). PoC: platform repo commit. */
  readonly definitionRef: string;
}

export interface DefinitionSource {
  getPipelineDefinition(pipelineId: string): Promise<DefinitionContent>;
  getTargetRegistry(): Promise<DefinitionContent>;
  getSchema(schemaName: string): Promise<DefinitionContent>;
  getDeployScript(scriptName: string): Promise<DefinitionContent>;
}

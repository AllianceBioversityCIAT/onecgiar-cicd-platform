// @akili-spec changes/cicd-executor-poc design DD-19
// In-memory DefinitionSource fake. Used to prove definition-service depends
// only on the DefinitionSource PORT (substitution test): the exact same
// service code is exercised once against BundledDefinitionSource (real fs)
// and once against this fake (no fs at all), and the observable behavior
// must be identical modulo the content each one was given.
import type { DefinitionContent, DefinitionSource } from "../../src/ports/definition-source.js";

export interface InMemoryDefinitionSourceFixtures {
  readonly deployments?: Readonly<Record<string, string>>;
  readonly targetRegistry?: string;
  readonly schemas?: Readonly<Record<string, string>>;
  readonly deployScripts?: Readonly<Record<string, string>>;
  readonly definitionRef?: string;
}

export class InMemoryDefinitionSource implements DefinitionSource {
  constructor(private readonly fixtures: InMemoryDefinitionSourceFixtures) {}

  private wrap(content: string | undefined, label: string): DefinitionContent {
    if (content === undefined) {
      throw new Error(`InMemoryDefinitionSource: no fixture registered for ${label}`);
    }
    return { content, definitionRef: this.fixtures.definitionRef ?? "in-memory-fake-ref" };
  }

  async getDeploymentDefinition(deploymentId: string): Promise<DefinitionContent> {
    return this.wrap(this.fixtures.deployments?.[deploymentId], `deployment:${deploymentId}`);
  }

  async getTargetRegistry(): Promise<DefinitionContent> {
    return this.wrap(this.fixtures.targetRegistry, "targetRegistry");
  }

  async getSchema(schemaName: string): Promise<DefinitionContent> {
    return this.wrap(this.fixtures.schemas?.[schemaName], `schema:${schemaName}`);
  }

  async getDeployScript(scriptName: string): Promise<DefinitionContent> {
    return this.wrap(this.fixtures.deployScripts?.[scriptName], `deployScript:${scriptName}`);
  }
}

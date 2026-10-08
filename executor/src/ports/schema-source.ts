// @akili-spec changes/cicd-executor-poc design §1.2, DD-19 (superseded in V1: `schemas/` stays bundled); tasks R-6
// Port: how the composition root obtains the bundled JSON Schemas (the request,
// event and target record contracts) in AC-02 V1, where there is no
// DefinitionSource. Content only: no definition, registry or script is served
// here. The shape is a subset of DefinitionSource#getSchema, so existing
// callers that still hold a DefinitionSource keep working until R-9.

export interface SchemaContent {
  readonly content: string;
}

export interface SchemaSource {
  getSchema(schemaName: string): Promise<SchemaContent>;
}

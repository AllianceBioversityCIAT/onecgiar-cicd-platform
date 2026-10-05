// @akili-spec changes/cicd-executor-poc design §5.2, §7
// Port: blob storage for source packages and logs (`handlers/source`).
// Generic byte-stream shapes only — no S3 SDK types here.

import type { Readable } from "node:stream";

export interface ArtifactLocation {
  readonly uri: string;
}

export interface ArtifactStore {
  putObject(
    key: string,
    body: Readable | Uint8Array,
    options?: { contentType?: string },
  ): Promise<ArtifactLocation>;

  getObjectStream(key: string): Promise<Readable>;

  deleteObject(key: string): Promise<void>;
}

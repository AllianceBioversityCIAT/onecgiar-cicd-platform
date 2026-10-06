// @akili-spec changes/cicd-executor-poc design §5.1 (the reconciler uses Query only, no scans)
// Wraps a real `DynamoDBDocumentClient` so any `ScanCommand` it is asked to
// send throws instead of running — the only way to PROVE "this code path
// never scans" rather than merely read the source and hope. Every other
// command passes straight through to the real client.
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export class ScanAttemptedError extends Error {
  public constructor() {
    super("ScanCommand was sent — GSI2 access must always be a Query (design §5.1: one Query per partition, no scans)");
    this.name = "ScanAttemptedError";
  }
}

export function createScanForbiddingClient(real: DynamoDBDocumentClient): DynamoDBDocumentClient {
  return new Proxy(real, {
    get(target, propertyKey, receiver) {
      if (propertyKey === "send") {
        return async (command: unknown) => {
          if (command instanceof ScanCommand) {
            throw new ScanAttemptedError();
          }
          return (target.send as (c: unknown) => Promise<unknown>)(command);
        };
      }
      return Reflect.get(target, propertyKey, receiver);
    },
  });
}

// @akili-spec changes/cicd-executor-poc design DD-03 (T-08 harness)
// Regression check for the harness itself: stop() must end the WHOLE
// DynamoDB Local process tree (on Windows `java` may be a shim that starts the
// real JVM as a child). If it only killed the shim, the JVM would keep
// serving the port, so "the port refuses connections after stop()" proves the
// tree is gone.
import { connect } from "node:net";
import { describe, expect, test } from "vitest";
import { dynamoDbLocalAvailable } from "./setup.js";

const HARNESS_PATH = "../support/dynamodb-local.mjs";

function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = connect({ port, host: "127.0.0.1" }, () => {
      conn.destroy();
      resolve(true);
    });
    conn.on("error", () => {
      conn.destroy();
      resolve(false);
    });
  });
}

describe.skipIf(!dynamoDbLocalAvailable())("DynamoDB Local harness lifecycle", () => {
  test("stop() leaves nothing listening on the port (whole process tree killed)", async () => {
    const harness = (await import(HARNESS_PATH)) as {
      findFreePort(): Promise<number>;
      startDynamoDbLocal(port: number): Promise<{ port: number; stop(): Promise<void> }>;
    };
    const port = await harness.findFreePort();
    const instance = await harness.startDynamoDbLocal(port);
    expect(await portAcceptsConnections(port)).toBe(true);

    await instance.stop();
    expect(await portAcceptsConnections(port)).toBe(false);
  }, 60_000);
});

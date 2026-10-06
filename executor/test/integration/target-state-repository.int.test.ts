// @akili-spec changes/cicd-executor-poc design §5.1, §7.3 (X1/E2, X9, X12, X16), DD-09, DD-27; requirements FR-11, FR-23
// Target state with ordering and fencing on DynamoDB Local: monotonic-max races
// for `highestAccepted` and `highestDispatched`, the unfenced dispatch write,
// the fenced `lastDeployed` write, the single-source invariant, and the
// `unresolved[]` append/removal that never touches an ordering field.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TargetStateRepository } from "../../src/adapters/dynamodb-state-store/target-state-repository.js";
import { createTestDocumentClient, dynamoDbLocalAvailable, ensureTestTable, testTableName } from "./setup.js";

const SRC = "<SOURCE_A>";
const OTHER_SRC = "<SOURCE_B>";
const stamp = (runNumber: number, sourceRef = SRC) => ({ sourceRef, runNumber, executionId: `exec-${String(runNumber)}` });
const deployed = (runNumber: number, sourceRef = SRC) => ({ ...stamp(runNumber, sourceRef), commitSha: "<COMMIT_SHA>" });

describe.skipIf(!dynamoDbLocalAvailable())("TargetStateRepository (DynamoDB Local)", () => {
  let client: DynamoDBDocumentClient;
  let repository: TargetStateRepository;

  beforeAll(async () => {
    await ensureTestTable();
    client = createTestDocumentClient();
    repository = new TargetStateRepository(client, testTableName());
  });

  afterAll(() => {
    client?.destroy();
  });

  const newLockKey = (prefix: string) => `${prefix}-${randomUUID()}`;

  describe("monotonic max races (highestAccepted, highestDispatched)", () => {
    test("two parallel highestAccepted raises: the max wins, 60 repetitions", async () => {
      for (let i = 0; i < 60; i += 1) {
        const lockKey = newLockKey("race-accepted");
        const [low, high] = i % 2 === 0 ? [3, 7] : [7, 3];
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const run = async (n: number) => {
          await barrier;
          return repository.raiseHighestAccepted(lockKey, stamp(n), 1);
        };
        const pending = Promise.all([run(low), run(high)]);
        release();
        const outcomes = await pending;
        expect((await repository.get(lockKey))?.highestAccepted?.runNumber).toBe(7);
        // The 7 always succeeds; the 3 may succeed (it landed first) or be refused, never an error.
        expect(outcomes.some((o) => o.raised)).toBe(true);
      }
    });

    test("two parallel highestDispatched raises: the max wins, 60 repetitions", async () => {
      for (let i = 0; i < 60; i += 1) {
        const lockKey = newLockKey("race-dispatched");
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const run = async (n: number) => {
          await barrier;
          return repository.raiseHighestDispatched(lockKey, stamp(n), 1);
        };
        const pending = Promise.all([run(i % 2 === 0 ? 4 : 9), run(i % 2 === 0 ? 9 : 4)]);
        release();
        await pending;
        expect((await repository.get(lockKey))?.highestDispatched?.runNumber).toBe(9);
      }
    });

    test("equal value is accepted, lower is rejected without error (R2-1)", async () => {
      const lockKey = newLockKey("equal-lower");
      expect(await repository.raiseHighestAccepted(lockKey, stamp(5), 1)).toEqual({ raised: true });
      expect(await repository.raiseHighestAccepted(lockKey, { ...stamp(5), executionId: "exec-rerun" }, 2)).toEqual({
        raised: true,
      });
      expect(await repository.raiseHighestAccepted(lockKey, stamp(4), 3)).toEqual({
        raised: false,
        reason: "STORED_IS_NEWER",
      });
      const stored = await repository.get(lockKey);
      expect(stored?.highestAccepted).toEqual({ ...stamp(5), executionId: "exec-rerun" });

      expect(await repository.raiseHighestDispatched(lockKey, stamp(5), 4)).toEqual({ raised: true });
      expect(await repository.raiseHighestDispatched(lockKey, stamp(5), 5)).toEqual({ raised: true });
      expect(await repository.raiseHighestDispatched(lockKey, stamp(2), 6)).toEqual({
        raised: false,
        reason: "STORED_IS_NEWER",
      });
    });

    test("a different sourceRef is refused and never compared numerically", async () => {
      const lockKey = newLockKey("source-mismatch");
      await repository.raiseHighestAccepted(lockKey, stamp(5), 1);
      // A numerically higher run of ANOTHER source must not overwrite.
      expect(await repository.raiseHighestAccepted(lockKey, stamp(500, OTHER_SRC), 2)).toEqual({
        raised: false,
        reason: "SOURCE_MISMATCH",
      });
      await repository.raiseHighestDispatched(lockKey, stamp(5), 1);
      expect(await repository.raiseHighestDispatched(lockKey, stamp(500, OTHER_SRC), 2)).toEqual({
        raised: false,
        reason: "SOURCE_MISMATCH",
      });
      const stored = await repository.get(lockKey);
      expect(stored?.highestAccepted?.sourceRef).toBe(SRC);
      expect(stored?.highestDispatched?.sourceRef).toBe(SRC);
    });

    test("an invalid runNumber is rejected by the shared policy rule", async () => {
      await expect(repository.raiseHighestAccepted(newLockKey("bad"), stamp(0), 1)).rejects.toThrow(RangeError);
    });
  });

  describe("highestDispatched in the X9 transaction, never fenced", () => {
    test("a holder with a stale fencing token can still raise highestDispatched", async () => {
      const lockKey = newLockKey("unfenced");
      await repository.recordDeployed({
        lockKey,
        fencingToken: 9,
        lastDeployed: deployed(3),
        currentImages: { app: "image:3" },
        updatedAt: 1,
      });
      // The caller's token (say 2) is below the stored 9: lastDeployed is fenced out...
      const fenced = await repository.recordDeployed({
        lockKey,
        fencingToken: 2,
        lastDeployed: deployed(4),
        currentImages: { app: "image:4" },
        updatedAt: 2,
      });
      expect(fenced.written).toBe(false);
      // ...but the dispatch intent carries no fence and is accepted.
      expect(await repository.raiseHighestDispatched(lockKey, stamp(4), 3)).toEqual({ raised: true });
      expect((await repository.get(lockKey))?.highestDispatched?.runNumber).toBe(4);
    });

    test("the item builder works inside a TransactWriteItems and a failed condition cancels the transaction", async () => {
      const lockKey = newLockKey("x9-transaction");
      const executionPk = `EXEC#${randomUUID()}`;
      const execute = (n: number) =>
        client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: { TableName: testTableName(), Item: { pk: `${executionPk}-${String(n)}`, sk: "META", n } },
              },
              { Update: repository.highestDispatchedUpdate(lockKey, stamp(n), 1) },
            ],
          }),
        );
      await execute(6);
      await expect(execute(5)).rejects.toMatchObject({ name: "TransactionCanceledException" });
      expect((await repository.get(lockKey))?.highestDispatched?.runNumber).toBe(6);
    });
  });

  describe("lastDeployed (fenced)", () => {
    test("a strictly stale fencingToken write is rejected and changes nothing", async () => {
      const lockKey = newLockKey("stale-fence");
      const first = await repository.recordDeployed({
        lockKey,
        fencingToken: 5,
        lastDeployed: deployed(10),
        currentImages: { app: "image:10" },
        previousImages: { app: "image:9" },
        updatedAt: 1_000,
      });
      expect(first).toEqual({ written: true });

      const stale = await repository.recordDeployed({
        lockKey,
        fencingToken: 4,
        lastDeployed: deployed(11),
        currentImages: { app: "image:STALE" },
        updatedAt: 2_000,
      });
      expect(stale).toEqual({ written: false, reason: "STALE_FENCING_TOKEN" });

      const stored = await repository.get(lockKey);
      expect(stored?.fencingToken).toBe(5);
      expect(stored?.lastDeployed?.runNumber).toBe(10);
      expect(stored?.currentImages).toEqual({ app: "image:10" });
      expect(stored?.previousImages).toEqual({ app: "image:9" });
    });

    test("equal and higher fencing tokens are accepted (monotonic, never only >)", async () => {
      const lockKey = newLockKey("monotonic");
      const write = (token: number, run: number) =>
        repository.recordDeployed({
          lockKey,
          fencingToken: token,
          lastDeployed: deployed(run),
          currentImages: { app: `image:${String(run)}` },
          updatedAt: run,
        });
      expect(await write(7, 1)).toEqual({ written: true });
      expect(await write(7, 2)).toEqual({ written: true });
      expect(await write(8, 3)).toEqual({ written: true });
      const stored = await repository.get(lockKey);
      expect(stored?.lastDeployed?.runNumber).toBe(3);
      expect(stored?.fencingToken).toBe(8);
    });

    test("a different sourceRef than the stored lastDeployed is refused", async () => {
      const lockKey = newLockKey("lastdeployed-source");
      await repository.recordDeployed({
        lockKey,
        fencingToken: 1,
        lastDeployed: deployed(2),
        currentImages: { app: "image:2" },
        updatedAt: 1,
      });
      const outcome = await repository.recordDeployed({
        lockKey,
        fencingToken: 2,
        lastDeployed: deployed(900, OTHER_SRC),
        currentImages: { app: "image:other" },
        updatedAt: 2,
      });
      expect(outcome).toEqual({ written: false, reason: "SOURCE_MISMATCH" });
      expect((await repository.get(lockKey))?.lastDeployed?.sourceRef).toBe(SRC);
    });

    test("an ordering write before the first deploy does not block the fenced write; the unresolved marker stays opaque", async () => {
      const lockKey = newLockKey("marker");
      await repository.raiseHighestAccepted(lockKey, stamp(1), 1);
      await repository.raiseHighestDispatched(lockKey, stamp(1), 2);
      const marker = "unresolved:sha256:0123abcd";
      expect(
        await repository.recordDeployed({
          lockKey,
          fencingToken: 1,
          lastDeployed: deployed(1),
          currentImages: { app: "<DIGEST_NEW>" },
          previousImages: { app: marker },
          updatedAt: 3,
        }),
      ).toEqual({ written: true });
      const stored = await repository.get(lockKey);
      expect(stored?.previousImages).toEqual({ app: marker });
      expect(stored?.highestAccepted?.runNumber).toBe(1);
      expect(stored?.highestDispatched?.runNumber).toBe(1);
    });
  });

  describe("unresolved[]", () => {
    test("append in a transaction and operator removal leave the ordering fields untouched", async () => {
      const lockKey = newLockKey("unresolved");
      await repository.recordDeployed({
        lockKey,
        fencingToken: 3,
        lastDeployed: deployed(4),
        currentImages: { app: "image:4" },
        updatedAt: 1,
      });
      await repository.raiseHighestAccepted(lockKey, stamp(6), 2);
      await repository.raiseHighestDispatched(lockKey, stamp(5), 3);
      const before = await repository.get(lockKey);

      // X16 shape: an execution item update plus the unresolved append in one transaction.
      const append = (executionId: string, since: number) =>
        client.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: testTableName(), Item: { pk: `EXEC#${randomUUID()}`, sk: "META" } } },
              { Update: repository.unresolvedAppendUpdate(lockKey, { executionId, since }, since) },
            ],
          }),
        );
      await append("exec-a", 10);
      await append("exec-b", 11);
      await append("exec-c", 12);
      expect((await repository.get(lockKey))?.unresolved?.map((e) => e.executionId)).toEqual([
        "exec-a",
        "exec-b",
        "exec-c",
      ]);

      expect(await repository.removeUnresolved(lockKey, "exec-b", 20)).toBe(true);
      expect(await repository.removeUnresolved(lockKey, "exec-b", 21)).toBe(false);
      const after = await repository.get(lockKey);
      expect(after?.unresolved?.map((e) => e.executionId)).toEqual(["exec-a", "exec-c"]);

      expect(after?.lastDeployed).toEqual(before?.lastDeployed);
      expect(after?.highestDispatched).toEqual(before?.highestDispatched);
      expect(after?.highestAccepted).toEqual(before?.highestAccepted);
      expect(after?.fencingToken).toBe(before?.fencingToken);
      expect(after?.currentImages).toEqual(before?.currentImages);
    });

    test("removing from a target with no entries returns false", async () => {
      expect(await repository.removeUnresolved(newLockKey("none"), "exec-x", 1)).toBe(false);
    });

    test("an append before any other write creates the item with the lockKey", async () => {
      const lockKey = newLockKey("append-first");
      await client.send(
        new TransactWriteCommand({
          TransactItems: [{ Update: repository.unresolvedAppendUpdate(lockKey, { executionId: "e", since: 1 }, 1) }],
        }),
      );
      const stored = await repository.get(lockKey);
      expect(stored?.lockKey).toBe(lockKey);
      expect(stored?.unresolved).toEqual([{ executionId: "e", since: 1 }]);
    });
  });
});

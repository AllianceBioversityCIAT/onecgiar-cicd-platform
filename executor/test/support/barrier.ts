// @akili-spec changes/cicd-executor-poc design DD-03 (T-08's concurrency tests)
// A reusable rendezvous barrier: `createBarrier(n)` returns an async
// function that `n` concurrent callers each await once. None of them resume
// until ALL `n` have called it — this is what turns "fire N promises" into
// an actual race at the same instant, instead of N sequential calls that
// never exercise DynamoDB's own conditional-write arbitration (this task's
// disqualifier: "concurrent writers run sequentially do not exercise the
// race").
export function createBarrier(participantCount: number): () => Promise<void> {
  if (participantCount < 2) {
    throw new Error("a barrier needs at least 2 participants to prove anything about a race");
  }
  let arrivals = 0;
  let releaseAll: () => void;
  const everyoneArrived = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });

  return async function arriveAndWait(): Promise<void> {
    arrivals += 1;
    if (arrivals === participantCount) {
      releaseAll();
    }
    await everyoneArrived;
  };
}

// @akili-spec changes/cicd-executor-poc design §4.2, §12; requirements NFR-04
// Tracks best-effort background work (notification fan-out from synchronous
// hooks, the delivered-script checksum write) so that a handler can wait for
// it before acknowledging and the ordered shutdown can drain it. A tracked
// promise never rejects into the tracker: failures are the task's own to log.
export interface PendingTasks {
  track(task: Promise<unknown>): void;
  /** Resolves once everything tracked so far (and anything tracked meanwhile) has settled. */
  idle(): Promise<void>;
}

export function createPendingTasks(): PendingTasks {
  const tasks = new Set<Promise<unknown>>();
  return {
    track(task) {
      const settled = task.then(
        () => undefined,
        () => undefined,
      );
      tasks.add(settled);
      void settled.then(() => tasks.delete(settled));
    },
    async idle() {
      while (tasks.size > 0) await Promise.all([...tasks]);
    },
  };
}

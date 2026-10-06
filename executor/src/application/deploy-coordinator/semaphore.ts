// @akili-spec changes/cicd-executor-poc design §7.5 (SSH semaphore, default 4)
// Bounded concurrency for SSH sessions. FIFO, in-memory by design: the slot
// "is gone with the process" on a crash (§7.5), and correctness never rests
// on it (the distributed lock and the target mutex do).

/** Default number of concurrent SSH sessions (design §7.5). */
export const DEFAULT_SSH_CONCURRENCY = 4;

export class Semaphore {
  private held = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(public readonly capacity: number = DEFAULT_SSH_CONCURRENCY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("semaphore capacity must be an integer >= 1");
  }

  /** Slots currently held. */
  public get inUse(): number {
    return this.held;
  }

  /** Callers queued for a slot. */
  public get waiting(): number {
    return this.waiters.length;
  }

  /** Resolves with an idempotent release function once a slot is free. */
  public async acquire(): Promise<() => void> {
    if (this.held >= this.capacity) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.held += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next === undefined) this.held -= 1;
      else next(); // hand the slot over: `held` stays the same
    };
  }
}

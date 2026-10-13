// @akili-spec changes/cicd-executor-poc architecture-change-04 §10.6
// Local concurrency of one agent: `maxParallel` running scripts, named shared resources with capacities (a Docker
// engine, migrations...), reserved ALL-OR-NOTHING (no partial reservation, so no deadlock). One run per target is also
// guaranteed here (in addition to the central lock and the target state). Pending commands start in arrival order
// among those whose resources are free; a command that waited longer than half of its start window gets priority.
export interface SlotRequest {
  readonly commandId: string;
  readonly targetId: string;
  readonly resources: readonly string[];
  readonly receivedAt: number;
  readonly notAfter: number;
}

export class LocalScheduler {
  private running = 0;
  private readonly inUse = new Map<string, number>();
  private readonly activeTargets = new Set<string>();

  public constructor(
    private readonly maxParallel: number,
    private readonly capacities: Readonly<Record<string, number>>,
  ) {}

  private fits(request: SlotRequest): boolean {
    if (this.running >= this.maxParallel || this.activeTargets.has(request.targetId)) return false;
    return request.resources.every((r) => (this.inUse.get(r) ?? 0) < (this.capacities[r] ?? 0));
  }

  /** Reserves everything the request needs, or nothing. */
  public tryReserve(request: SlotRequest): boolean {
    if (!this.fits(request)) return false;
    this.running += 1;
    this.activeTargets.add(request.targetId);
    for (const r of request.resources) this.inUse.set(r, (this.inUse.get(r) ?? 0) + 1);
    return true;
  }

  public release(request: Pick<SlotRequest, "targetId" | "resources">): void {
    if (!this.activeTargets.delete(request.targetId)) return;
    this.running = Math.max(0, this.running - 1);
    for (const r of request.resources) this.inUse.set(r, Math.max(0, (this.inUse.get(r) ?? 0) - 1));
  }

  /** The order in which pending commands should try to start now (starvation guard first, then arrival). */
  public order<T extends SlotRequest>(pending: readonly T[], now: number): T[] {
    const starving = (p: SlotRequest): boolean => now - p.receivedAt > (p.notAfter - p.receivedAt) / 2;
    return [...pending].sort((a, b) => Number(starving(b)) - Number(starving(a)) || a.receivedAt - b.receivedAt);
  }

  /** True when any starving request is blocked: then nothing younger may take the resources it needs. */
  public blocksYounger(starvingRequest: SlotRequest, younger: SlotRequest): boolean {
    return starvingRequest.resources.some((r) => younger.resources.includes(r)) || starvingRequest.targetId === younger.targetId;
  }

  public get runningCount(): number {
    return this.running;
  }
}

export type JobKind = "telegram" | "drive";

export interface JobDeps {
  /** Runs the sync for one source kind and returns a short summary for reports. */
  run: Record<JobKind, () => Promise<object>>;
  /** Rebuilds nodes/resources after a sync changed the raw metadata. */
  classify: () => Promise<object>;
  intervalMinutes: (kind: JobKind) => Promise<number>;
  logger: {
    info: (o: object, m?: string) => void;
    warn: (o: object, m?: string) => void;
    error: (o: object, m?: string) => void;
  };
  /** Free-text progress of a running job (e.g. "1200 messages read"), shown by /status. */
  note?: (kind: JobKind) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface JobReport {
  kind: JobKind;
  ok: boolean;
  startedAt: Date;
  finishedAt: Date;
  summary?: object;
  classified?: object;
  error?: string;
}

/**
 * Periodic sync loops. Intervals are re-read from settings every cycle, so changing
 * `sync.*.intervalMinutes` takes effect without a restart. A kind never overlaps itself, a failure
 * is recorded and the loop carries on, and classification is serialized across kinds.
 */
export class SyncScheduler {
  private stopped = true;
  private running = new Map<JobKind, Promise<JobReport>>();
  private classifyChain: Promise<unknown> = Promise.resolve();
  readonly last = new Map<JobKind, JobReport>();
  private startedAt = new Map<JobKind, Date>();
  private phase = new Map<JobKind, "sync" | "classify">();
  private timers = new Set<NodeJS.Timeout>();

  constructor(private readonly d: JobDeps) {}

  /** Runs one job now (used by the loops and by admin "sync now"). Concurrent calls share the same run. */
  runNow(kind: JobKind): Promise<JobReport> {
    const active = this.running.get(kind);
    if (active) return active;
    const p = this.execute(kind).finally(() => this.running.delete(kind));
    this.running.set(kind, p);
    return p;
  }

  private async execute(kind: JobKind): Promise<JobReport> {
    const now = this.d.now ?? (() => new Date());
    const startedAt = now();
    const report: JobReport = { kind, ok: false, startedAt, finishedAt: startedAt };
    this.startedAt.set(kind, startedAt);
    this.phase.set(kind, "sync");
    try {
      report.summary = await this.d.run[kind]();
      this.phase.set(kind, "classify");
      const job = this.classifyChain.then(() => this.d.classify());
      this.classifyChain = job.catch(() => undefined);
      report.classified = await job;
      report.ok = true;
      this.d.logger.info({ kind, ...report.summary }, "sync finished");
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err);
      this.d.logger.error({ kind, error: report.error }, "sync failed");
    }
    report.finishedAt = now();
    this.startedAt.delete(kind);
    this.phase.delete(kind);
    this.last.set(kind, report);
    return report;
  }

  /** Jobs running right now, for status displays. */
  activity(): { kind: JobKind; since: Date; phase: "sync" | "classify"; note?: string }[] {
    return [...this.startedAt].map(([kind, since]) => ({
      kind,
      since,
      phase: this.phase.get(kind) ?? "sync",
      note: this.d.note?.(kind),
    }));
  }

  start(initialDelayMs = 5_000) {
    this.stopped = false;
    for (const kind of ["telegram", "drive"] as JobKind[]) void this.loop(kind, initialDelayMs);
  }

  private wait(ms: number): Promise<void> {
    if (this.d.sleep) return this.d.sleep(ms);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      t.unref();
      this.timers.add(t);
    });
  }

  private async loop(kind: JobKind, firstDelayMs: number) {
    await this.wait(firstDelayMs);
    while (!this.stopped) {
      await this.runNow(kind);
      if (this.stopped) break;
      let minutes = 10;
      try {
        minutes = await this.d.intervalMinutes(kind);
      } catch {
        /* keep default */
      }
      await this.wait(Math.max(1, minutes) * 60_000);
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Warns when a kind has not succeeded for `factor` intervals. */
  async staleKinds(factor = 3): Promise<JobKind[]> {
    const out: JobKind[] = [];
    const nowMs = (this.d.now ?? (() => new Date()))().getTime();
    for (const kind of ["telegram", "drive"] as JobKind[]) {
      const interval = (await this.d.intervalMinutes(kind)) * 60_000;
      const r = this.last.get(kind);
      if (!r || !r.ok || nowMs - r.finishedAt.getTime() > interval * factor) out.push(kind);
    }
    return out;
  }
}

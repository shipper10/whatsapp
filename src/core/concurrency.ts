/** Serializes async work per key, so two quick messages from one participant never race on their session. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}

/** Sliding-window limiter. In-memory is fine for a single-process deployment. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Returns "ok", "warn" (first rejection in this window: tell the user once) or "drop". */
  check(key: string, maxPerMinute: number): "ok" | "warn" | "drop" {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= maxPerMinute) {
      const warned = arr.length === maxPerMinute;
      arr.push(t);
      this.hits.set(key, arr);
      return warned ? "warn" : "drop";
    }
    arr.push(t);
    this.hits.set(key, arr);
    return "ok";
  }

  prune() {
    const t = this.now();
    for (const [k, v] of this.hits) if (v.every((x) => t - x >= 60_000)) this.hits.delete(k);
  }
}

/** Remembers recently seen event ids to ignore webhook redeliveries. */
export class Deduper {
  private seen = new Map<string, number>();
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if this id was already seen (and records it otherwise). */
  isDuplicate(id: string): boolean {
    const t = this.now();
    const prev = this.seen.get(id);
    if (prev !== undefined && t - prev < this.ttlMs) return true;
    this.seen.set(id, t);
    if (this.seen.size > this.max) {
      for (const [k, v] of this.seen) {
        if (t - v >= this.ttlMs || this.seen.size > this.max) this.seen.delete(k);
        if (this.seen.size <= this.max * 0.8) break;
      }
    }
    return false;
  }
}

/** Bounded parallelism (FIFO). */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

interface Waiting {
  start: () => void;
  onPosition?: (position: number) => void;
}

/**
 * FIFO queue with a concurrency limit that tells waiting jobs where they stand (1 = next to run).
 * Each person has at most one job in it at a time (their request is processed in order), so FIFO is
 * also fair between people.
 */
export class JobQueue {
  private active = 0;
  private waiting: Waiting[] = [];

  constructor(private limit: number) {}

  get running() {
    return this.active;
  }
  get queued() {
    return this.waiting.length;
  }

  setLimit(n: number) {
    this.limit = Math.max(1, n);
    this.pump();
  }

  async run<T>(fn: () => Promise<T>, onPosition?: (position: number) => void): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((start) => {
        const w: Waiting = { start, onPosition };
        this.waiting.push(w);
        onPosition?.(this.waiting.length);
      });
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      this.active--;
      this.pump();
    }
  }

  private pump() {
    while (this.active < this.limit && this.waiting.length > 0) {
      this.active++;
      this.waiting.shift()?.start();
    }
    this.waiting.forEach((w, i) => w.onPosition?.(i + 1));
  }
}

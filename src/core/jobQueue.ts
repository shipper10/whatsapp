interface Waiting {
  weight: number;
  start: () => void;
  onPosition?: (position: number) => void;
}

/**
 * FIFO queue with a concurrency limit that tells waiting jobs where they stand (1 = next to run).
 * Each person has at most one job in it at a time (their request is processed in order), so FIFO is
 * also fair between people.
 *
 * Jobs may carry a weight (bytes they will hold on disk). While other jobs are running, a job that
 * would push the running total over the budget waits, so a few huge files cannot fill a small disk
 * together. A job alone in the queue always runs, however large (the size limits are enforced elsewhere).
 */
export class JobQueue {
  private active = 0;
  private waiting: Waiting[] = [];
  private load = 0;
  private budget = Number.POSITIVE_INFINITY;

  constructor(private limit: number) {}

  /** Sum of the weights of the jobs running now. */
  get inflight() {
    return this.load;
  }

  /** 0 or less removes the budget. */
  setBudget(bytes: number) {
    this.budget = bytes > 0 ? bytes : Number.POSITIVE_INFINITY;
    this.pump();
  }

  private fits(weight: number) {
    return this.active === 0 || this.load + weight <= this.budget;
  }

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

  async run<T>(
    fn: () => Promise<T>,
    onPosition?: (position: number) => void,
    weight = 0,
  ): Promise<T> {
    if (this.active >= this.limit || this.waiting.length > 0 || !this.fits(weight)) {
      await new Promise<void>((start) => {
        const w: Waiting = { weight, start, onPosition };
        this.waiting.push(w);
        onPosition?.(this.waiting.length);
      });
    } else {
      this.active++;
      this.load += weight;
    }
    try {
      return await fn();
    } finally {
      this.active--;
      this.load -= weight;
      this.pump();
    }
  }

  private pump() {
    // Strict FIFO: if the head does not fit yet, nobody jumps ahead of it.
    while (this.active < this.limit && this.waiting[0] && this.fits(this.waiting[0].weight)) {
      const next = this.waiting.shift() as Waiting;
      this.active++;
      this.load += next.weight;
      next.start();
    }
    this.waiting.forEach((w, i) => w.onPosition?.(i + 1));
  }
}

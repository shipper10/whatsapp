export interface KeepAliveDeps {
  /** Public base URL of this service (no trailing slash needed); omit to only touch the database. */
  url?: string;
  /** Reads something from the database so a free Postgres sees activity. */
  touchDb: () => Promise<void>;
  intervalMinutes: () => Promise<number>;
  logger: { warn: (o: object, m?: string) => void };
  fetchImpl?: typeof fetch;
}

/** One keep-alive beat: database read, then a request to our own public /healthz. Never throws. */
export async function keepAliveTick(
  d: KeepAliveDeps,
): Promise<{ db: boolean; http: boolean | null }> {
  let db = false;
  let http: boolean | null = null;
  try {
    await d.touchDb();
    db = true;
  } catch (e) {
    d.logger.warn({ err: String(e) }, "keep-alive: database read failed");
  }
  if (d.url) {
    try {
      const res = await (d.fetchImpl ?? fetch)(`${d.url.replace(/\/$/, "")}/healthz`, {
        signal: AbortSignal.timeout(15_000),
      });
      http = res.ok;
    } catch (e) {
      http = false;
      d.logger.warn({ err: String(e) }, "keep-alive: self request failed");
    }
  }
  return { db, http };
}

/** Repeats the beat, re-reading the interval each time so it can be changed (or turned off) at runtime. */
export function startKeepAlive(d: KeepAliveDeps): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = async () => {
    if (stopped) return;
    const minutes = await d.intervalMinutes().catch(() => 10);
    timer = setTimeout(
      async () => {
        if (minutes > 0) await keepAliveTick(d);
        void schedule();
      },
      Math.max(1, minutes || 1) * 60_000,
    );
    timer.unref();
  };
  void schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

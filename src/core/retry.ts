/** Bounded exponential backoff. Honors Telegram FLOOD_WAIT (`seconds`) when present. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const flood = (err as { seconds?: number }).seconds;
      await sleep(flood ? flood * 1000 + 500 : Math.min(30_000, 500 * 2 ** attempt));
    }
  }
}

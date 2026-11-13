/** An error's message plus the reasons underneath it (database errors hide theirs in `cause`). */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur instanceof Error) {
      const e = cur as Error & { code?: string; detail?: string };
      const extra = [e.code, e.detail].filter(Boolean).join(" ");
      parts.push(extra ? `${e.message} [${extra}]` : e.message);
      cur = e.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" ← caused by: ");
}

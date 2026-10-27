import { describe, expect, it } from "vitest";
import { JobQueue } from "../src/core/jobQueue.js";
import { WhatsAppProgress } from "../src/delivery/progress.js";
import type { WhatsAppProvider } from "../src/providers/whatsapp/types.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("JobQueue", () => {
  it("runs FIFO within the limit and reports positions", async () => {
    const q = new JobQueue(1);
    const order: string[] = [];
    const pos: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = q.run(async () => {
      order.push("a");
      await gate;
    });
    const b = q.run(
      async () => void order.push("b"),
      (p) => pos.push(p),
    );
    const c = q.run(
      async () => void order.push("c"),
      (p) => pos.push(p),
    );
    await tick();
    expect(order).toEqual(["a"]);
    expect(pos.slice(0, 2)).toEqual([1, 2]);
    release();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(q.running).toBe(0);
  });

  it("frees the slot when a job throws", async () => {
    const q = new JobQueue(1);
    await expect(q.run(async () => Promise.reject(new Error("x")))).rejects.toThrow();
    await expect(q.run(async () => 5)).resolves.toBe(5);
  });
});

function fakeProvider(canEdit = true) {
  const sent: string[] = [];
  const edits: string[] = [];
  const provider = {
    sendText: async (m: { text: string }) => {
      sent.push(m.text);
      return { providerMessageId: "m1" };
    },
    editText: canEdit
      ? async (_c: string, _id: string, text: string) => {
          edits.push(text);
          return true;
        }
      : undefined,
  } as unknown as WhatsAppProvider;
  return { provider, sent, edits };
}

describe("WhatsAppProgress", () => {
  it("stays silent for a small single file", async () => {
    const f = fakeProvider();
    const p = new WhatsAppProgress({
      provider: f.provider,
      conversationId: "c",
      lang: "ar",
      minBytes: 5e6,
    });
    await p.begin(1);
    p.file("a.pdf", 1000);
    p.downloading(500, 1000);
    p.fileDone(true);
    await p.end();
    expect(f.sent).toEqual([]);
    expect(f.edits).toEqual([]);
  });

  it("shows download percent for a big file, then the outcome", async () => {
    const f = fakeProvider();
    let t = 0;
    const p = new WhatsAppProgress({
      provider: f.provider,
      conversationId: "c",
      lang: "en",
      minBytes: 1e6,
      minEditGapMs: 0,
      now: () => (t += 10_000),
    });
    await p.begin(1);
    p.file("big.pdf", 10e6);
    p.downloading(5e6, 10e6);
    p.fileDone(true);
    await p.end();
    expect(f.sent[0]).toContain("big.pdf");
    expect(f.edits.some((e) => e.includes("50%"))).toBe(true);
    expect(f.edits.at(-1)).toContain("Sent");
  });

  it("shows queue position and survives providers that cannot edit", async () => {
    const f = fakeProvider(false);
    const p = new WhatsAppProgress({
      provider: f.provider,
      conversationId: "c",
      lang: "ar",
      minBytes: 5e6,
    });
    await p.begin(1);
    p.file("a.pdf", 10);
    p.queued(2);
    p.fileDone(true);
    await p.end();
    expect(f.sent[0]).toContain("2");
    expect(f.sent.at(-1)).toContain("✅");
  });
});

import { describe, expect, it } from "vitest";
import type { TelegramStore } from "../src/telegram/store.js";
import { syncTelegram } from "../src/telegram/sync.js";
import type { RawTelegramMessage, TelegramRecord, TelegramSource } from "../src/telegram/types.js";

const mk = (id: number, text = `msg ${id}`, edit?: Date): RawTelegramMessage => ({
  id,
  date: new Date(2026, 0, 1),
  editDate: edit,
  text,
  entities: [],
});

class FakeSource implements TelegramSource {
  failNext = 0;
  calls = 0;
  constructor(public msgs: RawTelegramMessage[]) {}
  async fetchBatch({ minId, limit }: { minId: number; limit: number }) {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("network");
    }
    const top = Math.max(0, ...this.msgs.map((m) => m.id));
    if (minId >= top) return { messages: [], lastId: minId, exhausted: true };
    const to = Math.min(top, minId + limit);
    return {
      messages: this.msgs.filter((m) => m.id > minId && m.id <= to).sort((a, b) => a.id - b.id),
      lastId: to,
      exhausted: to >= top,
    };
  }
}

class MemStore implements TelegramStore {
  rows = new Map<number, TelegramRecord>();
  cursor: number | null = null;
  runs: string[] = [];
  failUpsertOnce = false;
  async upsertMany(rs: TelegramRecord[]) {
    if (this.failUpsertOnce) {
      this.failUpsertOnce = false;
      throw new Error("db down");
    }
    let inserted = 0,
      updated = 0;
    for (const r of rs) {
      this.rows.has(r.messageId) ? updated++ : inserted++;
      this.rows.set(r.messageId, r);
    }
    return { inserted, updated };
  }
  async getCursor() {
    return this.cursor;
  }
  async setCursor(_: string, id: number) {
    this.cursor = id;
  }
  async startRun() {
    return 1;
  }
  async finishRun(_: number, status: string) {
    this.runs.push(status);
  }
}

const opts = {
  sourceKey: "c",
  ctx: { chatId: 1n, username: "x" },
  batchSize: 3,
  sleep: async () => {},
};

describe("syncTelegram", () => {
  it("pages through full history and is idempotent on rerun", async () => {
    const src = new FakeSource(Array.from({ length: 8 }, (_, i) => mk(i + 1)));
    const store = new MemStore();
    const a = await syncTelegram(src, store, opts);
    expect(a).toMatchObject({ fetched: 8, inserted: 8, cursor: 8 });
    const b = await syncTelegram(src, store, opts);
    expect(b.inserted).toBe(0);
    expect(store.rows.size).toBe(8);
  });
  it("picks up new messages and edits inside the rescan window", async () => {
    const src = new FakeSource([mk(1), mk(2), mk(3)]);
    const store = new MemStore();
    await syncTelegram(src, store, { ...opts, rescanWindow: 5 });
    src.msgs = [mk(1), mk(2, "edited text", new Date()), mk(3), mk(4)];
    const r = await syncTelegram(src, store, { ...opts, rescanWindow: 5 });
    expect(r.inserted).toBe(1);
    expect(store.rows.get(2)?.textOrCaption).toBe("edited text");
  });
  it("retries transient network errors without corrupting the cursor", async () => {
    const src = new FakeSource([mk(1), mk(2)]);
    src.failNext = 2;
    const store = new MemStore();
    const r = await syncTelegram(src, store, opts);
    expect(r.cursor).toBe(2);
  });
  it("keeps the old cursor if persistence fails, then resumes", async () => {
    const src = new FakeSource(Array.from({ length: 6 }, (_, i) => mk(i + 1)));
    const store = new MemStore();
    await syncTelegram(src, store, opts); // first batch ok
    store.cursor = 3; // simulate crash after batch 1
    store.rows.clear();
    store.failUpsertOnce = true;
    await expect(syncTelegram(src, store, opts)).rejects.toThrow("db down");
    expect(store.cursor).toBe(3);
    expect(store.runs.at(-1)).toBe("error");
    const r = await syncTelegram(src, store, opts);
    expect(r.cursor).toBe(6);
  });
  it("is not stopped by deleted or service messages (gaps wider than a batch)", async () => {
    // ids 4..20 do not exist (deleted/pins); the real content continues after the gap
    const src = new FakeSource([mk(1), mk(2), mk(3), mk(21), mk(22), mk(30)]);
    const store = new MemStore();
    const r = await syncTelegram(src, store, opts); // batchSize 3
    expect([...store.rows.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 21, 22, 30]);
    expect(r.cursor).toBe(30);
  });
});

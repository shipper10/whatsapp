import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LibraryPort } from "../src/bot/types.js";
import {
  FetchTooLargeError,
  type FileFetcher,
  safeFileName,
  sweepTempDir,
} from "../src/delivery/fetchers.js";
import { FileDeliverer } from "../src/delivery/fileDeliverer.js";
import { formatLinksMessage } from "../src/delivery/links.js";
import type { ResourceDetail, ResourceSourceDetail } from "../src/library/browse.js";
import { SettingsService } from "../src/settings/service.js";
import { FakeProvider, MemSettings } from "./helpers/bot.js";

const tg: ResourceSourceDetail = {
  type: "telegram",
  url: "https://t.me/BahriMed/59",
  preferred: true,
  deliveryEligible: true,
  fileName: "Sheet 7.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1000,
  telegramChatId: 1n,
  telegramMessageId: 59,
  driveFileId: null,
};
const drv: ResourceSourceDetail = {
  type: "google_drive",
  url: "https://drive.google.com/file/d/d1/view",
  preferred: false,
  deliveryEligible: true,
  fileName: "Sheet 7.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1000,
  telegramChatId: null,
  telegramMessageId: null,
  driveFileId: "d1",
};
const detail = (sources: ResourceSourceDetail[]): ResourceDetail => ({
  id: 1,
  displayName: "Sheet 7",
  path: ["Chemistry"],
  sources,
});

const lib = (d: ResourceDetail | null): LibraryPort => ({
  children: async () => [],
  node: async () => null,
  resources: async () => [],
  search: async () => [],
  recent: async () => [],
  detail: async () => d,
  indexMessage: async () => null,
  rootIndexId: async () => null,
  findIndexes: async () => [],
  messageKinds: async () => new Map(),
  messageDetail: async () => d,
});

class FakeFetcher implements FileFetcher {
  calls = 0;
  active = 0;
  maxActive = 0;
  dirs: string[] = [];
  constructor(
    readonly type: "telegram" | "google_drive",
    private mode: "ok" | "fail" | "hang" | "slow" | "toolarge" | "truncated" = "ok",
  ) {}
  canFetch(s: ResourceSourceDetail) {
    return s.type === this.type;
  }
  async fetch(s: ResourceSourceDetail, dir: string, _max: number, signal: AbortSignal) {
    this.calls++;
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.dirs.push(dir);
    try {
      if (this.mode === "fail") throw new Error("secret /path/token=abc");
      if (this.mode === "toolarge") throw new FetchTooLargeError();
      if (this.mode === "hang")
        await new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason)));
      if (this.mode === "slow") await new Promise((r) => setTimeout(r, 60));
      const path = join(dir, "Sheet 7.pdf");
      writeFileSync(path, "x");
      const size = this.mode === "truncated" ? this.calls : (s.sizeBytes ?? 1);
      return { path, fileName: "Sheet 7.pdf", mimeType: "application/pdf", sizeBytes: size };
    } finally {
      this.active--;
    }
  }
}

async function setup(
  d: ResourceDetail | null,
  fetchers: FileFetcher[],
  settings: Record<string, unknown> = {},
  concurrency = 2,
  libraryExtras: Partial<LibraryPort> = {},
  freeDisk?: () => Promise<number | null>,
) {
  const provider = new FakeProvider();
  const store = new MemSettings();
  Object.assign(store.data, settings);
  const records: { outcome: string; error?: string }[] = [];
  const tempDir = await mkdtemp(join(tmpdir(), "deliv-"));
  const deliverer = new FileDeliverer({
    library: { ...lib(d), ...libraryExtras },
    provider,
    settings: new SettingsService(store, {}, 0),
    fetchers,
    tempDir,
    concurrency,
    log: { record: async (_id, outcome, error) => void records.push({ outcome, error }) },
    logger: { warn: () => {} },
    freeDiskMb: freeDisk,
  });
  return { provider, deliverer, records, tempDir };
}
const target = { conversationId: "1@c.us" };

describe("FileDeliverer", () => {
  it("sends the file with the channel's text as caption, no extra noise, and cleans temp files", async () => {
    const f = new FakeFetcher("telegram");
    const { provider, deliverer, records, tempDir } = await setup(detail([tg, drv]), [f]);
    await deliverer.deliver(1, target);
    expect(provider.docs).toHaveLength(1);
    expect(provider.docs[0]?.fileName).toBe("Sheet 7.pdf");
    expect(provider.docs[0]?.caption).toBe(
      "Sheet 7\n\n✈️ Telegram: https://t.me/BahriMed/59\n☁️ Google Drive: https://drive.google.com/file/d/d1/view",
    );
    expect(provider.sent).toHaveLength(0); // the file carries its text; no separate links message
    expect(records).toEqual([{ outcome: "file_sent", error: undefined }]);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("falls back to links when the transfer fails, with a sanitized error and no leaked details", async () => {
    const f = new FakeFetcher("telegram", "fail");
    const { provider, deliverer, records, tempDir } = await setup(detail([tg]), [f]);
    await deliverer.deliver(1, target);
    expect(provider.docs).toHaveLength(0);
    expect(provider.last()).toContain("تعذّر إرسال الملف");
    expect(provider.last()).toContain("https://t.me/BahriMed/59");
    expect(records[0]).toEqual({ outcome: "links_only", error: "Error" });
    expect(JSON.stringify(records)).not.toContain("secret");
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("tries the second source when the first fails (Drive allowed by setting)", async () => {
    const t = new FakeFetcher("telegram", "fail");
    const g = new FakeFetcher("google_drive");
    const { provider, deliverer } = await setup(detail([tg, drv]), [t, g], {
      "delivery.driveDownload": true,
    });
    await deliverer.deliver(1, target);
    expect(t.calls).toBe(1);
    expect(g.calls).toBe(1);
    expect(provider.docs).toHaveLength(1);
  });

  it("retries once when the downloaded size differs from the source size, and falls back to links if it keeps changing", async () => {
    const f = new FakeFetcher("telegram", "truncated");
    const { provider, deliverer } = await setup(detail([{ ...tg, sizeBytes: 999 }]), [f]);
    await deliverer.deliver(1, target);
    expect(f.calls).toBeGreaterThanOrEqual(2);
    expect(provider.docs).toHaveLength(0);
    expect(provider.last()).toContain("https://t.me/BahriMed/59");
  });

  it("sends every file of a Telegram album, in order, with the caption on the first", async () => {
    const mk = (id: number, caption: string | null): ResourceDetail => ({
      ...detail([{ ...tg, telegramMessageId: id }]),
      id: 0,
      caption,
      displayName: `f${id}`,
    });
    const f = new FakeFetcher("telegram");
    const { provider, deliverer } = await setup(null, [f], { "links.telegram": false }, 2, {
      messageDetail: async (id: number) => mk(id, id === 11 ? "Exam model 1 With Answers" : null),
      albumMessageIds: async () => [10, 11, 12],
    });
    await deliverer.deliverMessage(11, target);
    expect(provider.docs).toHaveLength(3);
    expect(provider.docs[0]?.caption).toContain("Exam model 1");
    expect(provider.docs[1]?.caption ?? "").not.toContain("Exam model 1");
  });

  it("never fetches Drive content unless explicitly enabled", async () => {
    const g = new FakeFetcher("google_drive");
    const { provider, deliverer } = await setup(detail([drv]), [g]);
    await deliverer.deliver(1, target);
    expect(g.calls).toBe(0);
    expect(provider.docs).toHaveLength(0);
    expect(provider.last()).toContain("https://drive.google.com/file/d/d1/view");
  });

  it("a send that the provider did not confirm is not reported as sent", async () => {
    const f = new FakeFetcher("telegram");
    const { provider, deliverer, records } = await setup(detail([tg]), [f]);
    provider.sendDocument = async () => ({ confirmed: false, error: "HTTP 503" });
    await deliverer.deliver(1, target);
    expect(provider.last()).not.toContain("تم إرسال الملف");
    expect(provider.last()).toContain("تعذّر");
    expect(records[0]).toMatchObject({ outcome: "links_only", error: "HTTP 503" });
  });

  it("enforces size and type limits from settings without transferring anything", async () => {
    const f = new FakeFetcher("telegram");
    const big = { ...tg, sizeBytes: 5 * 1024 * 1024 };
    const a = await setup(detail([big]), [f], { "delivery.maxAttachmentMb": 1 });
    await a.deliverer.deliver(1, target);
    expect(f.calls).toBe(0);
    expect(a.provider.last()).toContain("كبير");
    expect(a.provider.last()).toContain("https://t.me/BahriMed/59");

    const b = await setup(detail([tg]), [f], { "delivery.allowedMediaTypes": ["image/*"] });
    await b.deliverer.deliver(1, target);
    expect(f.calls).toBe(0);
    expect(b.provider.last()).toContain("لا يُرسل");

    const c = await setup(detail([tg]), [f], { "delivery.sendAttachment": false });
    await c.deliverer.deliver(1, target);
    expect(f.calls).toBe(0);
    expect(c.provider.sent).toHaveLength(1); // links only, no "preparing" notice
  });

  it("an oversized unknown-size file aborted mid-transfer falls back to links", async () => {
    const f = new FakeFetcher("telegram", "toolarge");
    const { provider, deliverer } = await setup(detail([{ ...tg, sizeBytes: null }]), [f]);
    await deliverer.deliver(1, target);
    expect(provider.docs).toHaveLength(0);
    expect(provider.last()).toContain("https://t.me/BahriMed/59");
  });

  it("times out a hanging transfer and cleans up", async () => {
    const f = new FakeFetcher("telegram", "hang");
    const { provider, deliverer, tempDir, records } = await setup(detail([tg]), [f], {
      "delivery.timeoutSeconds": 1,
    });
    const t0 = Date.now();
    await deliverer.deliver(1, target);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(provider.last()).toContain("تعذّر");
    expect(records[0]?.error).toBe("Error");
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("limits parallel deliveries", async () => {
    const f = new FakeFetcher("telegram", "slow");
    const { deliverer } = await setup(detail([tg]), [f], {}, 1);
    await Promise.all([
      deliverer.deliver(1, target),
      deliverer.deliver(1, target),
      deliverer.deliver(1, target),
    ]);
    expect(f.maxActive).toBe(1);
  });

  it("missing resource or no links at all: says unavailable, never invents links", async () => {
    const a = await setup(null, []);
    await a.deliverer.deliver(1, target);
    expect(a.provider.last()).toContain("غير متاح");
    expect(a.records[0]?.outcome).toBe("unavailable");

    const b = await setup(detail([{ ...tg, url: null }]), [new FakeFetcher("telegram", "fail")]);
    await b.deliverer.deliver(1, target);
    expect(b.provider.last()).toContain("غير متاح");
    expect(b.provider.last()).not.toContain("http");
    expect(b.records[0]?.outcome).toBe("unavailable");
  });

  it("quotes the asker in groups", async () => {
    const f = new FakeFetcher("telegram");
    const { provider, deliverer } = await setup(detail([tg]), [f]);
    await deliverer.deliver(1, { conversationId: "g@g.us", quoteMessageId: "Q9" });
    expect(provider.docs[0]?.quoteMessageId).toBe("Q9");
    expect(provider.sent.every((s) => s.quoteMessageId === "Q9")).toBe(true);
  });

  it("puts the Drive link in the caption of a sent file (no follow-up links message)", async () => {
    const f = new FakeFetcher("telegram");
    const { provider, deliverer } = await setup({ ...detail([tg, drv]), caption: "📔 Sheet 7" }, [
      f,
    ]);
    await deliverer.deliverMessage(59, target);
    expect(provider.docs[0]?.caption).toContain("📔 Sheet 7");
    expect(provider.docs[0]?.caption).toContain("https://drive.google.com/file/d/d1/view");
    expect(provider.sent).toHaveLength(0);
  });

  it("shows Telegram and Drive links independently according to the settings", async () => {
    const d = { ...detail([tg, drv]), caption: "📔 Sheet 7" };
    const run = async (settings: Record<string, unknown>) => {
      const f = new FakeFetcher("telegram");
      const { provider, deliverer } = await setup(d, [f], settings);
      await deliverer.deliverMessage(59, target);
      return provider.docs[0]?.caption ?? "";
    };
    const both = await run({});
    expect(both).toContain("t.me/BahriMed/59");
    expect(both).toContain("drive.google.com");
    const noDrive = await run({ "links.drive": false });
    expect(noDrive).toContain("t.me/BahriMed/59");
    expect(noDrive).not.toContain("drive.google.com");
    const noTg = await run({ "links.telegram": false });
    expect(noTg).not.toContain("t.me");
    expect(noTg).toContain("drive.google.com");
    expect(await run({ "links.telegram": false, "links.drive": false })).toBe("📔 Sheet 7");
  });

  it("with links hidden, a failed send says so without pointing at links or claiming the file is missing", async () => {
    const f = new FakeFetcher("telegram", "fail");
    const { provider, deliverer } = await setup(detail([tg, drv]), [f], {
      "links.telegram": false,
      "links.drive": false,
    });
    await deliverer.deliver(1, target);
    const text = provider.last();
    expect(text).toContain("تعذّر إرسال الملف");
    expect(text).not.toContain("http");
    expect(text).not.toContain("غير متاح");
  });

  it("uses the Telegram text (without navigation lines or hashtags) as the caption", async () => {
    const f = new FakeFetcher("telegram");
    const d = {
      ...detail([tg]),
      caption:
        "📔 Cell Biology Sheet 3\nThe stem cell\n↩️ Return to Cell Biology Index\n#Cell_Biology #Sheet",
    };
    const { provider, deliverer } = await setup(d, [f], { "links.telegram": false });
    await deliverer.deliverMessage(59, target);
    expect(provider.docs[0]?.caption).toBe("📔 Cell Biology Sheet 3\nThe stem cell");
  });

  it("sends a text-only post as text with its link", async () => {
    const f = new FakeFetcher("telegram");
    const d = {
      ...detail([{ ...tg, mediaType: null, fileName: null }]),
      caption: "Exam is on Sunday\n#Notice",
    };
    const { provider, deliverer } = await setup(d, [f]);
    await deliverer.deliverMessage(59, target);
    expect(f.calls).toBe(0);
    expect(provider.last()).toContain("Exam is on Sunday");
    expect(provider.last()).toContain("https://t.me/BahriMed/59");
    expect(provider.last()).not.toContain("#Notice");
  });
});

describe("helpers", () => {
  it("safeFileName strips path tricks and bounds length", () => {
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName("a/b\\c:d.pdf")).toBe("a_b_c_d.pdf");
    expect(safeFileName("")).toBe("file");
    expect(safeFileName(`${"x".repeat(300)}.pdf`).length).toBeLessThanOrEqual(120);
    expect(safeFileName(`${"x".repeat(300)}.pdf`).endsWith(".pdf")).toBe(true);
  });
  it("sweepTempDir removes only old dl-* directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "sweep-"));
    await mkdir(join(root, "dl-old"));
    await mkdir(join(root, "dl-new"));
    await mkdir(join(root, "keep"));
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(root, "dl-old"), old, old);
    expect(await sweepTempDir(root, 30 * 60_000)).toBe(1);
    expect(existsSync(join(root, "dl-old"))).toBe(false);
    expect(existsSync(join(root, "dl-new"))).toBe(true);
    expect(existsSync(join(root, "keep"))).toBe(true);
  });
  it("formatLinksMessage omits missing links and dedupes identical urls", () => {
    const text = formatLinksMessage(
      detail([tg, { ...tg, preferred: false }]),
      "en",
      "not_attempted",
    );
    expect(text.match(/t\.me/g)).toHaveLength(1);
    expect(text).not.toContain("Google Drive");
  });
});

describe("load protection and reuse", () => {
  it("re-forwards a file already uploaded instead of downloading it again", async () => {
    const f = new FakeFetcher("telegram");
    const { provider, deliverer } = await setup(detail([tg]), [f]);
    await deliverer.deliver(1, target);
    await deliverer.deliver(1, { conversationId: "2@c.us" });
    expect(f.calls).toBe(1);
    expect(provider.docs).toHaveLength(1);
    expect(provider.resent).toHaveLength(1);
    expect(deliverer.stats().queued).toBe(0);
  });

  it("does not cache when the cache is off", async () => {
    const f = new FakeFetcher("telegram");
    const { provider, deliverer } = await setup(detail([tg]), [f], { "delivery.cacheHours": 0 });
    await deliverer.deliver(1, target);
    await deliverer.deliver(1, target);
    expect(f.calls).toBe(2);
    expect(provider.resent).toHaveLength(0);
  });

  it("two people asking for the same file at once cause one download", async () => {
    const f = new FakeFetcher("telegram", "slow");
    const { provider, deliverer } = await setup(detail([tg]), [f], {}, 2);
    await Promise.all([
      deliverer.deliver(1, target),
      deliverer.deliver(1, { conversationId: "2@c.us" }),
    ]);
    expect(f.calls).toBe(1);
    expect(provider.docs).toHaveLength(1);
    expect(provider.resent).toHaveLength(1);
  });

  it("sends links instead of filling the disk", async () => {
    const f = new FakeFetcher("telegram");
    const { provider, deliverer, records } = await setup(
      detail([tg]),
      [f],
      {},
      2,
      {},
      async () => 100,
    );
    await deliverer.deliver(1, target);
    expect(f.calls).toBe(0);
    expect(provider.docs).toHaveLength(0);
    expect(provider.last()).toContain("https://t.me/BahriMed/59");
    expect(records[0]).toMatchObject({ outcome: "links_only", error: "LowDisk" });
  });

  it("carries on when free space cannot be measured", async () => {
    const f = new FakeFetcher("telegram");
    const { provider, deliverer } = await setup(detail([tg]), [f], {}, 2, {}, async () => null);
    await deliverer.deliver(1, target);
    expect(provider.docs).toHaveLength(1);
  });
});

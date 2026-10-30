import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { t } from "../bot/messages.js";
import type { LibraryPort } from "../bot/types.js";
import { JobQueue } from "../core/jobQueue.js";
import { freeDiskMb } from "../core/resources.js";
import type { ResourceDetail, ResourceSourceDetail } from "../library/browse.js";
import { cleanCaption } from "../library/indexView.js";
import type { WhatsAppProvider } from "../providers/whatsapp/types.js";
import type { SettingsService } from "../settings/service.js";
import { AUDIO_INLINE_MAX, cleanAudioHeader, looksLikeAudio, splitAudio } from "./audioSplit.js";
import type { FileFetcher } from "./fetchers.js";
import { formatLinksMessage, type LinkFlags, visibleLinks } from "./links.js";
import { typeAllowed } from "./typeFilter.js";
import type { Deliverer, DeliveryTarget } from "./types.js";

export interface DeliveryLog {
  record(
    resourceId: number | null,
    outcome: "file_sent" | "links_only" | "unavailable",
    sanitizedError?: string,
  ): Promise<void>;
}

export interface FileDelivererDeps {
  library: LibraryPort;
  provider: WhatsAppProvider;
  settings: SettingsService;
  fetchers: FileFetcher[];
  log: DeliveryLog;
  tempDir: string;
  concurrency: number;
  logger: { warn: (o: object, m?: string) => void };
  /** Test hook; defaults to the real free space of the temp disk. */
  freeDiskMb?: (dir: string) => Promise<number | null>;
}

/** Short, user-safe failure label. Raw errors (paths, tokens, stack traces) never reach logs or users. */
const sanitize = (err: unknown) =>
  (err instanceof Error ? err.name || "Error" : "Error").slice(0, 60);

/**
 * Delivery sequence: try to send the real file from the best available source, then ALWAYS send the
 * verified source links (with the true attachment status). Never claims success before the provider
 * confirms, always cleans temp files, never makes Drive files public.
 */
export class FileDeliverer implements Deliverer {
  private readonly queue: JobQueue;
  /** Files being fetched right now, so a second request for the same file waits and then reuses the upload. */
  private readonly flights = new Map<string, Promise<void>>();
  constructor(private readonly d: FileDelivererDeps) {
    this.queue = new JobQueue(d.concurrency);
  }

  /** Live load figures for /status. */
  stats() {
    return {
      running: this.queue.running,
      queued: this.queue.queued,
      inflightBytes: this.queue.inflight,
      cached: this.d.provider.cacheSize?.() ?? 0,
    };
  }

  async deliver(resourceId: number, target: DeliveryTarget): Promise<void> {
    const detail = await this.d.library.detail(resourceId);
    await this.runAlbum(detail, target, resourceId);
  }

  async deliverMessage(messageId: number, target: DeliveryTarget): Promise<void> {
    const detail = await this.d.library.messageDetail(messageId);
    await this.runAlbum(detail, target, detail && detail.id > 0 ? detail.id : null);
  }

  /**
   * Telegram albums are several messages with one caption on one of them. Whichever member was asked for,
   * the whole album is sent in order, the caption riding on the first file.
   */
  private async runAlbum(
    detail: ResourceDetail | null,
    target: DeliveryTarget,
    logId: number | null,
  ): Promise<void> {
    const mid = detail?.sources.find((s) => s.type === "telegram")?.telegramMessageId ?? null;
    const ids =
      detail && mid && this.d.library.albumMessageIds
        ? await this.d.library.albumMessageIds(mid)
        : [];
    if (!detail || ids.length < 2) return this.run(detail, target, logId);

    const members: ResourceDetail[] = [];
    for (const id of ids) {
      const d = id === mid ? detail : await this.d.library.messageDetail(id);
      if (d) members.push(d);
    }
    if (members.length < 2) return this.run(detail, target, logId);
    const caption = members.find((m) => m.caption?.trim())?.caption ?? null;
    const first = members[0] as ResourceDetail;
    members[0] = {
      ...first,
      caption,
      displayName:
        first.id > 0 || !caption
          ? first.displayName
          : (
              cleanCaption(caption)
                .split("\n")
                .find((l) => l.trim()) ?? first.displayName
            ).slice(0, 120),
    };
    target.progress?.expand?.(members.length - 1);
    // The caption travels once, on the first file; the others are labelled by their file names.
    for (const [i, m] of members.entries()) {
      await this.run(
        i === 0 ? m : { ...m, caption: null, displayName: m.displayName },
        target,
        logId,
      );
    }
  }

  private async run(
    detail: ResourceDetail | null,
    target: DeliveryTarget,
    logId: number | null,
  ): Promise<void> {
    const lang = await this.d.settings.get("bot.language");
    const flags: LinkFlags = {
      telegram: await this.d.settings.get("links.telegram"),
      drive: await this.d.settings.get("links.drive"),
    };
    if (!detail) {
      await this.d.provider.sendText({
        conversationId: target.conversationId,
        text: t("unavailable", lang),
        quoteMessageId: target.quoteMessageId,
      });
      await this.d.log.record(logId, "unavailable", "resource not found");
      return;
    }

    // A text-only post (announcement, note): the text itself is the content.
    const textOnly =
      detail.sources.length > 0 &&
      detail.sources.every(
        (s) => s.type === "telegram" && !s.mediaType && s.mediaType !== undefined,
      );
    if (textOnly) {
      const body = cleanCaption(detail.caption ?? "", 3500) || detail.displayName;
      const link = visibleLinks(detail, flags).find((l) => l.type === "telegram")?.url;
      await this.d.provider.sendText({
        conversationId: target.conversationId,
        text: link ? `${body}\n\n✈️ ${link}` : body,
        quoteMessageId: target.quoteMessageId,
      });
      await this.d.log.record(logId, "links_only");
      return;
    }

    let status: Parameters<typeof formatLinksMessage>[2] = "not_attempted";
    let error: string | undefined;
    if (await this.d.settings.get("delivery.sendAttachment")) {
      const caption = buildCaption(detail, flags);
      const first = detail.sources.find((x) => x.deliveryEligible);
      target.progress?.file(first?.fileName ?? detail.displayName, first?.sizeBytes ?? null);
      this.queue.setBudget((await this.d.settings.get("delivery.maxInflightMb")) * 1024 * 1024);
      const r = await this.queue.run(
        () => this.tryAttachment(detail, target, caption),
        (pos) => target.progress?.queued(pos),
        first?.sizeBytes ?? 0,
      );
      status = r.status;
      error = r.error;
      target.progress?.fileDone(status === "sent");
    }

    // When the file went through, it already carries its text; extra messages would only add noise.
    if (status !== "sent") {
      await this.d.provider.sendText({
        conversationId: target.conversationId,
        text: formatLinksMessage(detail, lang, status, flags),
        quoteMessageId: target.quoteMessageId,
      });
    }
    const hasLinks = detail.sources.some((s) => s.url);
    await this.d.log.record(
      logId,
      status === "sent" ? "file_sent" : hasLinks ? "links_only" : "unavailable",
      error,
    );
  }

  private async tryAttachment(
    detail: ResourceDetail,
    target: DeliveryTarget,
    caption: string,
  ): Promise<{
    status: "sent" | "failed" | "not_attempted" | "too_large" | "type_blocked";
    error?: string;
  }> {
    const [maxMb, allowed, timeoutS, driveOn, audioMode, splitAudioOn, lang, partMb] =
      await Promise.all([
        this.d.settings.get("delivery.maxAttachmentMb"),
        this.d.settings.get("delivery.allowedMediaTypes"),
        this.d.settings.get("delivery.timeoutSeconds"),
        this.d.settings.get("delivery.driveDownload"),
        this.d.settings.get("delivery.audioMode"),
        this.d.settings.get("delivery.splitLargeAudio"),
        this.d.settings.get("bot.language"),
        this.d.settings.get("delivery.audioPartMb"),
      ]);
    const maxBytes = maxMb * 1024 * 1024;

    const candidates: { src: ResourceSourceDetail; fetcher: FileFetcher }[] = [];
    for (const src of [...detail.sources].sort(
      (a, b) => Number(b.preferred) - Number(a.preferred),
    )) {
      if (!src.deliveryEligible) continue;
      if (src.type === "google_drive" && !driveOn) continue;
      const fetcher = this.d.fetchers.find((f) => f.type === src.type && f.canFetch(src));
      if (fetcher) candidates.push({ src, fetcher });
    }
    if (candidates.length === 0) return { status: "not_attempted" };

    // Policy checks use declared metadata, before any transfer.
    const usable = candidates.filter(
      (c) => c.src.sizeBytes === null || c.src.sizeBytes <= maxBytes,
    );
    if (usable.length === 0) return { status: "too_large" };
    const typeOk = usable.filter((c) => typeAllowed(c.src.mimeType, c.src.fileName, allowed));
    if (typeOk.length === 0) return { status: "type_blocked" };

    // Audio over WhatsApp's 16 MB limit cannot be opened by the recipient: split it, or give links only.
    if (
      !splitAudioOn &&
      typeOk.every(
        (c) =>
          looksLikeAudio(c.src.mimeType, c.src.fileName ?? "") &&
          (c.src.sizeBytes ?? 0) > AUDIO_INLINE_MAX,
      )
    )
      return { status: "too_large" };

    // A file we uploaded recently is re-forwarded inside WhatsApp: no download, no upload.
    const top = typeOk[0] as (typeof typeOk)[number];
    const ttlMs = (await this.d.settings.get("delivery.cacheHours")) * 3600_000;
    const key = ttlMs > 0 ? cacheKeyOf(top.src) : null;
    let release = () => {};
    const done = () => {
      release();
      if (key && this.flights.get(key) === mine) this.flights.delete(key);
    };
    let mine: Promise<void> | undefined;
    if (key) {
      // Registered before any await, so a second request for the same file always sees this one.
      const prev = this.flights.get(key);
      mine = new Promise<void>((r) => {
        release = r;
      });
      this.flights.set(key, mine);
      await prev;
      const hit = await this.d.provider
        .sendCached?.({
          conversationId: target.conversationId,
          cache: { key, ttlMs },
          caption,
          quoteMessageId: target.quoteMessageId,
        })
        .catch(() => null);
      if (hit?.confirmed) {
        done();
        return { status: "sent" };
      }
    }
    try {
      return await this.transfer(typeOk, {
        target,
        caption,
        maxBytes,
        timeoutS,
        audioMode,
        splitAudioOn,
        lang,
        partMb,
        cache: key ? { key, ttlMs } : undefined,
      });
    } finally {
      if (key) done();
    }
  }

  private async transfer(
    typeOk: { src: ResourceSourceDetail; fetcher: FileFetcher }[],
    o: {
      target: DeliveryTarget;
      caption: string;
      maxBytes: number;
      timeoutS: number;
      audioMode: "audio" | "document";
      splitAudioOn: boolean;
      lang: "ar" | "en";
      partMb: number;
      cache?: { key: string; ttlMs: number };
    },
  ): Promise<{ status: "sent" | "failed" | "too_large"; error?: string }> {
    const { target, caption, maxBytes, timeoutS, audioMode, splitAudioOn, lang, partMb } = o;
    // Without a progress reporter, big files at least get a one-line heads-up.
    if (!target.progress && (typeOk[0]?.src.sizeBytes ?? 0) > 8 * 1024 * 1024) {
      await this.d.provider.sendText({
        conversationId: target.conversationId,
        text: waitNotice(await this.d.settings.get("bot.language")),
        quoteMessageId: target.quoteMessageId,
      });
    }

    let lastError: string | undefined;
    for (const { src, fetcher } of typeOk.slice(0, 2)) {
      // Disk guard: never start a download that would leave the disk (nearly) full.
      const minFree = await this.d.settings.get("delivery.minFreeDiskMb");
      if (minFree > 0) {
        await mkdir(this.d.tempDir, { recursive: true });
        const free = await (this.d.freeDiskMb ?? freeDiskMb)(this.d.tempDir);
        const need = (src.sizeBytes ?? 0) / (1024 * 1024) + minFree;
        if (free !== null && free < need) {
          this.d.logger.warn({ freeMb: free, needMb: Math.round(need) }, "low disk, sending links");
          lastError = "LowDisk";
          break;
        }
      }
      const dir = await mkdtemp(join(this.d.tempDir, "dl-"));
      const ctl = new AbortController();
      // Stall timeout: the clock restarts whenever bytes arrive, so a big file that keeps flowing is fine.
      let timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutS * 1000);
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutS * 1000);
      };
      try {
        target.progress?.downloading(0, src.sizeBytes);
        const download = () =>
          fetcher.fetch(src, dir, maxBytes, ctl.signal, (done, total) => {
            arm();
            target.progress?.downloading(done, total ?? src.sizeBytes);
          });
        let file = await download();
        // Integrity: the byte count must match what the source says. One retry; if the second copy has the
        // same size as the first, the stored size was stale and the file itself is fine.
        if (src.sizeBytes !== null && file.sizeBytes !== src.sizeBytes) {
          this.d.logger.warn(
            { source: src.type, expected: src.sizeBytes, got: file.sizeBytes },
            "download size mismatch, retrying once",
          );
          const again = await download();
          if (again.sizeBytes !== file.sizeBytes) throw new Error("IncompleteDownload");
          file = again;
        }
        clearTimeout(timer);
        if (looksLikeAudio(file.mimeType, file.fileName) && file.sizeBytes > AUDIO_INLINE_MAX) {
          if (!splitAudioOn) return { status: "too_large" };
          return await this.sendAudioParts(file, dir, caption, target, audioMode, lang, partMb);
        }
        // Opus files with a huge tags block (cover art) are unplayable on WhatsApp; send a cleaned copy.
        const cleaned = looksLikeAudio(file.mimeType, file.fileName)
          ? await cleanAudioHeader(file.path, file.fileName, dir).catch(() => null)
          : null;
        await target.progress?.uploading();
        const res = await this.d.provider.sendDocument({
          conversationId: target.conversationId,
          filePath: cleaned ?? file.path,
          fileName: file.fileName,
          mimeType: file.mimeType,
          caption,
          quoteMessageId: target.quoteMessageId,
          audioAsDocument: audioMode === "document",
          onUploadProgress: (sent, total) => target.progress?.uploadProgress?.(sent, total),
          cache: o.cache,
        });
        if (res.confirmed) return { status: "sent" };
        lastError = res.error ?? "SendNotConfirmed";
      } catch (err) {
        lastError = sanitize(ctl.signal.aborted ? new Error("Timeout") : err);
        this.d.logger.warn({ source: src.type, error: lastError }, "attachment transfer failed");
      } finally {
        clearTimeout(timer);
        await rm(dir, { recursive: true, force: true });
      }
    }
    return { status: "failed", error: lastError };
  }

  /** Audio over the inline limit: an explanation, then the parts in order (cut without re-encoding). */
  private async sendAudioParts(
    file: { path: string; fileName: string; mimeType: string },
    dir: string,
    caption: string,
    target: DeliveryTarget,
    audioMode: "audio" | "document",
    lang: "ar" | "en",
    partMb: number,
  ): Promise<{ status: "sent" | "failed" | "too_large"; error?: string }> {
    const split = await splitAudio(file.path, file.fileName, dir, partMb * 1000 * 1000).catch(
      () => null,
    );
    if (!split) return { status: "too_large" };
    const n = split.files.length;
    await this.d.provider.sendText({
      conversationId: target.conversationId,
      text: `${caption}\n\n${splitNotice(lang, n)}`,
      quoteMessageId: target.quoteMessageId,
    });
    for (const [i, path] of split.files.entries()) {
      await target.progress?.uploading();
      const res = await this.d.provider.sendDocument({
        conversationId: target.conversationId,
        filePath: path,
        fileName: basename(path),
        mimeType: file.mimeType,
        caption: partLabel(lang, i + 1, n),
        quoteMessageId: target.quoteMessageId,
        audioAsDocument: audioMode === "document",
        onUploadProgress: (sent, total) => target.progress?.uploadProgress?.(sent, total),
      });
      if (!res.confirmed) return { status: "failed", error: res.error ?? "SendNotConfirmed" };
    }
    return { status: "sent" };
  }
}

const splitNotice = (l: "ar" | "en", n: number) =>
  l === "ar"
    ? `✂️ هذا المقطع أكبر من حد واتساب للصوت (16 ميغابايت)، فأُرسل مقسومًا إلى ${n} أجزاء بالترتيب. للحصول عليه كاملًا في ملف واحد استخدم الروابط أعلاه.`
    : `✂️ This audio is over WhatsApp's 16 MB limit, so it is sent as ${n} parts in order. For the full file in one piece use the links above.`;
const partLabel = (l: "ar" | "en", i: number, n: number) =>
  l === "ar" ? `🎧 الجزء ${i} من ${n}` : `🎧 Part ${i} of ${n}`;

/** The channel's text plus whichever source links the admin allows; a sent file gets no follow-up message. */
export function buildCaption(detail: ResourceDetail, flags: LinkFlags): string {
  const links = visibleLinks(detail, flags);
  const tail = links
    .map((l) => `${l.type === "telegram" ? "✈️ Telegram" : "☁️ Google Drive"}: ${l.url}`)
    .join("\n");
  const room = Math.max(0, 1000 - (tail ? tail.length + 2 : 0));
  const base = cleanCaption(detail.caption ?? "", room) || detail.displayName.slice(0, room);
  return tail ? `${base}\n\n${tail}` : base;
}

const waitNotice = (l: "ar" | "en") =>
  l === "ar" ? "⏳ جاري تجهيز الملف…" : "⏳ Preparing the file…";

/** Identifies the exact stored file (source + id + size) so a changed file is never served from the cache. */
function cacheKeyOf(src: ResourceSourceDetail): string | null {
  if (src.type === "telegram" && src.telegramChatId !== null && src.telegramMessageId !== null)
    return `tg:${src.telegramChatId}:${src.telegramMessageId}:${src.sizeBytes ?? 0}`;
  if (src.type === "google_drive" && src.driveFileId)
    return `drive:${src.driveFileId}:${src.sizeBytes ?? 0}`;
  return null;
}

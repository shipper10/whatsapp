import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { t } from "../bot/messages.js";
import type { LibraryPort } from "../bot/types.js";
import { Semaphore } from "../core/concurrency.js";
import type { ResourceDetail, ResourceSourceDetail } from "../library/browse.js";
import { cleanCaption } from "../library/indexView.js";
import type { WhatsAppProvider } from "../providers/whatsapp/types.js";
import type { SettingsService } from "../settings/service.js";
import type { FileFetcher } from "./fetchers.js";
import { formatLinksMessage } from "./links.js";
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
}

const mimeAllowed = (mime: string | null, allowed: string[]) =>
  allowed.length === 0 ||
  (mime !== null &&
    allowed.some((a) => (a.endsWith("/*") ? mime.startsWith(a.slice(0, -1)) : mime === a)));

/** Short, user-safe failure label. Raw errors (paths, tokens, stack traces) never reach logs or users. */
const sanitize = (err: unknown) =>
  (err instanceof Error ? err.name || "Error" : "Error").slice(0, 60);

/**
 * Delivery sequence: try to send the real file from the best available source, then ALWAYS send the
 * verified source links (with the true attachment status). Never claims success before the provider
 * confirms, always cleans temp files, never makes Drive files public.
 */
export class FileDeliverer implements Deliverer {
  private readonly gate: Semaphore;
  constructor(private readonly d: FileDelivererDeps) {
    this.gate = new Semaphore(d.concurrency);
  }

  async deliver(resourceId: number, target: DeliveryTarget): Promise<void> {
    await this.run(await this.d.library.detail(resourceId), target, resourceId);
  }

  async deliverMessage(messageId: number, target: DeliveryTarget): Promise<void> {
    const detail = await this.d.library.messageDetail(messageId);
    await this.run(detail, target, detail && detail.id > 0 ? detail.id : null);
  }

  private async run(
    detail: ResourceDetail | null,
    target: DeliveryTarget,
    logId: number | null,
  ): Promise<void> {
    const lang = await this.d.settings.get("bot.language");
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
      const link = detail.sources.find((s) => s.url)?.url;
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
      const driveUrls = [
        ...new Set(
          detail.sources.filter((x) => x.type === "google_drive" && x.url).map((x) => x.url),
        ),
      ];
      const base = cleanCaption(detail.caption ?? "", 800) || detail.displayName;
      // A sent file gets no follow-up links message, so its Drive copy is listed in the caption.
      const caption = driveUrls.length
        ? `${base}\n\n☁️ Google Drive: ${driveUrls.join("\n")}`
        : base;
      const r = await this.gate.run(() => this.tryAttachment(detail, target, caption));
      status = r.status;
      error = r.error;
    }

    // When the file went through, it already carries its text; extra messages would only add noise.
    if (status !== "sent") {
      await this.d.provider.sendText({
        conversationId: target.conversationId,
        text: formatLinksMessage(detail, lang, status),
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
    const [maxMb, allowed, timeoutS, driveOn] = await Promise.all([
      this.d.settings.get("delivery.maxAttachmentMb"),
      this.d.settings.get("delivery.allowedMediaTypes"),
      this.d.settings.get("delivery.timeoutSeconds"),
      this.d.settings.get("delivery.driveDownload"),
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
    const typeOk = usable.filter((c) => mimeAllowed(c.src.mimeType, allowed));
    if (typeOk.length === 0) return { status: "type_blocked" };

    // Only slow transfers deserve a heads-up; for small files it is just noise.
    if ((typeOk[0]?.src.sizeBytes ?? 0) > 8 * 1024 * 1024) {
      await this.d.provider.sendText({
        conversationId: target.conversationId,
        text: waitNotice(await this.d.settings.get("bot.language")),
        quoteMessageId: target.quoteMessageId,
      });
    }

    let lastError: string | undefined;
    for (const { src, fetcher } of typeOk.slice(0, 2)) {
      const dir = await mkdtemp(join(this.d.tempDir, "dl-"));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutS * 1000);
      try {
        const file = await fetcher.fetch(src, dir, maxBytes, ctl.signal);
        const res = await this.d.provider.sendDocument({
          conversationId: target.conversationId,
          filePath: file.path,
          fileName: file.fileName,
          mimeType: file.mimeType,
          caption,
          quoteMessageId: target.quoteMessageId,
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
}

const waitNotice = (l: "ar" | "en") =>
  l === "ar" ? "⏳ جاري تجهيز الملف…" : "⏳ Preparing the file…";

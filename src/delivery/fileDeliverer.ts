import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { t } from "../bot/messages.js";
import type { LibraryPort } from "../bot/types.js";
import { Semaphore } from "../core/concurrency.js";
import type { ResourceDetail, ResourceSourceDetail } from "../library/browse.js";
import type { WhatsAppProvider } from "../providers/whatsapp/types.js";
import type { SettingsService } from "../settings/service.js";
import type { FileFetcher } from "./fetchers.js";
import { formatLinksMessage } from "./links.js";
import type { Deliverer, DeliveryTarget } from "./types.js";

export interface DeliveryLog {
  record(
    resourceId: number,
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
    const lang = await this.d.settings.get("bot.language");
    const detail = await this.d.library.detail(resourceId);
    if (!detail) {
      await this.d.provider.sendText({
        conversationId: target.conversationId,
        text: t("unavailable", lang),
        quoteMessageId: target.quoteMessageId,
      });
      await this.d.log.record(resourceId, "unavailable", "resource not found");
      return;
    }

    let status: Parameters<typeof formatLinksMessage>[2] = "not_attempted";
    let error: string | undefined;
    if (await this.d.settings.get("delivery.sendAttachment")) {
      const r = await this.gate.run(() => this.tryAttachment(detail, target));
      status = r.status;
      error = r.error;
    }

    const hasLinks = detail.sources.some((s) => s.url);
    await this.d.provider.sendText({
      conversationId: target.conversationId,
      text: formatLinksMessage(detail, lang, status),
      quoteMessageId: target.quoteMessageId,
    });
    await this.d.log.record(
      resourceId,
      status === "sent" ? "file_sent" : hasLinks ? "links_only" : "unavailable",
      error,
    );
  }

  private async tryAttachment(
    detail: ResourceDetail,
    target: DeliveryTarget,
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

    await this.d.provider.sendText({
      conversationId: target.conversationId,
      text: waitNotice(await this.d.settings.get("bot.language")),
      quoteMessageId: target.quoteMessageId,
    });

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

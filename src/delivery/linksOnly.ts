import { t } from "../bot/messages.js";
import type { LibraryPort } from "../bot/types.js";
import type { WhatsAppProvider } from "../providers/whatsapp/types.js";
import type { SettingsService } from "../settings/service.js";
import { formatLinksMessage } from "./links.js";
import type { Deliverer, DeliveryTarget } from "./types.js";

/** Phase-3 deliverer: sends the verified Telegram/Drive links. File attachment delivery builds on this. */
export class LinksOnlyDeliverer implements Deliverer {
  constructor(
    private readonly library: LibraryPort,
    private readonly provider: WhatsAppProvider,
    private readonly settings: SettingsService,
  ) {}

  async deliver(resourceId: number, target: DeliveryTarget) {
    await this.send(await this.library.detail(resourceId), target);
  }

  async deliverMessage(messageId: number, target: DeliveryTarget) {
    await this.send(await this.library.messageDetail(messageId), target);
  }

  private async send(detail: Awaited<ReturnType<LibraryPort["detail"]>>, target: DeliveryTarget) {
    const lang = await this.settings.get("bot.language");
    const text = detail
      ? formatLinksMessage(detail, lang, "not_attempted")
      : t("unavailable", lang);
    await this.provider.sendText({
      conversationId: target.conversationId,
      text,
      quoteMessageId: target.quoteMessageId,
    });
  }
}

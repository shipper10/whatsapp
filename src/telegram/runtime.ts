import type { TelegramMediaDownloader } from "../delivery/telegramFetcher.js";
import { type GramJsConfig, GramJsSource } from "./gramjsSource.js";
import type { RawTelegramMessage, TelegramSource } from "./types.js";

/**
 * One shared, lazily connected Telegram client for sync and for delivery downloads.
 * Any failure drops the connection so the next call reconnects cleanly.
 */
export class TelegramRuntime implements TelegramSource, TelegramMediaDownloader {
  private src: GramJsSource | null = null;
  private connecting: Promise<GramJsSource> | null = null;

  constructor(private readonly cfg: GramJsConfig) {}

  private async ensure(): Promise<GramJsSource> {
    if (this.src) return this.src;
    this.connecting ??= (async () => {
      const s = new GramJsSource(this.cfg);
      await s.connect();
      this.src = s;
      return s;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async reset() {
    const s = this.src;
    this.src = null;
    await s?.disconnect().catch(() => undefined);
  }

  /** Channel identity, available after the first successful connection. */
  async identity(): Promise<{ chatId: bigint; username: string | null }> {
    const s = await this.ensure();
    return { chatId: s.chatId as bigint, username: s.username };
  }

  async fetchBatch(opts: {
    minId: number;
    maxId?: number;
    limit: number;
  }): Promise<RawTelegramMessage[]> {
    const s = await this.ensure();
    try {
      return await s.fetchBatch(opts);
    } catch (err) {
      await this.reset();
      throw err;
    }
  }

  async downloadMedia(messageId: number, destPath: string, maxBytes: number): Promise<void> {
    const s = await this.ensure();
    try {
      await s.downloadMedia(messageId, destPath, maxBytes);
    } catch (err) {
      if ((err as Error).name !== "Error" || !/size limit/.test((err as Error).message))
        await this.reset();
      throw err;
    }
  }

  async close() {
    await this.reset();
  }
}

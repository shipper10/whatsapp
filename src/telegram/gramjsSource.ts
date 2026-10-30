import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { FetchTooLargeError } from "../delivery/fetchers.js";
import type { RawBatch, RawEntity, RawMedia, RawTelegramMessage, TelegramSource } from "./types.js";

export interface GramJsConfig {
  apiId: number;
  apiHash: string;
  sessionString: string;
  channel: string; // username or numeric id
}

function toEntities(msg: Api.Message): RawEntity[] {
  return (msg.entities ?? []).map((e): RawEntity => {
    if (e instanceof Api.MessageEntityHashtag)
      return { type: "hashtag", offset: e.offset, length: e.length };
    if (e instanceof Api.MessageEntityTextUrl)
      return { type: "text_link", offset: e.offset, length: e.length, url: e.url };
    if (e instanceof Api.MessageEntityUrl)
      return { type: "url", offset: e.offset, length: e.length };
    return { type: "other", offset: e.offset, length: e.length };
  });
}

function toMedia(msg: Api.Message): RawMedia | undefined {
  const m = msg.media;
  if (!m) return undefined;
  if (m instanceof Api.MessageMediaPhoto) return { kind: "photo" };
  if (m instanceof Api.MessageMediaDocument && m.document instanceof Api.Document) {
    const doc = m.document;
    const fileName = doc.attributes.find(
      (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
    )?.fileName;
    const kind = doc.attributes.some((a) => a instanceof Api.DocumentAttributeAudio)
      ? "audio"
      : doc.attributes.some((a) => a instanceof Api.DocumentAttributeVideo)
        ? "video"
        : "document";
    return { kind, fileName, mimeType: doc.mimeType, sizeBytes: Number(doc.size) };
  }
  return { kind: "other" };
}

/** Production source: reads channel metadata over MTProto. Does not download media. */
export class GramJsSource implements TelegramSource {
  private client: TelegramClient;
  private entity: Api.TypeInputPeer | null = null;
  /** Numeric channel id and public username, known after connect(). */
  chatId: bigint | null = null;
  username: string | null = null;

  constructor(private readonly cfg: GramJsConfig) {
    this.client = new TelegramClient(new StringSession(cfg.sessionString), cfg.apiId, cfg.apiHash, {
      connectionRetries: 5,
    });
  }

  async connect() {
    await this.client.connect();
    if (!(await this.client.checkAuthorization())) {
      throw new Error("Telegram session is not authorized. Run `npm run telegram:login` again.");
    }
    this.entity = await this.client.getInputEntity(this.cfg.channel);
    const full = await this.client.getEntity(this.cfg.channel);
    this.chatId = BigInt(String((full as { id: { toString(): string } }).id));
    this.username =
      (full as { username?: string }).username ??
      (/^-?\d+$/.test(this.cfg.channel) ? null : this.cfg.channel);
  }

  async disconnect() {
    await this.client.disconnect();
  }

  private toRaw(m: Api.Message): RawTelegramMessage {
    return {
      id: m.id,
      date: new Date(m.date * 1000),
      editDate: m.editDate ? new Date(m.editDate * 1000) : undefined,
      text: m.message ?? "",
      entities: toEntities(m),
      media: toMedia(m),
      groupedId: m.groupedId ? String(m.groupedId) : undefined,
    };
  }

  async fetchByIds(ids: number[]): Promise<RawTelegramMessage[]> {
    if (!this.entity) throw new Error("GramJsSource.connect() not called");
    const out: RawTelegramMessage[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const msgs = await this.client.getMessages(this.entity, { ids: ids.slice(i, i + 100) });
      for (const m of msgs) if (m instanceof Api.Message) out.push(this.toRaw(m));
    }
    return out;
  }

  /** Id of the newest message in the channel (0 when empty). */
  private async topId(): Promise<number> {
    if (!this.entity) throw new Error("GramJsSource.connect() not called");
    const [latest] = await this.client.getMessages(this.entity, { limit: 1 });
    return latest?.id ?? 0;
  }

  /**
   * Reads an explicit id window. Asking for ids (instead of "newer than X, N at a time") makes the result
   * independent of deleted messages and service/pin messages, which used to end a sync early.
   */
  async fetchBatch(opts: { minId: number; limit: number }): Promise<RawBatch> {
    if (!this.entity) throw new Error("GramJsSource.connect() not called");
    const top = await this.topId();
    const from = opts.minId + 1;
    if (from > top) return { messages: [], lastId: opts.minId, exhausted: true };
    const to = Math.min(top, opts.minId + Math.min(opts.limit, 100));
    const ids = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const msgs = await this.client.getMessages(this.entity, { ids });
    const messages = msgs
      .filter((m): m is Api.Message => m instanceof Api.Message)
      .map((m) => this.toRaw(m))
      .sort((a, b) => a.id - b.id);
    return { messages, lastId: to, exhausted: to >= top };
  }

  /**
   * Downloads one message's media to `destPath`. Checks the declared size first so oversized files
   * are never transferred. Used only for delivery, never for indexing.
   */
  async downloadMedia(
    messageId: number,
    destPath: string,
    maxBytes: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    if (!this.entity) throw new Error("GramJsSource.connect() not called");
    const [msg] = await this.client.getMessages(this.entity, { ids: [messageId] });
    if (!(msg instanceof Api.Message) || !msg.media) throw new Error("message has no media");
    const media = toMedia(msg);
    if (media?.sizeBytes !== undefined && media.sizeBytes > maxBytes)
      throw new FetchTooLargeError();
    await this.client.downloadMedia(msg, {
      outputFile: destPath,
      progressCallback: onProgress
        ? (downloaded: { toString(): string }, total: { toString(): string }) =>
            onProgress(Number(downloaded.toString()), Number(total.toString()))
        : undefined,
    });
  }
}

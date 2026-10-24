import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { RawEntity, RawMedia, RawTelegramMessage, TelegramSource } from "./types.js";

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
  }

  async disconnect() {
    await this.client.disconnect();
  }

  async fetchBatch(opts: {
    minId: number;
    maxId?: number;
    limit: number;
  }): Promise<RawTelegramMessage[]> {
    if (!this.entity) throw new Error("GramJsSource.connect() not called");
    const msgs = await this.client.getMessages(this.entity, {
      minId: opts.minId,
      maxId: opts.maxId ?? 0,
      limit: opts.limit,
      reverse: true, // ascending by id
    });
    return msgs
      .filter((m): m is Api.Message => m instanceof Api.Message)
      .map((m) => ({
        id: m.id,
        date: new Date(m.date * 1000),
        editDate: m.editDate ? new Date(m.editDate * 1000) : undefined,
        text: m.message ?? "",
        entities: toEntities(m),
        media: toMedia(m),
      }))
      .sort((a, b) => a.id - b.id);
  }
}

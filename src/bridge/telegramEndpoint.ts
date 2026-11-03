import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Api, TelegramClient } from "teleproto";
import { NewMessage, type NewMessageEvent } from "teleproto/events";
import { StringSession } from "teleproto/sessions";
import type {
  BridgeEndpoint,
  BridgeMessage,
  ChatInfo,
  Destination,
  MessageType,
  OutgoingBridge,
} from "./types.js";
import { extFor } from "./whatsappEndpoint.js";

export interface TelegramBridgeConfig {
  apiId: number;
  apiHash: string;
  /** A dedicated user session (npm run telegram:login). Never share it with the library-sync session. */
  sessionString: string;
}

interface Logger {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

const id = (x: unknown) => String((x as { toString(): string }).toString());

/** Telegram -> neutral type. Voice notes and stickers are told apart from plain audio/images. */
export function telegramType(m: Api.Message): MessageType {
  const media = m.media;
  if (!media) return "text";
  if (media instanceof Api.MessageMediaPhoto) return "image";
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaVenue)
    return "location";
  if (media instanceof Api.MessageMediaContact) return "contact";
  if (media instanceof Api.MessageMediaPoll) return "poll";
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const a = media.document.attributes;
    if (a.some((x) => x instanceof Api.DocumentAttributeSticker)) return "sticker";
    const audio = a.find(
      (x): x is Api.DocumentAttributeAudio => x instanceof Api.DocumentAttributeAudio,
    );
    if (audio) return audio.voice ? "voice" : "audio";
    if (a.some((x) => x instanceof Api.DocumentAttributeVideo)) return "video";
    return "document";
  }
  return "text";
}

/** Telegram user session used by the bridge: listens for new messages, lists chats/topics and sends. */
export class TelegramBridgeEndpoint implements BridgeEndpoint {
  readonly platform = "telegram" as const;
  private client: TelegramClient | null = null;
  private started = false;

  constructor(
    private readonly cfg: TelegramBridgeConfig,
    private readonly logger: Logger,
    private readonly onMessage: (m: BridgeMessage) => Promise<void>,
  ) {}

  ready() {
    return this.started;
  }

  async start() {
    const client = new TelegramClient(
      new StringSession(this.cfg.sessionString),
      this.cfg.apiId,
      this.cfg.apiHash,
      { connectionRetries: 5 },
    );
    await client.connect();
    if (!(await client.checkAuthorization()))
      throw new Error("Bridge Telegram session is not authorized. Run `npm run telegram:login`.");
    this.client = client;
    client.addEventHandler((e: NewMessageEvent) => {
      void this.handle(e).catch((err) =>
        this.logger.error({ err: String(err) }, "bridge: telegram message failed"),
      );
    }, new NewMessage({}));
    this.started = true;
    this.logger.info({}, "bridge: Telegram connected");
  }

  async stop() {
    this.started = false;
    await this.client?.disconnect().catch(() => undefined);
    this.client = null;
  }

  private async handle(e: NewMessageEvent) {
    const m = e.message;
    if (!m || !this.client) return;
    const chat = await m.getChat().catch(() => undefined);
    const sender = (await m.getSender().catch(() => undefined)) as
      | (Api.User & { title?: string })
      | undefined;
    const peerId = m.chatId ?? m.peerId;
    const chatId = id(peerId);
    const type = telegramType(m);
    const topicId = m.replyTo?.forumTopic
      ? id(m.replyTo.replyToTopId ?? m.replyTo.replyToMsgId ?? "")
      : undefined;
    const name =
      [sender?.firstName, sender?.lastName].filter(Boolean).join(" ") || sender?.title || "";
    const geo =
      m.media instanceof Api.MessageMediaGeo
        ? m.media.geo
        : m.media instanceof Api.MessageMediaVenue
          ? m.media.geo
          : undefined;
    const client = this.client;
    const msg: BridgeMessage = {
      platform: "telegram",
      chatId,
      topicId: topicId || undefined,
      messageId: String(m.id),
      chatTitle: (chat as { title?: string } | undefined)?.title ?? name,
      senderId: id(m.senderId ?? ""),
      senderName: name,
      senderPhone: sender?.phone ?? undefined,
      senderUsername: sender?.username ?? undefined,
      savedName: sender?.contact ? name || undefined : undefined,
      type,
      text:
        type === "sticker" &&
        m.media instanceof Api.MessageMediaDocument &&
        m.media.document instanceof Api.Document
          ? (m.media.document.attributes.find(
              (a): a is Api.DocumentAttributeSticker => a instanceof Api.DocumentAttributeSticker,
            )?.alt ?? "")
          : (m.message ?? ""),
      fileName:
        m.media instanceof Api.MessageMediaDocument && m.media.document instanceof Api.Document
          ? m.media.document.attributes.find(
              (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
            )?.fileName
          : undefined,
      mimeType: this.mimeOf(m),
      location: geo instanceof Api.GeoPoint ? { lat: geo.lat, lng: geo.long } : undefined,
      contact:
        m.media instanceof Api.MessageMediaContact
          ? {
              name: `${m.media.firstName} ${m.media.lastName}`.trim(),
              phone: m.media.phoneNumber,
            }
          : undefined,
      poll:
        m.media instanceof Api.MessageMediaPoll
          ? {
              question: String(
                (m.media.poll.question as { text?: string }).text ?? m.media.poll.question,
              ),
              options: m.media.poll.answers.map((a) =>
                String((a.text as { text?: string }).text ?? a.text),
              ),
            }
          : undefined,
      replyToId: m.replyTo?.replyToMsgId ? String(m.replyTo.replyToMsgId) : undefined,
      timestamp: m.date,
      fromMe: !!m.out,
      downloadMedia: ["text", "location", "contact", "poll"].includes(type)
        ? undefined
        : async (dir) => {
            await mkdir(dir, { recursive: true });
            const out = await client.downloadMedia(m, {
              outputFile: join(dir, `tg-${m.id}.${extFor(this.mimeOf(m), undefined)}`),
            });
            if (typeof out !== "string") throw new Error("download returned no file");
            return out;
          },
    };
    await this.onMessage(msg);
  }

  private mimeOf(m: Api.Message): string | undefined {
    return m.media instanceof Api.MessageMediaDocument && m.media.document instanceof Api.Document
      ? m.media.document.mimeType
      : m.media instanceof Api.MessageMediaPhoto
        ? "image/jpeg"
        : undefined;
  }

  async send(dest: Destination, out: OutgoingBridge): Promise<string | undefined> {
    if (!this.client) throw new Error("Telegram bridge not connected");
    const entity = await this.client.getInputEntity(dest.chatId);
    const replyTo = out.replyToId
      ? Number(out.replyToId)
      : dest.topicId
        ? Number(dest.topicId)
        : undefined;
    const common = {
      replyTo,
      ...(dest.topicId && out.replyToId ? { topMsgId: Number(dest.topicId) } : {}),
    };
    let sent: Api.Message;
    if (out.filePath) {
      sent = await this.client.sendFile(entity, {
        file: out.filePath,
        caption: out.text,
        voiceNote: out.type === "voice",
        forceDocument: out.type === "document",
        attributes: out.fileName
          ? [new Api.DocumentAttributeFilename({ fileName: out.fileName })]
          : undefined,
        ...common,
      });
    } else if (out.type === "location" && out.location) {
      sent = await this.client.sendFile(entity, {
        file: new Api.InputMediaGeoPoint({
          geoPoint: new Api.InputGeoPoint({ lat: out.location.lat, long: out.location.lng }),
        }),
        caption: out.text,
        ...common,
      });
    } else {
      sent = await this.client.sendMessage(entity, { message: out.text, ...common });
    }
    return sent?.id !== undefined ? String(sent.id) : undefined;
  }

  async listChats(): Promise<ChatInfo[]> {
    if (!this.client) return [];
    const out: ChatInfo[] = [];
    for (const d of await this.client.getDialogs({ limit: 500 })) {
      const e: unknown = d.entity;
      if (!d.id || !e) continue;
      const chatId = id(d.id);
      const isChannel = e instanceof Api.Channel;
      const kind = !isChannel
        ? e instanceof Api.User
          ? "private"
          : "group"
        : e.broadcast
          ? "channel"
          : e.forum
            ? "forum"
            : "supergroup";
      const title = d.title || d.name || chatId;
      out.push({ platform: "telegram", chatId, title, kind });
      if (isChannel && e.forum) {
        try {
          const res = await this.client.invoke(
            new Api.messages.GetForumTopics({
              peer: await this.client.getInputEntity(d.id),
              offsetDate: 0,
              offsetId: 0,
              offsetTopic: 0,
              limit: 100,
            }),
          );
          for (const t of res.topics)
            if (t instanceof Api.ForumTopic)
              out.push({
                platform: "telegram",
                chatId,
                topicId: String(t.id),
                title: t.title,
                kind: "topic",
                parentId: chatId,
              });
        } catch (err) {
          this.logger.warn({ err: String(err), chatId }, "bridge: listing topics failed");
        }
      }
    }
    return out;
  }
}

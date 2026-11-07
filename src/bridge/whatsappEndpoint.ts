import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnyMessageContent, WAMessage } from "@whiskeysockets/baileys";
import { BufferJSON, jidNormalizedUser, normalizeMessageContent } from "@whiskeysockets/baileys";
import { planMedia } from "../providers/whatsapp/baileys/media.js";
import type { BaileysProvider } from "../providers/whatsapp/baileys/provider.js";
import type {
  AlbumItem,
  BridgeEndpoint,
  BridgeMessage,
  BridgeReaction,
  ChatInfo,
  Destination,
  MessageType,
  OutgoingBridge,
} from "./types.js";

/** Protocol-level content that is never a user message. */
const IGNORED_KINDS = new Set([
  "messageContextInfo",
  "senderKeyDistributionMessage",
  "protocolMessage",
  "reactionMessage",
  "keepInChatMessage",
  "pollUpdateMessage",
  "encReactionMessage",
  "deviceSentMessage",
  "albumMessage",
]);
const toSeconds = (t: unknown): number => {
  if (typeof t === "number") return t;
  if (typeof t === "string" && /^\d+$/.test(t)) return Number(t);
  const o = t as { low?: number; high?: number; toNumber?: () => number } | undefined;
  if (o?.toNumber) return o.toNumber();
  if (typeof o?.low === "number") return o.low + (o.high ?? 0) * 2 ** 32;
  return Math.floor(Date.now() / 1000);
};
const PN = "@s.whatsapp.net";
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/x-tgsticker": "tgs",
  "video/webm": "webm",
  "application/pdf": "pdf",
};
export const extFor = (mime?: string, name?: string) =>
  /\.([a-z0-9]{1,6})$/i.exec(name ?? "")?.[1] ??
  MIME_EXT[(mime ?? "").split(";")[0]?.trim() ?? ""] ??
  "bin";

const digits = (jid?: string | null) =>
  jid?.endsWith(PN) ? jid.split("@")[0]?.split(":")[0] : undefined;

/** Every contextInfo of a (normalised) message: replies and mentions live there, whatever the message kind. */
const contextOf = (
  c: Record<string, any>,
): { stanzaId?: string; mentionedJid?: string[] } | undefined => {
  for (const k of [
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "ptvMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage",
    "locationMessage",
    "liveLocationMessage",
    "contactMessage",
    "pollCreationMessage",
    "pollCreationMessageV3",
  ]) {
    const ci = c[k]?.contextInfo;
    if (ci) return ci;
  }
  return undefined;
};

/** Everyone @mentioned in a message (JIDs, possibly LIDs). */
export const mentionedOf = (m: WAMessage): string[] => {
  const c = normalizeMessageContent(m.message) as Record<string, any> | null | undefined;
  return (c && contextOf(c)?.mentionedJid) || [];
};

/** WhatsApp writes "@<number>" in the text for a mention; show "@Name" instead (the number is often a LID, not a phone). */
export function applyMentions(
  text: string,
  jids: string[],
  nameOf: (jid: string) => string | undefined,
): string {
  let out = text;
  for (const jid of jids) {
    const user = jid.split("@")[0]?.split(":")[0];
    if (!user) continue;
    const label = nameOf(jid) ?? (jid.endsWith(PN) ? `+${user}` : "someone");
    out = out.replace(new RegExp(`@${user}(?!\\d)`, "g"), () => `@${label}`);
  }
  return out;
}

/** WhatsApp message -> neutral. View-once wrappers are unwrapped by Baileys, so they are handled as normal media. */
export function whatsappToBridge(
  m: WAMessage,
  titleOf: (jid: string) => string,
  download: (m: WAMessage) => Promise<Buffer>,
  savedName?: (jids: (string | undefined)[]) => string | undefined,
  mentionName?: (jid: string) => string | undefined,
): BridgeMessage | null {
  const key = m.key;
  const chat = key?.remoteJid;
  if (!key?.id || !chat) return null;
  if (!chat.endsWith("@g.us") && !chat.endsWith(PN) && !chat.endsWith("@lid")) return null;
  const c = normalizeMessageContent(m.message) as Record<string, any> | null | undefined;
  if (!c) return null;

  let type: MessageType | null = null;
  let text = "";
  let fileName: string | undefined;
  let mimeType: string | undefined;
  let location: BridgeMessage["location"];
  let contact: BridgeMessage["contact"];
  let poll: BridgeMessage["poll"];

  if (c.imageMessage) {
    type = "image";
    text = c.imageMessage.caption ?? "";
    mimeType = c.imageMessage.mimetype;
  } else if (c.videoMessage) {
    type = "video";
    text = c.videoMessage.caption ?? "";
    mimeType = c.videoMessage.mimetype;
  } else if (c.ptvMessage) {
    type = "video";
    mimeType = c.ptvMessage.mimetype;
  } else if (c.audioMessage) {
    type = c.audioMessage.ptt ? "voice" : "audio";
    mimeType = c.audioMessage.mimetype;
  } else if (c.documentMessage) {
    type = "document";
    text = c.documentMessage.caption ?? "";
    fileName = c.documentMessage.fileName;
    mimeType = c.documentMessage.mimetype;
  } else if (c.stickerMessage) {
    type = "sticker";
    mimeType = c.stickerMessage.mimetype;
  } else if (c.locationMessage) {
    type = "location";
    location = {
      lat: c.locationMessage.degreesLatitude,
      lng: c.locationMessage.degreesLongitude,
      name: c.locationMessage.name ?? undefined,
    };
    text = c.locationMessage.name ?? "";
  } else if (c.liveLocationMessage) {
    type = "location";
    location = {
      lat: c.liveLocationMessage.degreesLatitude,
      lng: c.liveLocationMessage.degreesLongitude,
    };
    text = c.liveLocationMessage.caption ?? "";
  } else if (c.contactMessage) {
    type = "contact";
    const phone = /waid=(\d+)/.exec(c.contactMessage.vcard ?? "")?.[1];
    contact = { name: c.contactMessage.displayName ?? "", phone };
  } else if (c.pollCreationMessage || c.pollCreationMessageV3) {
    type = "poll";
    const p = c.pollCreationMessage ?? c.pollCreationMessageV3;
    poll = {
      question: p.name ?? "",
      options: (p.options ?? []).map((o: { optionName?: string }) => o.optionName ?? ""),
    };
  } else if (c.conversation !== undefined || c.extendedTextMessage) {
    // Text goes last: a media message must never be mistaken for an empty text.
    type = "text";
    text = c.conversation ?? c.extendedTextMessage?.text ?? "";
  }
  if (!type) return null;
  const ctx = contextOf(c);
  const mentioned = ctx?.mentionedJid ?? [];
  if (text && mentioned.length)
    text = applyMentions(text, mentioned, mentionName ?? (() => undefined));

  const isGroup = chat.endsWith("@g.us");
  const senderJid = isGroup
    ? ((key.participantAlt as string | undefined) ?? key.participant ?? "")
    : ((key.remoteJidAlt as string | undefined) ?? chat);
  const assoc = (
    m.message as
      | { messageContextInfo?: { messageAssociation?: { parentMessageKey?: { id?: string } } } }
      | undefined
  )?.messageContextInfo?.messageAssociation;
  const albumId =
    type === "image" || type === "video" ? (assoc?.parentMessageKey?.id ?? undefined) : undefined;
  const mediaTypes: MessageType[] = ["image", "video", "audio", "voice", "document", "sticker"];
  return {
    platform: "whatsapp",
    chatId: chat,
    messageId: key.id,
    chatTitle: titleOf(chat),
    senderId: senderJid ? jidNormalizedUser(senderJid) : "",
    senderName: m.pushName ?? "",
    savedName: savedName?.([
      senderJid || undefined,
      key.participant ?? undefined,
      key.participantAlt as string | undefined,
      key.remoteJidAlt as string | undefined,
      isGroup ? undefined : chat,
    ]),
    senderPhone: digits(senderJid),
    type,
    text,
    fileName,
    mimeType,
    location,
    contact,
    poll,
    replyToId: ctx?.stanzaId ?? undefined,
    timestamp: toSeconds(m.messageTimestamp),
    albumId,
    ref: { raw: JSON.stringify(m, BufferJSON.replacer) },
    fromMe: !!key.fromMe,
    downloadMedia: mediaTypes.includes(type)
      ? async (dir) => {
          await mkdir(dir, { recursive: true });
          const path = join(dir, `wa-${key.id}.${extFor(mimeType, fileName)}`);
          await writeFile(path, await download(m));
          return path;
        }
      : undefined,
  };
}

/** The bridge's view of the linked WhatsApp account. */
export class WhatsAppBridgeEndpoint implements BridgeEndpoint {
  readonly platform = "whatsapp" as const;
  private titles = new Map<string, string>();

  constructor(
    private readonly wa: BaileysProvider,
    private readonly onMessage: (m: BridgeMessage) => Promise<void>,
    private readonly onError: (err: unknown) => void,
    /** Called for messages that carry content the bridge does not recognise (so it is visible, not silent). */
    private readonly onUnrecognised?: (chat: string, kinds: string[]) => void,
    private readonly hooks: {
      onEdit?: (m: BridgeMessage, editKey: string) => Promise<void>;
      onDelete?: (chatId: string | undefined, messageId: string) => Promise<void>;
      onReaction?: (r: BridgeReaction) => Promise<void>;
    } = {},
  ) {}

  /** Name of a chat: its group subject, or for a private chat the person's name (else their number). */
  private titleOf = (jid: string) =>
    this.titles.get(jid) ??
    this.wa.displayNameOf(jid) ??
    (jid.endsWith(PN) ? `+${jid.split("@")[0]}` : jid);

  private mentionName = (jid: string) => {
    const phone = this.wa.phoneOf(jid);
    return (
      this.wa.displayNameOf(jid, phone ? `${phone}${PN}` : undefined) ??
      (phone ? `+${phone}` : undefined)
    );
  };

  private toBridge(m: WAMessage): BridgeMessage | null {
    return whatsappToBridge(
      m,
      this.titleOf,
      (x) => this.wa.downloadBuffer(x),
      (jids) => this.wa.savedNameOf(...jids),
      this.mentionName,
    );
  }

  /** Looks up the phone numbers behind the LIDs a message mentions, so names/numbers can be shown. */
  private async warm(m: WAMessage) {
    await this.wa
      .warmPhones([...mentionedOf(m), m.key?.participant, m.key?.remoteJid])
      .catch(() => undefined);
  }

  /** Wire this to BaileysDeps.onRawReaction. */
  tapReaction = (
    list: { key: WAMessage["key"]; reaction: { text?: string | null; key?: WAMessage["key"] } }[],
  ) => {
    for (const { key, reaction } of list) {
      if (!key?.id || !key.remoteJid) continue;
      const by = reaction.key;
      const sender = by?.participant ?? by?.remoteJid ?? "";
      const fromMe = !!by?.fromMe;
      void this.hooks
        .onReaction?.({
          platform: "whatsapp",
          chatId: key.remoteJid,
          messageId: key.id,
          emoji: reaction.text ?? "",
          senderId: sender,
          senderName: fromMe
            ? ""
            : (this.wa.displayNameOf(sender, by?.participantAlt as string | undefined) ?? ""),
          fromMe,
        })
        ?.catch(this.onError);
    }
  };

  async react(dest: Destination, messageId: string, emoji: string): Promise<boolean> {
    return this.wa.sendReaction(dest.chatId, messageId, emoji);
  }

  /** Wire this to BaileysDeps.onRawUpdate: edits and "delete for everyone" arrive as message updates. */
  tapUpdate = (updates: { key: WAMessage["key"]; update: Partial<WAMessage> }[]) => {
    for (const { key, update } of updates) {
      if (!key?.id || !key.remoteJid) continue;
      if (update.messageStubType === 1 /* REVOKE */) {
        void this.hooks.onDelete?.(key.remoteJid, key.id)?.catch(this.onError);
        continue;
      }
      const edited = (
        update.message as { editedMessage?: { message?: unknown } } | null | undefined
      )?.editedMessage?.message;
      if (edited) {
        const raw = {
          key,
          message: edited,
          pushName: this.wa.recentMessage(key.id)?.pushName,
          messageTimestamp: update.messageTimestamp,
        } as unknown as WAMessage;
        void this.warm(raw)
          .then(() => {
            const msg = this.toBridge(raw);
            if (msg) return this.hooks.onEdit?.(msg, String(toSeconds(update.messageTimestamp)));
          })
          .catch(this.onError);
      }
    }
  };

  /** Rebuilds a message after a restart from the raw copy stored with a queued job. */
  async rehydrate(ref: unknown): Promise<BridgeMessage | null> {
    const raw = (ref as { raw?: string } | null)?.raw;
    if (!raw) return null;
    return this.toBridge(JSON.parse(raw, BufferJSON.reviver) as WAMessage);
  }

  async edit(dest: Destination, messageId: string, out: OutgoingBridge): Promise<boolean> {
    // WhatsApp can edit text, but not the caption of a picture/video/document.
    if (out.type !== "text") return false;
    return this.wa.editText(dest.chatId, messageId, out.text);
  }

  async remove(dest: Destination, messageId: string): Promise<boolean> {
    return this.wa.deleteMessage(dest.chatId, messageId);
  }

  async sendAlbum(dest: Destination, items: AlbumItem[], replyToId?: string): Promise<string[]> {
    return this.wa.sendAlbum(
      dest.chatId,
      items.map((i) => ({ type: i.type, path: i.filePath, caption: i.text })),
      replyToId,
    );
  }

  /** Wire this to BaileysDeps.onRawMessage. */
  tap = (m: WAMessage) => {
    void this.process(m).catch(this.onError);
  };

  private async process(m: WAMessage) {
    await this.warm(m);
    const msg = this.toBridge(m);
    if (msg) {
      if (msg.type === "text" && !msg.text.trim() && msg.chatId) {
        const keys = Object.keys((normalizeMessageContent(m.message) as object | undefined) ?? {});
        this.onUnrecognised?.(msg.chatId, [`empty text`, ...keys]);
      }
      await this.onMessage(msg);
      return;
    }
    // WhatsApp no longer sends the content of a view-once message to linked devices: only an empty
    // "unavailable" stub arrives. Say so, instead of staying silent (the real content, if the phone
    // answers the placeholder request, comes later as an ordinary message).
    if (!m.message && (m.key as { isViewOnce?: boolean }).isViewOnce) {
      const notice = this.toBridge({
        ...m,
        key: { ...m.key, id: `${m.key.id}:viewonce` },
        message: {
          conversation:
            "👁 View-once message — WhatsApp does not deliver its content to linked devices. Open it on the phone.",
        },
      } as WAMessage);
      if (notice) await this.onMessage(notice);
      return;
    }
    const kinds = Object.keys(
      (normalizeMessageContent(m.message) as object | undefined) ?? {},
    ).filter((k) => !IGNORED_KINDS.has(k));
    if (!m.message && m.key?.remoteJid)
      kinds.push(`no content (stub ${m.messageStubType ?? "none"})`);
    if (kinds.length && m.key?.remoteJid && !m.key.remoteJid.endsWith("@broadcast"))
      this.onUnrecognised?.(m.key.remoteJid, kinds);
  }

  ready() {
    return this.wa.status().state === "open";
  }

  async send(dest: Destination, out: OutgoingBridge): Promise<string | undefined> {
    let content: AnyMessageContent;
    if (out.type === "location" && out.location) {
      content = {
        location: {
          degreesLatitude: out.location.lat,
          degreesLongitude: out.location.lng,
          name: out.location.name,
        },
      };
    } else if (out.filePath) {
      const size = (await stat(out.filePath)).size;
      const source = { url: out.filePath };
      if (out.type === "document") {
        content = {
          document: source,
          mimetype: out.mimeType ?? "application/octet-stream",
          fileName: out.fileName ?? out.filePath.split("/").pop() ?? "file",
          caption: out.text || undefined,
        };
      } else if (out.type === "voice") {
        content = { audio: source, mimetype: "audio/ogg; codecs=opus", ptt: true };
      } else if (out.type === "sticker") {
        content = { sticker: source };
      } else {
        const plan = planMedia({
          filePath: out.filePath,
          fileName: out.fileName ?? out.filePath.split("/").pop() ?? "file",
          mimeType: out.mimeType,
          caption: out.text || undefined,
          sizeBytes: size,
        });
        content = plan.content;
        if (plan.followUpText) {
          const res = await this.wa.sendBridge(dest.chatId, content, out.replyToId);
          if (!res.confirmed) throw new Error(res.error ?? "send failed");
          await this.wa.sendBridge(dest.chatId, { text: plan.followUpText });
          return res.providerMessageId;
        }
      }
      if (out.type === "voice" && out.text) {
        const res = await this.wa.sendBridge(dest.chatId, content, out.replyToId);
        if (!res.confirmed) throw new Error(res.error ?? "send failed");
        await this.wa.sendBridge(dest.chatId, { text: out.text });
        return res.providerMessageId;
      }
    } else {
      content = { text: out.text };
    }
    const res = await this.wa.sendBridge(dest.chatId, content, out.replyToId);
    if (!res.confirmed) throw new Error(res.error ?? "send failed");
    return res.providerMessageId;
  }

  async listChats(): Promise<ChatInfo[]> {
    const out: ChatInfo[] = [];
    for (const g of await this.wa.groups()) {
      this.titles.set(g.id, g.subject);
      out.push({
        platform: "whatsapp",
        chatId: g.id,
        title: g.subject,
        kind: g.isCommunity
          ? "community"
          : g.isCommunityAnnounce
            ? "community-announcements"
            : "group",
        parentId: g.linkedParent,
      });
    }
    return out;
  }
}

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnyMessageContent, WAMessage } from "@whiskeysockets/baileys";
import { jidNormalizedUser, normalizeMessageContent } from "@whiskeysockets/baileys";
import { planMedia } from "../providers/whatsapp/baileys/media.js";
import type { BaileysProvider } from "../providers/whatsapp/baileys/provider.js";
import type {
  BridgeEndpoint,
  BridgeMessage,
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
]);
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

/** WhatsApp message -> neutral. View-once wrappers are unwrapped by Baileys, so they are handled as normal media. */
export function whatsappToBridge(
  m: WAMessage,
  titleOf: (jid: string) => string,
  download: (m: WAMessage) => Promise<Buffer>,
  savedName?: (jids: (string | undefined)[]) => string | undefined,
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
  let ctx: { stanzaId?: string } | undefined;

  if (c.imageMessage) {
    type = "image";
    text = c.imageMessage.caption ?? "";
    mimeType = c.imageMessage.mimetype;
    ctx = c.imageMessage.contextInfo;
  } else if (c.videoMessage) {
    type = "video";
    text = c.videoMessage.caption ?? "";
    mimeType = c.videoMessage.mimetype;
    ctx = c.videoMessage.contextInfo;
  } else if (c.ptvMessage) {
    type = "video";
    mimeType = c.ptvMessage.mimetype;
    ctx = c.ptvMessage.contextInfo;
  } else if (c.audioMessage) {
    type = c.audioMessage.ptt ? "voice" : "audio";
    mimeType = c.audioMessage.mimetype;
    ctx = c.audioMessage.contextInfo;
  } else if (c.documentMessage) {
    type = "document";
    text = c.documentMessage.caption ?? "";
    fileName = c.documentMessage.fileName;
    mimeType = c.documentMessage.mimetype;
    ctx = c.documentMessage.contextInfo;
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
    ctx = c.extendedTextMessage?.contextInfo;
  }
  if (!type) return null;

  const isGroup = chat.endsWith("@g.us");
  const senderJid = isGroup
    ? ((key.participantAlt as string | undefined) ?? key.participant ?? "")
    : ((key.remoteJidAlt as string | undefined) ?? chat);
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
    timestamp:
      typeof m.messageTimestamp === "number"
        ? m.messageTimestamp
        : Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000)),
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
  ) {}

  /** Wire this to BaileysDeps.onRawMessage. */
  tap = (m: WAMessage) => {
    const msg = whatsappToBridge(
      m,
      (jid) => this.titles.get(jid) ?? jid,
      (x) => this.wa.downloadBuffer(x),
      (jids) => this.wa.savedNameOf(...jids),
    );
    if (msg) {
      if (msg.type === "text" && !msg.text.trim() && msg.chatId) {
        const keys = Object.keys((normalizeMessageContent(m.message) as object | undefined) ?? {});
        this.onUnrecognised?.(msg.chatId, [`empty text`, ...keys]);
      }
      void this.onMessage(msg).catch(this.onError);
      return;
    }
    const kinds = Object.keys(
      (normalizeMessageContent(m.message) as object | undefined) ?? {},
    ).filter((k) => !IGNORED_KINDS.has(k));
    if (!m.message && m.key?.remoteJid)
      kinds.push(`no content (stub ${m.messageStubType ?? "none"})`);
    if (kinds.length && m.key?.remoteJid && !m.key.remoteJid.endsWith("@broadcast"))
      this.onUnrecognised?.(m.key.remoteJid, kinds);
  };

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

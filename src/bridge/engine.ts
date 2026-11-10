import type { BridgeMessage, BridgeRule, OutgoingBridge } from "./types.js";

/** Source meaning "every private WhatsApp chat" (one Telegram topic per person). */
export const PRIVATE_CHATS = "@private";
/** Source topic meaning "any topic of this group" (the reply path of a private-chats rule). */
export const ANY_TOPIC = "@any";
/** Destination of a reply rule: the person that owns the topic, looked up from the private-chats rule `id`. */
export const contactRef = (id: number) => `@contact:${id}`;
export const isContactRef = (v: string) => v.startsWith("@contact:");
export const contactRuleId = (v: string) => Number(v.slice("@contact:".length));

const isPrivateChat = (msg: BridgeMessage) =>
  msg.platform === "whatsapp" &&
  !msg.chatId.endsWith("@g.us") &&
  !msg.chatId.endsWith("@newsletter") &&
  !msg.chatId.endsWith("@broadcast");

/** May this message go on to the person? Reply paths take my own messages and whoever the rule lists. */
export function mayReply(r: Pick<BridgeRule, "allowedSenders">, msg: BridgeMessage): boolean {
  if (msg.fromMe) return true;
  const list = r.allowedSenders.trim();
  if (list === "*") return true;
  const mine = (v?: string) => (v ?? "").trim().replace(/^@/, "").toLowerCase();
  return list
    .split(/[\s,;]+/)
    .map(mine)
    .filter(Boolean)
    .some((x) => x === mine(msg.senderId) || x === mine(msg.senderUsername));
}

/** Does the rule read from this message's chat/topic (filters on type and sender not considered)? */
function sourceMatches(r: BridgeRule, msg: BridgeMessage): boolean {
  if (!r.enabled || r.srcPlatform !== msg.platform) return false;
  if ((r.srcAccountId ?? 0) !== (msg.accountId ?? 0)) return false;
  const chatOk = r.srcChatId === PRIVATE_CHATS ? isPrivateChat(msg) : r.srcChatId === msg.chatId;
  if (!chatOk) return false;
  if (r.srcTopicId === "") return true;
  return r.srcTopicId === ANY_TOPIC ? !!msg.topicId : r.srcTopicId === (msg.topicId ?? "");
}

/** Rules that apply to this message. Disabled rules and types the rule did not select never match. */
export function matchRules(msg: BridgeMessage, rules: BridgeRule[]): BridgeRule[] {
  return rules.filter(
    (r) =>
      sourceMatches(r, msg) &&
      (r.forwardOwn || !msg.fromMe) &&
      (!isContactRef(r.dstChatId) || mayReply(r, msg)) &&
      r.types.includes(msg.type),
  );
}

/** Enabled rules whose source chat/topic is this message's chat, whatever their filters say. */
export function rulesForChat(msg: BridgeMessage, rules: BridgeRule[]): BridgeRule[] {
  return rules.filter((r) => sourceMatches(r, msg));
}

/** Why a rule on this chat does not forward the message (undefined when it does). */
export function skipReason(msg: BridgeMessage, rule: BridgeRule): string | undefined {
  if (!rule.forwardOwn && msg.fromMe)
    return "message written by my own account (turned off in this rule)";
  if (isContactRef(rule.dstChatId) && !mayReply(rule, msg))
    return `${msg.senderName || "someone"} (id ${msg.senderId}${msg.senderUsername ? `, @${msg.senderUsername}` : ""}) is not allowed to reply — add them in this rule's “Who can reply” box`;
  if (!rule.types.includes(msg.type)) return `type "${msg.type}" is not selected in this rule`;
  return undefined;
}

const TYPE_LABEL: Record<string, string> = {
  contact: "👤 Contact",
  poll: "📊 Poll",
  sticker: "🏷 Sticker",
  location: "📍 Location",
};

/** "Name (+phone)" header according to the rule's sender mode; the phone only when asked for and exposed. */
export function senderLabel(
  msg: BridgeMessage,
  rule: Pick<BridgeRule, "senderMode" | "customName" | "showPhone" | "dstChatId" | "replyPath">,
) {
  // Someone else answering through my account: the person on WhatsApp must know who is writing.
  if ((rule.replyPath || isContactRef(rule.dstChatId)) && !msg.fromMe)
    return msg.senderName || msg.senderUsername || "";
  if (rule.senderMode === "none") return "";
  const fallback = msg.senderUsername || msg.senderId;
  const name =
    rule.senderMode === "custom" && rule.customName.trim()
      ? rule.customName.trim()
      : rule.senderMode === "profile"
        ? msg.senderName || msg.savedName || fallback
        : msg.savedName || msg.senderName || fallback;
  const phone =
    rule.showPhone && msg.senderPhone ? ` (+${msg.senderPhone.replace(/\D/g, "")})` : "";
  return `${name}${phone}`;
}

/** Builds what is sent to the destination, including text-only fallbacks for types with no native send. */
export function buildOutgoing(
  msg: BridgeMessage,
  rule: BridgeRule,
  replyToId?: string,
  filePath?: string,
): OutgoingBridge {
  const who = senderLabel(msg, rule);
  const head = who ? `${who}:` : "";
  const join = (...parts: (string | undefined)[]) => parts.filter((p) => p?.trim()).join("\n");

  switch (msg.type) {
    case "text":
      return { type: "text", text: join(head, msg.text), replyToId };
    case "location":
      return {
        type: "location",
        text: head,
        location: msg.location,
        replyToId,
      };
    case "contact":
      return {
        type: "text",
        text: join(
          head,
          `${TYPE_LABEL.contact}: ${msg.contact?.name ?? ""}`,
          msg.contact?.phone ? `+${msg.contact.phone.replace(/\D/g, "")}` : undefined,
        ),
        replyToId,
      };
    case "poll":
      return {
        type: "text",
        text: join(
          head,
          `${TYPE_LABEL.poll}: ${msg.poll?.question ?? ""}`,
          ...(msg.poll?.options ?? []).map((o, i) => `${i + 1}. ${o}`),
        ),
        replyToId,
      };
    case "sticker":
      // Stickers cannot carry a caption on either platform: the sender goes out as its own line.
      return { type: "sticker", text: head, filePath, mimeType: msg.mimeType, replyToId };
    default:
      return {
        type: msg.type,
        text: join(head, msg.text),
        filePath,
        fileName: msg.fileName,
        mimeType: msg.mimeType,
        replyToId,
      };
  }
}

export const isMediaType = (t: BridgeMessage["type"]) =>
  ["image", "video", "document", "audio", "voice", "sticker"].includes(t);

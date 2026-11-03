import type { BridgeMessage, BridgeRule, OutgoingBridge } from "./types.js";

/** Rules that apply to this message. Disabled rules and types the rule did not select never match. */
export function matchRules(msg: BridgeMessage, rules: BridgeRule[]): BridgeRule[] {
  return rules.filter(
    (r) =>
      r.enabled &&
      (r.forwardOwn || !msg.fromMe) &&
      r.srcPlatform === msg.platform &&
      r.srcChatId === msg.chatId &&
      (r.srcTopicId === "" || r.srcTopicId === (msg.topicId ?? "")) &&
      r.types.includes(msg.type),
  );
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
  rule: Pick<BridgeRule, "senderMode" | "customName" | "showPhone">,
) {
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

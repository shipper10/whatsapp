import type { WAMessage } from "@whiskeysockets/baileys";
import { normalizeMessageContent } from "@whiskeysockets/baileys";
import type { IncomingMessage } from "../types.js";

const PN = "@s.whatsapp.net";

const toNumber = (t: unknown): number => {
  if (typeof t === "number") return t;
  if (t && typeof (t as { toNumber?: () => number }).toNumber === "function")
    return (t as { toNumber: () => number }).toNumber();
  return Math.floor(Date.now() / 1000);
};

/** Prefer a phone-number JID (stable, comparable with ADMIN_IDS) over a privacy `@lid`. */
const preferPhone = (...ids: (string | null | undefined)[]): string => {
  const present = ids.filter((x): x is string => !!x);
  return present.find((x) => x.endsWith(PN)) ?? present[0] ?? "";
};

/**
 * Maps a Baileys message to the neutral IncomingMessage, or null for anything the bot ignores
 * (own messages, status/broadcast/newsletter, non-text). In groups the participant is the real sender,
 * never the group; if it cannot be determined participantId is "" and the session layer refuses.
 */
export function extractIncoming(
  m: WAMessage,
): (IncomingMessage & { replyToParticipant?: string }) | null {
  const key = m.key;
  if (!key || key.fromMe || !key.remoteJid || !key.id) return null;
  const chat = key.remoteJid;
  const isGroup = chat.endsWith("@g.us");
  if (!isGroup && !chat.endsWith(PN) && !chat.endsWith("@lid")) return null;

  const content = normalizeMessageContent(m.message);
  const text = (content?.conversation ?? content?.extendedTextMessage?.text ?? "").trim();
  if (!text) return null;

  const participantId = isGroup
    ? preferPhone(key.participantAlt, key.participant)
    : preferPhone(key.remoteJidAlt, chat);
  return {
    provider: "baileys",
    conversationId: chat,
    participantId,
    isGroup,
    messageId: key.id,
    text,
    timestamp: toNumber(m.messageTimestamp),
    fromMe: false,
    mentionedIds: content?.extendedTextMessage?.contextInfo?.mentionedJid ?? [],
    replyToMessageId: content?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
    replyToParticipant: content?.extendedTextMessage?.contextInfo?.participant ?? undefined,
  };
}

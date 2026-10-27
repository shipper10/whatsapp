import type {
  OutgoingDocument,
  OutgoingText,
  SendResult,
  WhatsAppProvider,
} from "../providers/whatsapp/types.js";

const MAX = 3000;

function remember(map: Map<string, string>, key: string, value: string) {
  map.set(key, value);
  if (map.size > MAX) map.delete(map.keys().next().value as string);
}

/**
 * Remembers who each of the bot's group messages was an answer to. The bot quotes the asker's message in
 * every group reply, so the quote id tells us the asker; replying to that bot message later only counts
 * when the replier is the same person. Everyone else has to use the prefix.
 */
export class ReplyTracker {
  private askerByIncoming = new Map<string, string>();
  private askerByBotMessage = new Map<string, string>();

  noteIncoming(messageId: string, participantId: string) {
    remember(this.askerByIncoming, messageId, participantId);
  }

  askerOf(botMessageId: string): string | undefined {
    return this.askerByBotMessage.get(botMessageId);
  }

  private track(quoteId: string | undefined, res: SendResult) {
    const asker = quoteId ? this.askerByIncoming.get(quoteId) : undefined;
    if (asker && res.providerMessageId)
      remember(this.askerByBotMessage, res.providerMessageId, asker);
  }

  /** Use the returned provider everywhere the bot sends (handler and file delivery). */
  wrap(inner: WhatsAppProvider): WhatsAppProvider {
    const wrapped: WhatsAppProvider = {
      name: inner.name,
      sendText: async (m: OutgoingText) => {
        const res = await inner.sendText(m);
        this.track(m.quoteMessageId, res);
        return res;
      },
      sendDocument: async (m: OutgoingDocument) => {
        const res = await inner.sendDocument(m);
        this.track(m.quoteMessageId, res);
        return res;
      },
    };
    if (inner.editText)
      wrapped.editText = (c, id, text) => inner.editText?.(c, id, text) ?? Promise.resolve(false);
    return wrapped;
  }
}

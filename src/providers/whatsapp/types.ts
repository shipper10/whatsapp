/**
 * Provider-neutral WhatsApp contract. Bot logic depends only on this file.
 * Implementations (OpenWA today; Cloud API / direct Baileys later) live next to it.
 */
export interface IncomingMessage {
  provider: string;
  /** Private chat id or group id. */
  conversationId: string;
  /** The real sender. For private chats equals conversationId. Never the group id. */
  participantId: string;
  isGroup: boolean;
  /** Provider message id, used for quoting replies and idempotency. */
  messageId: string;
  text: string;
  timestamp: number;
  fromMe: boolean;
  mentionedIds: string[];
  /** Id of the message this one replies to, when the provider reports it. */
  replyToMessageId?: string;
  /** True when that quoted message was sent by this bot's own account. */
  replyToFromMe?: boolean;
}

export interface OutgoingText {
  conversationId: string;
  text: string;
  /** Quote the asker's message (used in groups). */
  quoteMessageId?: string;
}

export interface OutgoingDocument {
  conversationId: string;
  filePath: string;
  fileName: string;
  mimeType?: string;
  caption?: string;
  quoteMessageId?: string;
}

export interface SendResult {
  /** True only after the provider confirmed acceptance. */
  confirmed: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  sendText(msg: OutgoingText): Promise<SendResult>;
  sendDocument(msg: OutgoingDocument): Promise<SendResult>;
  /** Whether a message id was sent by this bot (lets groups treat replies to the bot as addressed to it). */
  isOwnMessage?(messageId: string): boolean;
}

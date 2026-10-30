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
  /** Send audio files as attachments rather than playable audio messages. */
  audioAsDocument?: boolean;
  /** Ogg/Opus goes as an attachment renamed to .mp3 (name change only). */
  opusAsMp3?: boolean;
  /** Called about once a second while the file is being uploaded to WhatsApp. */
  onUploadProgress?: (sentBytes: number, totalBytes: number) => void;
  /** When set, a confirmed send is remembered under this key so it can be re-sent without uploading. */
  cache?: { key: string; ttlMs: number };
}

/** Re-sends a file this bot already uploaded (same key, still fresh) without downloading or uploading it. */
export interface CachedSend {
  conversationId: string;
  cache: { key: string; ttlMs: number };
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
  /** Replaces the text of a message this bot sent (status/progress messages). Returns false if not possible. */
  editText?(conversationId: string, messageId: string, text: string): Promise<boolean>;
  /** Returns null when nothing fresh is cached (or re-sending failed), so the caller sends normally. */
  sendCached?(msg: CachedSend): Promise<SendResult | null>;
  /** Number of files currently remembered for re-sending. */
  cacheSize?(): number;
}

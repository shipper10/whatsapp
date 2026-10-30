/** Source-neutral Telegram message, produced by the GramJS adapter (production) or the export adapter (tests only). */
export interface RawEntity {
  type: "hashtag" | "url" | "text_link" | "other";
  offset: number;
  length: number;
  url?: string;
}

export interface RawMedia {
  kind: "document" | "audio" | "video" | "photo" | "other";
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface RawTelegramMessage {
  id: number;
  date: Date;
  editDate?: Date;
  text: string;
  entities: RawEntity[];
  media?: RawMedia;
  /** Telegram album id: messages sent together as an album share it (only one carries the caption). */
  groupedId?: string;
}

export interface TelegramRecord {
  chatId: bigint;
  messageId: number;
  messageDate: Date;
  editDate: Date | null;
  textOrCaption: string;
  entities: RawEntity[];
  hashtags: string[];
  links: string[];
  /** Message ids of the same channel referenced by links (index structure). */
  internalLinkIds: number[];
  /** Id of the index this message says to return to ("Return to ... Index"), if present. */
  returnIndexId: number | null;
  mediaType: string | null;
  fileName: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  permalink: string | null;
  /** Heuristic: text-only message with two or more internal links = index/navigation entry. */
  isIndex: boolean;
  groupedId: string | null;
}

/**
 * One window of channel history. `lastId` is the highest message id the window covered, INCLUDING ids that
 * produced no message (deleted, service/pin messages). The sync cursor follows `lastId`, never the last
 * stored message, so gaps can neither stall nor end a sync early.
 */
export interface RawBatch {
  messages: RawTelegramMessage[];
  lastId: number;
  /** True when nothing newer than `lastId` exists in the channel. */
  exhausted: boolean;
}

/** Abstraction over the Telegram client so sync logic is testable without network. */
export interface TelegramSource {
  /** The window of ids (minId, minId + limit], ascending; messages that do not exist are skipped. */
  fetchBatch(opts: { minId: number; limit: number }): Promise<RawBatch>;
  /** Re-reads specific messages (used to pick up edits to old index messages). Missing ids are skipped. */
  fetchByIds?(ids: number[]): Promise<RawTelegramMessage[]>;
}

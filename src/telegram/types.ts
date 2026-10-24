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
}

/** Abstraction over the Telegram client so sync logic is testable without network. */
export interface TelegramSource {
  /** Messages with id > minId (and <= maxId when given), ascending by id. */
  fetchBatch(opts: { minId: number; maxId?: number; limit: number }): Promise<RawTelegramMessage[]>;
}

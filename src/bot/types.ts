import type {
  IndexMessage,
  MessageKind,
  NodeInfo,
  NodeItem,
  ResourceDetail,
} from "../library/browse.js";
import type { LinkKind } from "../library/indexView.js";
import type { ResourceHit } from "../library/search.js";

/** What the conversation engine needs from the library. Backed by Postgres in production. */
export interface LibraryPort {
  children(parentId: number | null): Promise<NodeItem[]>;
  node(id: number): Promise<NodeInfo | null>;
  resources(nodeId: number, limit: number, offset: number): Promise<ResourceHit[]>;
  search(query: string, limit: number, offset: number): Promise<ResourceHit[]>;
  recent(limit: number, offset: number): Promise<ResourceHit[]>;
  detail(id: number): Promise<ResourceDetail | null>;
  /** The channel's own index messages, shown as-is with numbered links (no classification needed). */
  indexMessage(messageId: number): Promise<IndexMessage | null>;
  rootIndexId(): Promise<number | null>;
  /** Index messages whose title matches a typed name (with Arabic aliases), best first. */
  findIndexes(
    query: string,
    aliases: string[],
    limit: number,
  ): Promise<{ messageId: number; title: string }[]>;
  messageKinds(ids: number[]): Promise<Map<number, MessageKind>>;
  /** Delivery details for any Telegram message id (files that never became resources included). */
  messageDetail(messageId: number): Promise<ResourceDetail | null>;
}

export type Item =
  | { kind: "node"; id: number; label: string }
  | { kind: "resource"; id: number; label: string }
  | { kind: "action"; id: "recent" | "search"; label: string }
  /** A numbered link of an index message; `id` is the Telegram message id it points to. */
  | {
      kind: "link";
      id: number;
      label: string;
      linkKind: LinkKind;
      ord: number | null;
      block: number;
    };

export type View =
  | { type: "home" }
  | { type: "index"; messageId: number }
  | { type: "indexes"; query: string }
  | { type: "node"; nodeId: number; page: number }
  | { type: "search"; query: string; page: number }
  | { type: "recent"; page: number };

/** Persisted per participant (JSON in user_sessions.session_data_json). */
export interface SessionState {
  view: View;
  items: Item[];
  hasNext: boolean;
  stack: View[];
}

export interface BotConfig {
  pageSize: number;
  maxResults: number;
  welcome: string;
  cohort: string;
  lang: "ar" | "en";
  /** 0 = detect the main index automatically. */
  rootIndexId: number;
  /** "arabic=english" pairs used when jumping to an index by name. */
  aliases: string[];
  /** Whether Telegram / Google Drive links may be shown to people. */
  showLinks: { telegram: boolean; drive: boolean };
  /** Most files sent for one request. */
  maxBatch: number;
}

export interface Turn {
  state: SessionState;
  replies: string[];
  /** What the participant picked; the caller performs delivery, in order. */
  deliver?: { resources: number[]; messages: number[] };
}

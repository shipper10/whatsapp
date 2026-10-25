import type { NodeInfo, NodeItem, ResourceDetail } from "../library/browse.js";
import type { ResourceHit } from "../library/search.js";

/** What the conversation engine needs from the library. Backed by Postgres in production. */
export interface LibraryPort {
  children(parentId: number | null): Promise<NodeItem[]>;
  node(id: number): Promise<NodeInfo | null>;
  resources(nodeId: number, limit: number, offset: number): Promise<ResourceHit[]>;
  search(query: string, limit: number, offset: number): Promise<ResourceHit[]>;
  recent(limit: number, offset: number): Promise<ResourceHit[]>;
  detail(id: number): Promise<ResourceDetail | null>;
}

export type Item =
  | { kind: "node"; id: number; label: string }
  | { kind: "resource"; id: number; label: string }
  | { kind: "action"; id: "recent" | "search"; label: string };

export type View =
  | { type: "home" }
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
}

export interface Turn {
  state: SessionState;
  replies: string[];
  /** Resource the participant picked; the caller performs delivery. */
  deliver?: number;
}

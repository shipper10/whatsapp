import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const touched = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Runtime-editable, non-secret settings. Registry of keys lives in src/settings/registry.ts. */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: touched(),
});

export const telegramMessages = pgTable(
  "telegram_messages",
  {
    id: serial("id").primaryKey(),
    chatId: bigint("telegram_chat_id", { mode: "bigint" }).notNull(),
    messageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    messageDate: timestamp("message_date", { withTimezone: true }).notNull(),
    textOrCaption: text("text_or_caption"),
    entitiesJson: jsonb("entities_json"),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    mediaType: text("media_type"),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
    permalink: text("telegram_permalink"),
    editDate: timestamp("edit_date", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    syncStatus: text("sync_status").notNull().default("active"),
  },
  (t) => [uniqueIndex("telegram_messages_uq").on(t.chatId, t.messageId)],
);

export const driveSources = pgTable("drive_sources", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  folderId: text("folder_id").notNull().unique(),
  /** Reference to a credential (env var name / secret file key). Never the secret itself. */
  credentialRef: text("credential_ref").notNull(),
  recursiveScan: boolean("recursive_scan").notNull().default(true),
  enabled: boolean("enabled").notNull().default(true),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  syncStatus: text("sync_status").notNull().default("never"),
  lastError: text("last_error"),
});

export const driveFiles = pgTable(
  "drive_files",
  {
    id: serial("id").primaryKey(),
    driveSourceId: integer("drive_source_id")
      .notNull()
      .references(() => driveSources.id),
    driveFileId: text("drive_file_id").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    modifiedTime: timestamp("modified_time", { withTimezone: true }),
    parentFolderId: text("parent_folder_id"),
    folderPath: text("folder_path"),
    webViewLink: text("web_view_link"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    syncStatus: text("sync_status").notNull().default("active"),
  },
  (t) => [uniqueIndex("drive_files_uq").on(t.driveSourceId, t.driveFileId)],
);

export const academicNodes = pgTable(
  "academic_nodes",
  {
    id: serial("id").primaryKey(),
    nodeType: text("node_type").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    /** Stable identity from the source structure (e.g. "tg:<chat>:<index message id>"); null for admin-made nodes. */
    nodeKey: text("node_key").unique(),
    parentId: integer("parent_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [index("academic_nodes_parent_idx").on(t.parentId)],
);

export const resources = pgTable(
  "resources",
  {
    id: serial("id").primaryKey(),
    /** Stable identity ("tg:<chat>:<msg>" or "drive:<source>:<file>") so re-classification updates, never duplicates. */
    resourceKey: text("resource_key").notNull().unique(),
    displayName: text("display_name").notNull(),
    searchText: text("search_text").notNull().default(""),
    resourceType: text("resource_type").notNull().default("file"),
    academicNodeId: integer("academic_node_id").references(() => academicNodes.id),
    classificationStatus: text("classification_status").notNull().default("uncategorized"),
    /** True when an admin fixed the classification by hand: sync must not overwrite it. */
    classificationLocked: boolean("classification_locked").notNull().default(false),
    /** False when none of the resource's sources exist any more. Rows are never deleted. */
    isActive: boolean("is_active").notNull().default(true),
    /** Date of the underlying source item (Telegram message date / Drive modified time) for "recent". */
    sourceDate: timestamp("source_date", { withTimezone: true }),
    createdAt: now(),
    updatedAt: touched(),
  },
  (t) => [index("resources_status_idx").on(t.classificationStatus)],
);

export const resourceSources = pgTable(
  "resource_sources",
  {
    resourceId: integer("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(), // 'telegram' | 'google_drive'
    sourceRecordId: integer("source_record_id").notNull(),
    sourceUrl: text("source_url"),
    isPreferred: boolean("is_preferred").notNull().default(false),
    deliveryEligible: boolean("delivery_eligible").notNull().default(true),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.resourceId, t.sourceType, t.sourceRecordId] })],
);

export const resourceNodeLinks = pgTable(
  "resource_node_links",
  {
    resourceId: integer("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    nodeId: integer("node_id")
      .notNull()
      .references(() => academicNodes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.resourceId, t.nodeId] })],
);

export const resourceAliases = pgTable("resource_aliases", {
  id: serial("id").primaryKey(),
  /** Alias applies to a node (subject/topic synonym) or a resource. One of the two is set. */
  nodeId: integer("node_id").references(() => academicNodes.id, { onDelete: "cascade" }),
  resourceId: integer("resource_id").references(() => resources.id, { onDelete: "cascade" }),
  alias: text("alias").notNull(),
  aliasNormalized: text("alias_normalized").notNull(),
});

export const tags = pgTable("tags", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

export const resourceTags = pgTable(
  "resource_tags",
  {
    resourceId: integer("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.resourceId, t.tagId] })],
);

export const syncRuns = pgTable("sync_runs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(), // 'telegram' | 'drive'
  sourceKey: text("source_key").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  stats: jsonb("stats"),
  error: text("error"),
});

export const syncCursors = pgTable(
  "sync_cursors",
  {
    kind: text("kind").notNull(),
    sourceKey: text("source_key").notNull(),
    cursor: text("cursor"),
    updatedAt: touched(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.sourceKey] })],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    conversationId: text("conversation_id").notNull(),
    participantId: text("participant_id").notNull(),
    currentMenu: text("current_menu").notNull().default("home"),
    sessionDataJson: jsonb("session_data_json").notNull().default({}),
    pageNumber: integer("page_number").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: touched(),
  },
  (t) => [uniqueIndex("user_sessions_uq").on(t.provider, t.conversationId, t.participantId)],
);

export const registeredUsers = pgTable("registered_users", {
  id: serial("id").primaryKey(),
  participantId: text("participant_id").notNull().unique(),
  displayName: text("display_name"),
  isAdmin: boolean("is_admin").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: now(),
});

export const usageLogs = pgTable("usage_logs", {
  id: serial("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  participantHash: text("participant_hash").notNull(),
  event: text("event").notNull(),
  detail: jsonb("detail"),
});

export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: serial("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  detail: jsonb("detail"),
});

export const deliveryLogs = pgTable("delivery_logs", {
  id: serial("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  resourceId: integer("resource_id"),
  outcome: text("outcome").notNull(), // 'file_sent' | 'links_only' | 'unavailable'
  error: text("sanitized_error"),
});

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

/** WhatsApp (Baileys) login + signal keys, so the session survives restarts on hosts with ephemeral disks. */
export const waAuthState = pgTable("wa_auth_state", {
  name: text("name").primaryKey(),
  value: text("value").notNull(),
  updatedAt: touched(),
});

/** Chats (people or groups) that asked to be told when new files arrive. */
export const subscriptions = pgTable("subscriptions", {
  conversationId: text("conversation_id").primaryKey(),
  subscribedBy: text("subscribed_by"),
  createdAt: now(),
});

/** WhatsApp <-> Telegram bridge: one row = one one-way route. "Both ways" is two rows. */
export const bridgeRules = pgTable("bridge_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  srcPlatform: text("src_platform").notNull(),
  srcChatId: text("src_chat_id").notNull(),
  srcTopicId: text("src_topic_id").notNull().default(""),
  dstPlatform: text("dst_platform").notNull(),
  dstChatId: text("dst_chat_id").notNull(),
  dstTopicId: text("dst_topic_id").notNull().default(""),
  types: text("types").array().notNull(),
  showSender: boolean("show_sender").notNull().default(true),
  showPhone: boolean("show_phone").notNull().default(true),
  /** profile | saved | custom | none: which name heads a forwarded message. */
  senderMode: text("sender_mode").notNull().default("saved"),
  customName: text("custom_name").notNull().default(""),
  /** Forward messages written by the linked account itself. */
  forwardOwn: boolean("forward_own").notNull().default(true),
  /** Mirror edits / deletions of the source message onto its copy. */
  forwardEdits: boolean("forward_edits").notNull().default(true),
  forwardDeletes: boolean("forward_deletes").notNull().default(true),
  /** Keep a per-rule log of what happened to each message. */
  logEnabled: boolean("log_enabled").notNull().default(true),
  createdAt: now(),
});

/** Per-rule activity log shown on the rule's page. Trimmed automatically; can be cleared or switched off per rule. */
export const bridgeLogs = pgTable(
  "bridge_logs",
  {
    id: serial("id").primaryKey(),
    ruleId: integer("rule_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** ok | skip | warn | error */
    level: text("level").notNull(),
    /** received | skipped | sent | retry | failed | edit | delete | album */
    event: text("event").notNull(),
    msgType: text("msg_type").notNull().default(""),
    detail: text("detail").notNull().default(""),
  },
  (t) => [index("bridge_logs_rule_idx").on(t.ruleId, t.id)],
);

/** Chats, communities, channels and topics seen on either side; feeds the two tables of the dashboard. */
export const bridgeChats = pgTable(
  "bridge_chats",
  {
    id: serial("id").primaryKey(),
    platform: text("platform").notNull(),
    chatId: text("chat_id").notNull(),
    topicId: text("topic_id").notNull().default(""),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    parentId: text("parent_id"),
    updatedAt: touched(),
  },
  (t) => [uniqueIndex("bridge_chats_uq").on(t.platform, t.chatId, t.topicId)],
);

/** Every message the bridge produced, with where it came from: loop prevention and reply mapping. */
export const bridgeLinks = pgTable(
  "bridge_links",
  {
    id: serial("id").primaryKey(),
    platform: text("platform").notNull(),
    chatId: text("chat_id").notNull(),
    messageId: text("message_id").notNull(),
    srcPlatform: text("src_platform").notNull(),
    srcChatId: text("src_chat_id").notNull(),
    srcMessageId: text("src_message_id").notNull(),
    ruleId: integer("rule_id").notNull(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex("bridge_links_dst_uq").on(t.platform, t.chatId, t.messageId),
    index("bridge_links_src_idx").on(t.srcPlatform, t.srcChatId, t.srcMessageId),
  ],
);

/** Durable work queue: a restart or a failed destination never loses a forward. */
export const bridgeJobs = pgTable(
  "bridge_jobs",
  {
    id: serial("id").primaryKey(),
    /** send | album | edit | delete */
    kind: text("kind").notNull(),
    ruleId: integer("rule_id").notNull(),
    /** One job per (kind, rule, source message[, edit time]): the same event twice never doubles. */
    dedupeKey: text("dedupe_key").notNull().unique(),
    payload: jsonb("payload").notNull(),
    /** pending | running | done | failed */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: now(),
    updatedAt: touched(),
  },
  (t) => [index("bridge_jobs_due_idx").on(t.status, t.nextAttemptAt)],
);

import { z } from "zod";

/**
 * Every runtime-editable, NON-SECRET setting is declared here once.
 * Resolution order: app_settings row (admin edit) > environment variable (envName) > default.
 * To add a setting: add one entry. No other code change is needed to read/edit it.
 */
export interface SettingDef<T extends z.ZodType = z.ZodType> {
  schema: T;
  default: z.infer<T>;
  /** Optional env var used as the initial value before an admin overrides it. */
  envName?: string;
  /** True if a process restart is needed for the change to take effect. */
  restart: boolean;
  description: string;
}

const def = <T extends z.ZodType>(d: SettingDef<T>) => d;

export const settingsRegistry = {
  "cohort.label": def({
    schema: z.string().min(1),
    default: "Medical College Cohort",
    envName: "COHORT_LABEL",
    restart: false,
    description: "Display name of the cohort shown in menus.",
  }),
  "group.mode": def({
    schema: z.enum(["enabled", "disabled"]),
    default: "enabled",
    envName: "GROUP_MODE",
    restart: false,
    description: "Whether the bot answers in WhatsApp groups.",
  }),
  "group.replyMode": def({
    schema: z.enum(["reply_in_group", "private_only"]),
    default: "reply_in_group",
    envName: "GROUP_REPLY_MODE",
    restart: false,
    description: "Reply in the group (quoting the asker) or only in private chat.",
  }),
  "session.ttlMinutes": def({
    schema: z.coerce.number().int().min(1).max(1440),
    default: 30,
    envName: "SESSION_TTL_MINUTES",
    restart: false,
    description: "Idle minutes before a participant session expires.",
  }),
  "search.pageSize": def({
    schema: z.coerce.number().int().min(1).max(20),
    default: 8,
    envName: "PAGE_SIZE",
    restart: false,
    description: "Items per page in menus and results.",
  }),
  "search.maxResults": def({
    schema: z.coerce.number().int().min(1).max(100),
    default: 10,
    envName: "MAX_SEARCH_RESULTS",
    restart: false,
    description: "Maximum search results returned per query.",
  }),
  "sync.telegram.intervalMinutes": def({
    schema: z.coerce.number().int().min(1),
    default: 10,
    envName: "TELEGRAM_SYNC_INTERVAL_MINUTES",
    restart: false,
    description: "Telegram incremental sync interval.",
  }),
  "sync.drive.intervalMinutes": def({
    schema: z.coerce.number().int().min(1),
    default: 30,
    envName: "DRIVE_SYNC_INTERVAL_MINUTES",
    restart: false,
    description: "Drive metadata sync interval.",
  }),
  "sync.telegram.rescanWindow": def({
    schema: z.coerce.number().int().min(0).max(5000),
    default: 200,
    restart: false,
    description:
      "How many recent Telegram message ids are re-read each sync to catch edits (0 = off).",
  }),
  "sync.concurrency": def({
    schema: z.coerce.number().int().min(1).max(10),
    default: 3,
    envName: "SYNC_CONCURRENCY",
    restart: true,
    description: "Parallel sync jobs.",
  }),
  "delivery.concurrency": def({
    schema: z.coerce.number().int().min(1).max(10),
    default: 2,
    envName: "DELIVERY_CONCURRENCY",
    restart: true,
    description: "Parallel file deliveries.",
  }),
  "delivery.maxAttachmentMb": def({
    schema: z.coerce.number().int().min(1).max(2000),
    default: 64,
    envName: "MAX_ATTACHMENT_SIZE_MB",
    restart: false,
    description: "Files larger than this are sent as links only.",
  }),
  "delivery.allowedMediaTypes": def({
    schema: z.array(z.string()),
    default: [],
    restart: false,
    description: "Allowed MIME prefixes/types for attachments. Empty = allow all.",
  }),
  "whatsapp.minSendGapMs": def({
    schema: z.coerce.number().int().min(0).max(10000),
    default: 800,
    envName: "WHATSAPP_MIN_SEND_GAP_MS",
    restart: false,
    description:
      "Minimum pause between outgoing WhatsApp messages (smooths bursts; lowers restriction risk).",
  }),
  "delivery.timeoutSeconds": def({
    schema: z.coerce.number().int().min(1).max(900),
    default: 120,
    envName: "DELIVERY_TIMEOUT_SECONDS",
    restart: false,
    description: "Max time to download + send one file before falling back to links.",
  }),
  "delivery.driveDownload": def({
    schema: z.boolean(),
    default: false,
    restart: false,
    description:
      "Allow fetching a file from Drive for attachment delivery (needs the broader drive.readonly scope).",
  }),
  "delivery.sendAttachment": def({
    schema: z.boolean(),
    default: true,
    restart: false,
    description: "Master switch: false = always send links only.",
  }),
  "delivery.tempFileTtlMinutes": def({
    schema: z.coerce.number().int().min(1),
    default: 30,
    envName: "TEMP_FILE_TTL_MINUTES",
    restart: false,
    description: "Age after which orphaned temp files are removed.",
  }),
  "rateLimit.perParticipantPerMinute": def({
    schema: z.coerce.number().int().min(1),
    default: 20,
    restart: false,
    description: "Max messages handled per participant per minute.",
  }),
  "bot.language": def({
    schema: z.enum(["ar", "en"]),
    default: "ar",
    envName: "BOT_LANGUAGE",
    restart: false,
    description: "Language of bot messages.",
  }),
  "bot.maxMessageAgeSeconds": def({
    schema: z.coerce.number().int().min(0),
    default: 300,
    restart: false,
    description:
      "Ignore inbound messages older than this (avoids replay after downtime). 0 = no limit.",
  }),
  "group.triggers": def({
    schema: z.array(z.string().min(1)),
    default: ["مكتبة", "المكتبة", "library", "lib"],
    restart: false,
    description:
      "Words that start an interaction in a group. Active sessions continue without them.",
  }),
  "text.welcome": def({
    schema: z.string(),
    default: "أهلاً بك في المكتبة الطبية 📚\nWelcome to the medical library.",
    restart: false,
    description: "Home menu greeting. Editable without redeploy.",
  }),
} as const;

export type SettingKey = keyof typeof settingsRegistry;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingsRegistry)[K]["schema"]>;

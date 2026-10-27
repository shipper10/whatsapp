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
    description:
      "Which file types may be sent as real files (others get links only). Empty = all. Accepts names like pdf, docx, audio, video, image, extensions (.mp3) or MIME types (application/pdf, audio/*). Comma separated, e.g. /set delivery.allowedMediaTypes pdf,audio",
  }),
  "delivery.audioMode": def({
    schema: z.enum(["audio", "document"]),
    default: "audio",
    envName: "DELIVERY_AUDIO_MODE",
    restart: false,
    description:
      "audio = sound files arrive as playable WhatsApp audio messages; document = as attachments (use if audio messages fail on your recipients' phones).",
  }),
  "delivery.audioNormalize": def({
    schema: z.boolean(),
    default: true,
    envName: "DELIVERY_AUDIO_NORMALIZE",
    restart: false,
    description:
      "Re-encode sound files to clean mono Ogg/Opus before sending (fixes 'audio not available' on files WhatsApp dislikes). Needs ffmpeg; skipped if absent.",
  }),
  "keepalive.intervalMinutes": def({
    schema: z.coerce.number().int().min(0).max(60),
    default: 10,
    envName: "KEEPALIVE_INTERVAL_MINUTES",
    restart: false,
    description:
      "Every N minutes the bot reads its database (keeps free Postgres from pausing) and, if a public URL is known, requests its own /healthz (keeps free hosts awake). 0 = off.",
  }),
  "links.telegram": def({
    schema: z.boolean(),
    default: true,
    envName: "SHOW_TELEGRAM_LINKS",
    restart: false,
    description:
      "Show Telegram links (in file captions, fallback messages, text posts and the index text). false = hide them everywhere.",
  }),
  "links.drive": def({
    schema: z.boolean(),
    default: true,
    envName: "SHOW_DRIVE_LINKS",
    restart: false,
    description:
      "Show Google Drive links (in file captions, fallback messages and the index text). false = hide them everywhere.",
  }),
  "delivery.progress": def({
    schema: z.boolean(),
    default: true,
    envName: "DELIVERY_PROGRESS",
    restart: false,
    description:
      "Show a status message (queue position, download percent, sending) that is edited as a request proceeds.",
  }),
  "delivery.progressMinMb": def({
    schema: z.coerce.number().int().min(0).max(2000),
    default: 5,
    envName: "DELIVERY_PROGRESS_MIN_MB",
    restart: false,
    description:
      "A single file smaller than this shows no status message (unless it had to wait in line). Requests with several files always show one.",
  }),
  "delivery.maxBatch": def({
    schema: z.coerce.number().int().min(1).max(50),
    default: 15,
    envName: "DELIVERY_MAX_BATCH",
    restart: false,
    description: "Most files sent for one request (e.g. 'sheet 1-5').",
  }),
  "library.indexAliases": def({
    schema: z.array(z.string()),
    default: [
      "الفصل الاول=1st semester",
      "الفصل الثاني=2nd semester",
      "السنة الاولى=first year",
      "السنة الثانية=second year",
      "السنة الثالثة=third year",
      "السنة الرابعة=fourth year",
      "السنة الخامسة=fifth year",
      "السنة السادسة=sixth year",
      "خلية=cell biology",
      "بيولوجيا الخلية=cell biology",
      "كيمياء=chemistry",
      "انجليزي=english",
      "لغة انجليزية=english",
      "اجتماع=sociology",
      "نفس=psychology",
      "رياضيات=mathematics",
      "فيزياء=physics",
      "مهارات=study skills",
      "جزيئات حيوية=biomolecules",
      "صحة مجتمع=community health",
      "مصطلحات=medical terminology",
      "استتباب=homeostasis",
      "بيولوجيا بشرية=human biology",
      "احياء بشرية=human biology",
      "تشريح=anatomy",
      "كيمياء حيوية=biochemistry",
      "فسيولوجي=physiology",
    ],
    restart: false,
    description:
      "Arabic=English word pairs so typing an Arabic subject name reaches its English index title. Edit freely.",
  }),
  "library.rootIndexMessageId": def({
    schema: z.coerce.number().int().min(0),
    default: 0,
    envName: "LIBRARY_ROOT_INDEX_ID",
    restart: false,
    description:
      "Telegram message id of the main index shown on the home screen. 0 = detect automatically.",
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
    description:
      "Seconds without any download progress before giving up on a file and falling back to links (the clock restarts whenever bytes arrive).",
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
    default: ["!"],
    restart: false,
    description:
      "Prefixes that address the bot in a group (a symbol like ! may be glued to the text: !5). Replying to one of the bot's own messages also addresses it. Everything else in the group is ignored.",
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

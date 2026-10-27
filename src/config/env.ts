import { z } from "zod";

/**
 * Deployment-level configuration (secrets + things that need a restart).
 * Runtime-editable, non-secret settings live in src/settings/registry.ts and the app_settings table.
 */
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  APP_TIMEZONE: z.string().default("Africa/Khartoum"),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // WhatsApp gateway (OpenWA)
  // "openwa" = separate gateway container; "baileys" = lite mode, one process, login stored in Postgres.
  WHATSAPP_PROVIDER: z.enum(["openwa", "baileys"]).default("openwa"),
  OPENWA_BASE_URL: z.string().url().default("http://openwa:2785"),
  OPENWA_API_KEY: z.string().optional(),
  OPENWA_SESSION_ID: z.string().optional(),
  OPENWA_WEBHOOK_SECRET: z.string().optional(),
  // Lite mode: protects /admin/link (QR page). Required when WHATSAPP_PROVIDER=baileys.
  ADMIN_HTTP_TOKEN: z.string().optional(),

  // Telegram (GramJS). Optional until the Telegram sync slice is enabled.
  TELEGRAM_API_ID: z.coerce.number().int().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_CHANNEL: z.string().optional(), // username (BahriMed) or numeric id
  TELEGRAM_SESSION_STRING: z.string().optional(),

  // Google Drive. Per-source credentials are referenced by drive_sources.credential_ref.
  GOOGLE_SERVICE_ACCOUNT_JSON_PATH: z.string().optional(),
  // Alternative to the path: the key itself (raw JSON, or base64 of it) - easiest to move between hosts.
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

  // Bootstrap admins (comma-separated participant ids). More can be added in registered_users.
  ADMIN_IDS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),

  // Public URL of this service, pinged by the keep-alive loop. Render sets RENDER_EXTERNAL_URL itself.
  KEEPALIVE_URL: z.string().url().optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),

  TEMP_FILE_DIR: z.string().default("./tmp"),
  ENABLE_SCHEDULER: bool.default(true),
});

export const envSchema = baseSchema.superRefine((e, ctx) => {
  const need = (key: string, ok: boolean, msg: string) => {
    if (!ok) ctx.addIssue({ code: "custom", path: [key], message: msg });
  };
  if (e.WHATSAPP_PROVIDER === "openwa") {
    need("OPENWA_API_KEY", !!e.OPENWA_API_KEY, "OPENWA_API_KEY is required");
    need("OPENWA_SESSION_ID", !!e.OPENWA_SESSION_ID, "OPENWA_SESSION_ID is required");
    need(
      "OPENWA_WEBHOOK_SECRET",
      (e.OPENWA_WEBHOOK_SECRET?.length ?? 0) >= 16,
      "OPENWA_WEBHOOK_SECRET must be >= 16 chars",
    );
  } else {
    need(
      "ADMIN_HTTP_TOKEN",
      (e.ADMIN_HTTP_TOKEN?.length ?? 0) >= 16,
      "ADMIN_HTTP_TOKEN must be >= 16 chars",
    );
  }
});

export type Env = z.infer<typeof baseSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = String(i.path[0] ?? "(root)");
      const missing = source[key] === undefined || source[key] === "";
      return `  - ${key}: ${missing ? "is required (missing)" : i.message}`;
    });
    throw new Error(`Invalid configuration:\n${lines.join("\n")}\nSee .env.example.`);
  }
  return parsed.data;
}

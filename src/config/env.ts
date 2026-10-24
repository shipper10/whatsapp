import { z } from "zod";

/**
 * Deployment-level configuration (secrets + things that need a restart).
 * Runtime-editable, non-secret settings live in src/settings/registry.ts and the app_settings table.
 */
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  APP_TIMEZONE: z.string().default("Africa/Khartoum"),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // WhatsApp gateway (OpenWA)
  WHATSAPP_PROVIDER: z.enum(["openwa"]).default("openwa"),
  OPENWA_BASE_URL: z.string().url().default("http://openwa:2785"),
  OPENWA_API_KEY: z.string().min(1, "OPENWA_API_KEY is required"),
  OPENWA_SESSION_ID: z.string().min(1, "OPENWA_SESSION_ID is required"),
  OPENWA_WEBHOOK_SECRET: z.string().min(16, "OPENWA_WEBHOOK_SECRET must be >= 16 chars"),

  // Telegram (GramJS). Optional until the Telegram sync slice is enabled.
  TELEGRAM_API_ID: z.coerce.number().int().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_CHANNEL: z.string().optional(), // username (BahriMed) or numeric id
  TELEGRAM_SESSION_STRING: z.string().optional(),

  // Google Drive. Per-source credentials are referenced by drive_sources.credential_ref.
  GOOGLE_SERVICE_ACCOUNT_JSON_PATH: z.string().optional(),
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

  TEMP_FILE_DIR: z.string().default("./tmp"),
  ENABLE_SCHEDULER: bool.default(true),
});

export type Env = z.infer<typeof envSchema>;

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

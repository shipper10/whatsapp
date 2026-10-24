import pino from "pino";

/** Secrets must never reach logs: redact known sensitive paths. */
export const redactPaths = [
  "*.apiKey",
  "*.token",
  "*.secret",
  "*.sessionString",
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  'req.headers["x-openwa-signature"]',
];

export function createLogger(level: string) {
  return pino({ level, redact: { paths: redactPaths, censor: "[redacted]" } });
}

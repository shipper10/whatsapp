import { t } from "../bot/messages.js";
import type { ResourceDetail } from "../library/browse.js";

const LABEL = { telegram: "Telegram", google_drive: "Google Drive" } as const;

/**
 * Formats the always-included source links. Only real, stored URLs are shown; a missing source is
 * omitted, never invented. `attachment` reflects what actually happened, never a guess.
 */
export function formatLinksMessage(
  d: ResourceDetail,
  lang: "ar" | "en",
  attachment: "sent" | "failed" | "not_attempted" | "too_large" | "type_blocked",
): string {
  const lines = [`*${d.displayName}*`];
  if (attachment === "sent") lines.push(lang === "ar" ? "📎 تم إرسال الملف." : "📎 File sent.");
  else if (attachment === "too_large")
    lines.push(
      lang === "ar"
        ? "📎 الملف كبير لإرساله هنا. افتحه من الروابط:"
        : "📎 The file is too large to send here. Open it here:",
    );
  else if (attachment === "type_blocked")
    lines.push(
      lang === "ar"
        ? "📎 هذا النوع من الملفات لا يُرسل هنا. افتحه من الروابط:"
        : "📎 This file type isn't sent here. Open it here:",
    );
  else if (attachment === "failed")
    lines.push(
      lang === "ar"
        ? "⚠️ تعذّر إرسال الملف. يمكنك فتحه من الروابط:"
        : "⚠️ I couldn't send the file. You can open it here:",
    );
  const links = d.sources
    .filter((s) => s.url)
    .sort((a, b) => Number(b.preferred) - Number(a.preferred));
  const seen = new Set<string>();
  for (const s of links) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    lines.push(`${s.type === "telegram" ? "✈️" : "📁"} ${LABEL[s.type]}: ${s.url}`);
  }
  if (seen.size === 0) lines.push(t("unavailable", lang));
  return lines.join("\n");
}

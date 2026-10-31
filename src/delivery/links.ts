import { t } from "../bot/messages.js";
import type { ResourceDetail } from "../library/browse.js";

const LABEL = { telegram: "Telegram", google_drive: "Google Drive" } as const;

/**
 * Formats the always-included source links. Only real, stored URLs are shown; a missing source is
 * omitted, never invented. `attachment` reflects what actually happened, never a guess.
 */
export interface LinkFlags {
  telegram: boolean;
  drive: boolean;
}
export const ALL_LINKS: LinkFlags = { telegram: true, drive: true };

/** The source links an admin allows to be shown, best (preferred) first, without duplicates. */
export function visibleLinks(
  d: ResourceDetail,
  flags: LinkFlags,
): { type: "telegram" | "google_drive"; url: string }[] {
  const seen = new Set<string>();
  const out: { type: "telegram" | "google_drive"; url: string }[] = [];
  for (const s of [...d.sources].sort((a, b) => Number(b.preferred) - Number(a.preferred))) {
    if (!s.url || seen.has(s.url)) continue;
    if (s.type === "telegram" ? !flags.telegram : !flags.drive) continue;
    seen.add(s.url);
    out.push({ type: s.type, url: s.url });
  }
  return out;
}

export function formatLinksMessage(
  d: ResourceDetail,
  attachment: "sent" | "failed" | "not_attempted" | "too_large" | "type_blocked",
  flags: LinkFlags = ALL_LINKS,
): string {
  const links = visibleLinks(d, flags);
  const withLinks = links.length > 0;
  const lines = [`*${d.displayName}*`];
  if (attachment === "sent") lines.push("📎 File sent.");
  else if (attachment === "too_large")
    lines.push(`📎 The file is too large to send here.${withLinks ? " Open it here:" : ""}`);
  else if (attachment === "type_blocked")
    lines.push(`📎 This file type isn't sent here.${withLinks ? " Open it here:" : ""}`);
  else if (attachment === "failed")
    lines.push(
      `⚠️ I couldn't send the file.${withLinks ? " You can open it here:" : " Please try again later."}`,
    );
  for (const l of links)
    lines.push(`${l.type === "telegram" ? "✈️" : "📁"} ${LABEL[l.type]}: ${l.url}`);
  // "unavailable" only when no link exists at all; links hidden by the admin are not a missing file
  const noUrlAtAll = !d.sources.some((s) => s.url) && attachment !== "sent";
  if (noUrlAtAll || (!withLinks && attachment === "not_attempted")) lines.push(t("unavailable"));
  return lines.join("\n");
}

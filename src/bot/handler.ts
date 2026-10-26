import { Deduper, KeyedMutex, RateLimiter } from "../core/concurrency.js";
import { normalizeText } from "../core/normalize/arabic.js";
import { MissingParticipantError, sessionKeyFor, sessionKeyString } from "../core/session/key.js";
import type { SessionStore } from "../core/session/store.js";
import type { Deliverer } from "../delivery/types.js";
import type { IncomingMessage, WhatsAppProvider } from "../providers/whatsapp/types.js";
import type { SettingsService } from "../settings/service.js";
import { step } from "./engine.js";
import { t } from "./messages.js";
import type { BotConfig, LibraryPort } from "./types.js";

export interface HandlerDeps {
  provider: WhatsAppProvider;
  settings: SettingsService;
  sessions: SessionStore;
  library: LibraryPort;
  deliverer: Deliverer;
  logger: {
    info: (o: object, m?: string) => void;
    warn: (o: object, m?: string) => void;
    error: (o: object, m?: string) => void;
  };
  /** Optional hook for admin commands; return true when the message was consumed. */
  adminHook?: (msg: IncomingMessage) => Promise<boolean>;
  now?: () => number;
}

/**
 * Strips the prefix that addresses the bot in a group. A symbol prefix ("!") may be glued to the text
 * ("!5", "!sheet 1-5"); a word prefix ("lib") must be followed by a space. Returns null when absent.
 */
export function stripTrigger(text: string, triggers: string[]): string | null {
  const trimmed = text.trim();
  const norm = normalizeText(trimmed);
  for (const trig of triggers) {
    const raw = trig.trim();
    if (!raw) continue;
    if (/^[^\p{L}\p{N}\s]+$/u.test(raw)) {
      if (trimmed.startsWith(raw)) return trimmed.slice(raw.length).trim();
      continue;
    }
    const n = normalizeText(raw);
    if (!n) continue;
    if (norm === n) return "";
    if (norm.startsWith(`${n} `)) {
      const words = n.split(" ").length;
      return trimmed.split(/\s+/).slice(words).join(" ");
    }
  }
  return null;
}

export function createHandler(deps: HandlerDeps) {
  const mutex = new KeyedMutex();
  const limiter = new RateLimiter(deps.now);
  const dedupe = new Deduper();
  const nowMs = deps.now ?? Date.now;

  /** Ids of messages this handler sent, so replies to them count as addressed to the bot. */
  const sentIds = new Set<string>();
  const rememberSent = (id?: string) => {
    if (!id) return;
    sentIds.add(id);
    if (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value as string);
  };

  async function reply(msg: IncomingMessage, text: string) {
    const res = await deps.provider.sendText({
      conversationId: msg.conversationId,
      text,
      quoteMessageId: msg.isGroup ? msg.messageId : undefined,
    });
    rememberSent(res.providerMessageId);
    if (!res.confirmed)
      deps.logger.warn(
        { error: res.error, conversation: msg.conversationId },
        "reply not confirmed by provider",
      );
  }

  async function process(msg: IncomingMessage) {
    const [
      lang,
      pageSize,
      maxResults,
      welcome,
      cohort,
      ttl,
      groupMode,
      groupReply,
      triggers,
      rate,
      rootIndexId,
      maxBatch,
    ] = await Promise.all([
      deps.settings.get("bot.language"),
      deps.settings.get("search.pageSize"),
      deps.settings.get("search.maxResults"),
      deps.settings.get("text.welcome"),
      deps.settings.get("cohort.label"),
      deps.settings.get("session.ttlMinutes"),
      deps.settings.get("group.mode"),
      deps.settings.get("group.replyMode"),
      deps.settings.get("group.triggers"),
      deps.settings.get("rateLimit.perParticipantPerMinute"),
      deps.settings.get("library.rootIndexMessageId"),
      deps.settings.get("delivery.maxBatch"),
    ]);
    const cfg: BotConfig = { pageSize, maxResults, welcome, cohort, lang, rootIndexId, maxBatch };

    if (msg.isGroup && groupMode === "disabled") return;

    let key: ReturnType<typeof sessionKeyFor>;
    try {
      key = sessionKeyFor(msg);
    } catch (err) {
      if (err instanceof MissingParticipantError) {
        deps.logger.warn(
          { conversation: msg.conversationId },
          "group message without participant id ignored",
        );
        return;
      }
      throw err;
    }

    // Everything for one participant runs strictly in order.
    await mutex.run(sessionKeyString(key), async () => {
      const existing = await deps.sessions.get(key);
      let text = msg.text;

      if (msg.isGroup) {
        // In a group the bot speaks only when addressed: by the prefix, or by replying to one of its messages.
        const stripped = stripTrigger(msg.text, triggers);
        const repliedToBot =
          msg.replyToFromMe === true ||
          (msg.replyToMessageId !== undefined &&
            (sentIds.has(msg.replyToMessageId) ||
              deps.provider.isOwnMessage?.(msg.replyToMessageId) === true));
        if (stripped === null && !repliedToBot) return;
        if (stripped !== null) text = stripped === "" ? "0" : stripped;
        if (groupReply === "private_only") {
          if (stripped !== null) await reply(msg, t("groupPrivateOnly", lang));
          return;
        }
      }

      const verdict = limiter.check(sessionKeyString(key), rate);
      if (verdict !== "ok") {
        if (verdict === "warn") await reply(msg, t("rateLimited", lang));
        return;
      }

      if (deps.adminHook && (await deps.adminHook({ ...msg, text }))) return;

      const turn = await step(deps.library, cfg, existing, text);
      await deps.sessions.save(key, turn.state, ttl);
      for (const r of turn.replies) await reply(msg, r);
      if (turn.deliver) {
        const target = {
          conversationId: msg.conversationId,
          quoteMessageId: msg.isGroup ? msg.messageId : undefined,
        };
        for (const id of turn.deliver.resources) await deps.deliverer.deliver(id, target);
        for (const id of turn.deliver.messages) await deps.deliverer.deliverMessage(id, target);
      }
    });
  }

  return {
    /** Entry point for provider events. Never throws; failures are logged and the user gets a generic notice. */
    async handle(eventId: string, msg: IncomingMessage): Promise<void> {
      if (dedupe.isDuplicate(eventId)) return;
      const maxAge = await deps.settings.get("bot.maxMessageAgeSeconds");
      if (maxAge > 0 && nowMs() / 1000 - msg.timestamp > maxAge) return;
      try {
        await process(msg);
      } catch (err) {
        deps.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "message handling failed",
        );
        try {
          await reply(msg, t("errorGeneric", await deps.settings.get("bot.language")));
        } catch {
          /* provider down: nothing more to do */
        }
      }
    },
    prune() {
      limiter.prune();
    },
  };
}

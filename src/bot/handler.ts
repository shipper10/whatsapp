import { Deduper, KeyedMutex, RateLimiter } from "../core/concurrency.js";
import { normalizeText } from "../core/normalize/text.js";
import { MissingParticipantError, sessionKeyFor, sessionKeyString } from "../core/session/key.js";
import type { SessionStore } from "../core/session/store.js";
import { WhatsAppProgress } from "../delivery/progress.js";
import type { Deliverer } from "../delivery/types.js";
import type { IncomingMessage, WhatsAppProvider } from "../providers/whatsapp/types.js";
import type { SettingsService } from "../settings/service.js";
import { parseInput, step } from "./engine.js";
import { t } from "./messages.js";
import type { PrefsPort } from "./prefs.js";
import type { ReplyTracker } from "./replyTracker.js";
import type { BotConfig, LibraryPort } from "./types.js";
import { userCommand } from "./userCommands.js";

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
  /** Knows who each bot message in a group answered; `provider` must be the one wrapped by it. */
  replies: ReplyTracker;
  /** New-file subscriptions. */
  prefs?: PrefsPort;
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

  async function reply(msg: IncomingMessage, text: string) {
    const res = await deps.provider.sendText({
      conversationId: msg.conversationId,
      text,
      quoteMessageId: msg.isGroup ? msg.messageId : undefined,
    });
    if (!res.confirmed)
      deps.logger.warn(
        { error: res.error, conversation: msg.conversationId },
        "reply not confirmed by provider",
      );
  }

  async function process(msg: IncomingMessage) {
    const [
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
      showTelegram,
      showDrive,
      notifyEnabled,
    ] = await Promise.all([
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
      deps.settings.get("links.telegram"),
      deps.settings.get("links.drive"),
      deps.settings.get("notify.enabled"),
    ]);
    const cfg: BotConfig = {
      pageSize,
      maxResults,
      welcome,
      cohort,
      rootIndexId,
      maxBatch,
      showLinks: { telegram: showTelegram, drive: showDrive },
    };

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
        // In a group the bot speaks only when addressed: by the prefix, or when the person who asked
        // replies to the bot's answer with a navigation command (a number, 0, back, next...).
        deps.replies.noteIncoming(msg.messageId, msg.participantId);
        const stripped = stripTrigger(msg.text, triggers);
        if (stripped === null) {
          const answeredThem =
            msg.replyToMessageId !== undefined &&
            deps.replies.askerOf(msg.replyToMessageId) === msg.participantId;
          if (!answeredThem || parseInput(msg.text).kind === "text") return;
        } else text = stripped === "" ? "0" : stripped;
        if (groupReply === "private_only") {
          if (stripped !== null) await reply(msg, t("groupPrivateOnly"));
          return;
        }
      }

      const verdict = limiter.check(sessionKeyString(key), rate);
      if (verdict !== "ok") {
        if (verdict === "warn") await reply(msg, t("rateLimited"));
        return;
      }

      if (deps.adminHook && (await deps.adminHook({ ...msg, text }))) return;

      const personal = await userCommand(text, {
        prefs: deps.prefs,
        notifyEnabled,
        participantId: msg.participantId,
        conversationId: msg.conversationId,
      });
      if (personal !== null) {
        await reply(msg, personal);
        return;
      }

      const turn = await step(deps.library, cfg, existing, text);
      await deps.sessions.save(key, turn.state, ttl);
      for (const r of turn.replies) await reply(msg, r);
      if (turn.deliver) {
        const target = {
          conversationId: msg.conversationId,
          quoteMessageId: msg.isGroup ? msg.messageId : undefined,
        };
        const total = turn.deliver.resources.length + turn.deliver.messages.length;
        const [showProgress, minMb] = await Promise.all([
          deps.settings.get("delivery.progress"),
          deps.settings.get("delivery.progressMinMb"),
        ]);
        const sink = showProgress
          ? new WhatsAppProgress({
              provider: deps.provider,
              conversationId: msg.conversationId,
              quoteMessageId: target.quoteMessageId,
              minBytes: minMb * 1024 * 1024,
            })
          : undefined;
        if (sink) await sink.begin(total);
        else if (total > 1) await reply(msg, t("sendingMany").replace("{n}", String(total)));
        const withProgress = { ...target, progress: sink };
        try {
          for (const id of turn.deliver.resources) await deps.deliverer.deliver(id, withProgress);
          for (const id of turn.deliver.messages)
            await deps.deliverer.deliverMessage(id, withProgress);
        } finally {
          await sink?.end();
        }
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
          await reply(msg, t("errorGeneric"));
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

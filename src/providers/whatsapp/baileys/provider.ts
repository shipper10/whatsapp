import type {
  AnyMessageContent,
  AuthenticationState,
  MiscMessageGenerationOptions,
  WAMessage,
} from "@whiskeysockets/baileys";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import type { Db } from "../../../db/client.js";
import type {
  IncomingMessage,
  OutgoingDocument,
  OutgoingText,
  SendResult,
  WhatsAppProvider,
} from "../types.js";
import { useDbAuthState } from "./authState.js";
import { extractIncoming } from "./extract.js";

/** The slice of the Baileys socket this provider uses (lets tests inject a fake). */
export interface SocketLike {
  ev: { on(event: string, listener: (arg: never) => void): void };
  sendMessage(
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ): Promise<WAMessage | undefined>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  end(error: Error | undefined): void;
}

export type LinkState =
  | "starting"
  | "qr"
  | "open"
  | "reconnecting"
  | "logged_out"
  | "replaced"
  | "stopped";
export interface LinkStatus {
  state: LinkState;
  /** Raw QR payload while waiting for a scan. */
  qr?: string;
  /** Own WhatsApp id once linked. */
  me?: string;
}

interface Logger {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

export interface BaileysDeps {
  db: Db;
  logger: Logger;
  /** Pino-compatible logger handed to Baileys itself (keep it quiet: it is very chatty). */
  baileysLogger: unknown;
  onMessage: (id: string, msg: IncomingMessage) => Promise<void>;
  minSendGapMs: () => Promise<number>;
  namespace?: string;
  socketFactory?: (auth: AuthenticationState) => Promise<SocketLike>;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
}

const RECENT_MAX = 300;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultBackoff = (attempt: number) => Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));

export class BaileysProvider implements WhatsAppProvider {
  readonly name = "baileys";
  private sock: SocketLike | null = null;
  private status_: LinkStatus = { state: "starting" };
  private stopped = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Recent inbound messages, kept only so replies can quote the asker. */
  private recent = new Map<string, WAMessage>();
  private sendChain: Promise<unknown> = Promise.resolve();
  private lastSendAt = 0;
  private authClear: (() => Promise<void>) | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoff: (n: number) => number;

  constructor(private readonly deps: BaileysDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.backoff = deps.backoffMs ?? defaultBackoff;
  }

  status(): LinkStatus {
    return { ...this.status_ };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.status_ = { state: "stopped" };
    this.sock?.end(undefined);
    this.sock = null;
  }

  /** Alternative to QR for linking from a phone you do not hold: WhatsApp > Linked devices > link with phone number. */
  async requestPairingCode(phoneDigits: string): Promise<string> {
    if (!this.sock) throw new Error("socket not ready");
    if (this.status_.state === "open") throw new Error("already linked");
    return this.sock.requestPairingCode(phoneDigits.replace(/\D/g, ""));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const { state, saveCreds, clear } = await useDbAuthState(this.deps.db, this.deps.namespace);
    this.authClear = clear;
    const sock = await (this.deps.socketFactory ?? this.defaultFactory)(state);
    this.sock = sock;
    this.status_ = { state: "starting" };

    sock.ev.on("creds.update", (() => {
      void saveCreds().catch((e) =>
        this.deps.logger.error({ err: String(e) }, "saving WhatsApp credentials failed"),
      );
    }) as never);

    sock.ev.on("connection.update", ((u: {
      connection?: string;
      qr?: string;
      lastDisconnect?: { error?: unknown };
    }) => {
      if (sock !== this.sock) return; // stale socket
      if (u.qr) this.status_ = { state: "qr", qr: u.qr };
      if (u.connection === "open") {
        this.attempt = 0;
        this.status_ = { state: "open", me: (state.creds.me as { id?: string } | undefined)?.id };
        this.deps.logger.info({ me: this.status_.me }, "WhatsApp connected");
      } else if (u.connection === "close") {
        void this.onClose(u.lastDisconnect?.error);
      }
    }) as never);

    sock.ev.on("messages.upsert", ((e: { messages: WAMessage[]; type: string }) => {
      if (e.type !== "notify") return; // history / appended messages are not requests
      for (const m of e.messages) {
        const incoming = extractIncoming(m);
        if (!incoming) continue;
        this.remember(m);
        void this.deps
          .onMessage(incoming.messageId, incoming)
          .catch((err) => this.deps.logger.error({ err: String(err) }, "message handler failed"));
      }
    }) as never);
  }

  private async onClose(error: unknown): Promise<void> {
    if (this.stopped) return;
    const code = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    this.sock = null;
    if (code === DisconnectReason.loggedOut) {
      this.deps.logger.warn(
        {},
        "WhatsApp logged out: clearing credentials, a new QR will be shown",
      );
      await this.authClear?.().catch(() => undefined);
      this.status_ = { state: "logged_out" };
      this.attempt = 0;
      await this.schedule(1_000);
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      // Another client took over this login; fighting it would just flap. Stay down until restart.
      this.deps.logger.error({}, "WhatsApp session replaced by another client; not reconnecting");
      this.status_ = { state: "replaced" };
      return;
    }
    // restartRequired (right after pairing) and ordinary drops: reconnect with backoff.
    this.status_ = { state: "reconnecting" };
    const wait = code === DisconnectReason.restartRequired ? 0 : this.backoff(this.attempt++);
    this.deps.logger.warn({ code, retryInMs: wait }, "WhatsApp disconnected");
    await this.schedule(wait);
  }

  private async schedule(ms: number): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.connect().catch((e) => {
        this.deps.logger.error({ err: String(e) }, "WhatsApp reconnect failed");
        void this.onClose(undefined);
      });
    }, ms);
    this.timer.unref?.();
  }

  private readonly defaultFactory = async (auth: AuthenticationState): Promise<SocketLike> => {
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      /* fall back to the version bundled with the library */
    }
    return makeWASocket({
      auth: {
        creds: auth.creds,
        keys: makeCacheableSignalKeyStore(auth.keys, this.deps.baileysLogger as never),
      },
      version,
      logger: this.deps.baileysLogger as never,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid: string) =>
        jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast"),
      getMessage: async () => undefined,
    }) as unknown as SocketLike;
  };

  private remember(m: WAMessage): void {
    const id = m.key.id;
    if (!id) return;
    this.recent.set(id, m);
    if (this.recent.size > RECENT_MAX) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
  }

  private enqueue(job: () => Promise<SendResult>): Promise<SendResult> {
    const run = async (): Promise<SendResult> => {
      const gap = await this.deps.minSendGapMs().catch(() => 0);
      const wait = this.lastSendAt + gap - Date.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await job();
      } finally {
        this.lastSendAt = Date.now();
      }
    };
    const next = this.sendChain.then(run, run);
    this.sendChain = next.catch(() => undefined);
    return next;
  }

  private async deliver(
    jid: string,
    content: AnyMessageContent,
    quoteId?: string,
  ): Promise<SendResult> {
    const sock = this.sock;
    if (!sock || this.status_.state !== "open")
      return { confirmed: false, error: "whatsapp not connected" };
    try {
      const quoted = quoteId ? this.recent.get(quoteId) : undefined;
      const sent = await sock.sendMessage(jid, content, quoted ? { quoted } : undefined);
      const id = sent?.key?.id;
      return id
        ? { confirmed: true, providerMessageId: id }
        : { confirmed: false, error: "no message id returned" };
    } catch (e) {
      return { confirmed: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  sendText(msg: OutgoingText): Promise<SendResult> {
    return this.enqueue(() =>
      this.deliver(msg.conversationId, { text: msg.text }, msg.quoteMessageId),
    );
  }

  sendDocument(msg: OutgoingDocument): Promise<SendResult> {
    return this.enqueue(() =>
      this.deliver(
        msg.conversationId,
        {
          document: { url: msg.filePath },
          mimetype: msg.mimeType ?? "application/octet-stream",
          fileName: msg.fileName,
          caption: msg.caption,
        },
        msg.quoteMessageId,
      ),
    );
  }

  /** For operators: wipe the stored login so the next start shows a fresh QR. */
  async resetLogin(): Promise<void> {
    await this.authClear?.();
    this.sock?.end(undefined);
  }
}

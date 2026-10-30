import type { WhatsAppProvider } from "../providers/whatsapp/types.js";

/** What the deliverer reports while it works on one request (one or several files). */
export interface ProgressSink {
  /** Called once with the number of files in the request. */
  begin(total: number): Promise<void>;
  /** The request turned out to contain `extra` more files than announced (an album). */
  expand?(extra: number): void;
  file(name: string, sizeBytes: number | null): void;
  queued(position: number): void;
  downloading(done: number, total: number | null): void;
  /** Resolves once the "sending" status is visible, so the file never lands before its status. */
  uploading(): Promise<void>;
  /** Bytes handed to WhatsApp so far (reported about once a second while sending). */
  uploadProgress?(sent: number, total: number): void;
  fileDone(ok: boolean): void;
  end(): Promise<void>;
}

export interface ProgressOptions {
  provider: WhatsAppProvider;
  conversationId: string;
  quoteMessageId?: string;
  lang: "ar" | "en";
  /** A single file smaller than this shows no status (unless it had to wait in the queue). */
  minBytes: number;
  /** Least time between edits of the status message (WhatsApp tolerates a few per ten seconds). */
  minEditGapMs?: number;
  now?: () => number;
}

const MB = 1024 * 1024;
const fmtMb = (n: number) => `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)}`;
/** Steps of 10% on purpose: the text only changes ~10 times per download, which keeps message edits few. */
const bar = (pct: number) => {
  const step = Math.max(0, Math.min(10, Math.floor(pct / 10)));
  return `[${"█".repeat(step)}${"░".repeat(10 - step)}] ${step * 10}%`;
};
const fmtDur = (s: number, ar: boolean) => {
  const r = Math.max(1, Math.round(s));
  if (r < 90) return ar ? `${r} ث` : `${r}s`;
  const m = Math.round(r / 60);
  if (m < 90) return ar ? `${m} د` : `${m} min`;
  const h = Math.floor(m / 60);
  return ar ? `${h} س ${m % 60} د` : `${h}h ${m % 60}m`;
};
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Phase = "idle" | "queued" | "download" | "upload";

/**
 * One status message per request, edited as the work moves on (queue position, download percent,
 * sending). Providers that cannot edit messages get the first status only. Never throws.
 */
export class WhatsAppProgress implements ProgressSink {
  private total = 1;
  private index = 0;
  private name = "";
  private size: number | null = null;
  private phase: Phase = "idle";
  private position = 0;
  private done = 0;
  private total_ = 0;
  private ok = 0;
  private failed = 0;
  private visible = false;
  private waitedInQueue = false;
  private messageId: string | undefined;
  private canEdit = true;
  private lastText = "";
  private lastEditAt = 0;
  private edits = 0;
  private firstSentAt = 0;
  private pending: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private uploadStartedAt = 0;
  private upSent = 0;
  private upTotal = 0;
  private speed = 0; // bytes/second, smoothed
  private lastSample: { at: number; sent: number } | null = null;
  private lastAdvanceAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly gap: number;
  private readonly now: () => number;

  constructor(private readonly o: ProgressOptions) {
    this.gap = o.minEditGapMs ?? 4000;
    this.now = o.now ?? Date.now;
  }

  async begin(total: number) {
    this.total = total;
    if (total > 1) {
      this.visible = true;
      this.refresh(true);
      await this.chain;
    }
  }

  expand(extra: number) {
    this.total += extra;
    if (this.total > 1) this.visible = true;
  }

  file(name: string, sizeBytes: number | null) {
    this.index++;
    this.name = name;
    this.size = sizeBytes;
    this.phase = "idle";
    this.done = 0;
    this.total_ = 0;
    if (this.total === 1 && sizeBytes !== null && sizeBytes >= this.o.minBytes) this.visible = true;
    this.refresh();
  }

  queued(position: number) {
    this.phase = "queued";
    this.position = position;
    this.waitedInQueue = true;
    this.visible = true;
    this.refresh();
  }

  downloading(done: number, total: number | null) {
    this.stopTicker();
    this.phase = "download";
    this.done = done;
    this.total_ = total ?? this.size ?? 0;
    this.refresh();
  }

  uploadProgress(sent: number, total: number) {
    const now = this.now();
    if (this.lastSample && now > this.lastSample.at) {
      const inst = ((sent - this.lastSample.sent) * 1000) / (now - this.lastSample.at);
      this.speed = this.speed === 0 ? inst : this.speed * 0.7 + inst * 0.3;
    }
    if (sent > this.upSent) this.lastAdvanceAt = now;
    this.lastSample = { at: now, sent };
    this.upSent = sent;
    this.upTotal = total;
    this.refresh();
  }

  async uploading() {
    this.phase = "upload";
    this.uploadStartedAt = this.now();
    this.upSent = 0;
    this.upTotal = 0;
    this.speed = 0;
    this.lastSample = null;
    this.lastAdvanceAt = this.uploadStartedAt;
    this.ticker ??= setInterval(() => this.refresh(), 5000); // keeps "connecting (Ns)" alive before bytes flow
    this.ticker.unref?.();
    this.refresh(true);
    // Wait (briefly) for the edit to land so the status is never behind the file itself.
    await Promise.race([this.chain, new Promise<void>((r) => setTimeout(r, 4000).unref?.())]);
  }

  fileDone(ok: boolean) {
    this.stopTicker();
    if (ok) this.ok++;
    else this.failed++;
    this.phase = "idle";
  }

  async end() {
    this.stopTicker();
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    if (!this.visible && !this.messageId) return;
    this.lastText = "";
    this.enqueue(this.finalText(), true);
    await this.chain;
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private finalText(): string {
    const ar = this.o.lang === "ar";
    const n = this.ok + this.failed;
    if (this.failed === 0) {
      return ar
        ? `✅ تم إرسال ${this.ok === 1 ? "الملف" : `${this.ok} ملفات`}`
        : `✅ Sent ${this.ok === 1 ? "the file" : `${this.ok} files`}`;
    }
    return ar
      ? `⚠️ أُرسل ${this.ok} من ${n}. تعذّر إرسال ${this.failed}.`
      : `⚠️ Sent ${this.ok} of ${n}; ${this.failed} could not be sent.`;
  }

  private render(): string {
    const ar = this.o.lang === "ar";
    const head =
      this.total > 1
        ? `📦 ${this.index || 1}/${this.total}${this.name ? ` • ${clip(this.name)}` : ""}`
        : `📦 ${clip(this.name || (ar ? "الملف" : "File"))}`;
    let line: string;
    if (this.phase === "queued") {
      line = ar
        ? `⏳ بالانتظار — ترتيبك ${this.position}`
        : `⏳ Waiting in line — you are number ${this.position}`;
    } else if (this.phase === "download") {
      const t = this.total_;
      line =
        t > 0
          ? `${ar ? "⬇️ تنزيل" : "⬇️ Downloading"} ${bar((this.done / t) * 100)} (${fmtMb(t)} MB)`
          : `${ar ? "⬇️ تنزيل" : "⬇️ Downloading"}…`;
    } else if (this.phase === "upload") {
      line = this.uploadLine(ar);
    } else {
      line = ar ? "⏳ جاري التجهيز…" : "⏳ Getting ready…";
    }
    return `${head}\n${line}`;
  }

  private uploadLine(ar: boolean): string {
    const now = this.now();
    const secs = Math.round((now - this.uploadStartedAt) / 1000);
    const head = ar ? "⬆️ إرسال" : "⬆️ Sending";
    if (this.upTotal <= 0 || this.upSent <= 0) {
      return ar
        ? `${head} إلى واتساب… بدء الاتصال (${secs}ث)`
        : `${head} to WhatsApp… connecting (${secs}s)`;
    }
    const pct = (this.upSent / this.upTotal) * 100;
    const stalled = Math.round((now - this.lastAdvanceAt) / 1000);
    if (stalled >= 45) {
      return ar
        ? `${head} ${bar(pct)} ⚠️ لا يتقدم منذ ${stalled}ث (قد يكون الاتصال بطيئًا)`
        : `${head} ${bar(pct)} ⚠️ no progress for ${stalled}s (connection may be slow)`;
    }
    const mbps = this.speed / MB;
    const left = this.speed > 1024 ? Math.max(0, (this.upTotal - this.upSent) / this.speed) : null;
    const speedTxt = this.speed > 1024 ? `${mbps.toFixed(mbps >= 10 ? 0 : 1)} MB/s` : "…";
    const eta =
      left === null
        ? ""
        : ar
          ? ` — متبقي ~${fmtDur(left, true)}`
          : ` — ~${fmtDur(left, false)} left`;
    return `${head} ${bar(pct)} ${speedTxt}${eta}`;
  }

  /** Coalesces updates: at most one edit per gap, always ending on the latest state. */
  private refresh(urgent = false) {
    if (!this.visible) return;
    const gap = this.phase === "upload" ? Math.max(this.gap, 6000) : this.gap;
    const since = this.now() - this.lastEditAt;
    if (urgent || since >= gap) {
      if (this.pending) clearTimeout(this.pending);
      this.pending = null;
      this.enqueue(this.render());
      return;
    }
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.enqueue(this.render());
    }, gap - since);
    this.pending.unref?.();
  }

  private enqueue(text: string, final = false) {
    this.chain = this.chain.then(() => this.push(text, final)).catch(() => undefined);
  }

  private async push(text: string, final: boolean) {
    if (text === this.lastText) return;
    try {
      if (!this.messageId) {
        const res = await this.o.provider.sendText({
          conversationId: this.o.conversationId,
          text,
          quoteMessageId: this.o.quoteMessageId,
        });
        this.messageId = res.providerMessageId;
        this.firstSentAt = this.now();
        this.lastText = text;
        this.lastEditAt = this.now();
        return;
      }
      if (!this.canEdit || !this.o.provider.editText) {
        // no editing here: the first status stays, but the outcome is still worth one message
        if (final) await this.o.provider.sendText({ conversationId: this.o.conversationId, text });
        return;
      }
      // WhatsApp only allows editing for ~15 minutes, and a cap keeps a long transfer from looking like spam.
      if (!final && (this.edits >= 40 || this.now() - this.firstSentAt > 14 * 60_000)) return;
      this.edits++;
      const ok = await this.o.provider.editText(this.o.conversationId, this.messageId, text);
      if (!ok) {
        this.canEdit = false;
        if (final) await this.o.provider.sendText({ conversationId: this.o.conversationId, text });
      } else {
        this.lastText = text;
        this.lastEditAt = this.now();
      }
    } catch {
      /* progress is a nicety; never break delivery */
    }
  }
}

import type { JobKind, JobReport } from "./scheduler.js";

export interface AlertDeps {
  /** Failures in a row before the admins are told; 0 = never. */
  threshold: () => Promise<number>;
  notifyAdmins: (text: string) => Promise<void>;
}

const SESSION_ERROR =
  /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|UNAUTHORIZED|not authorized/i;

const KIND_AR: Record<JobKind, string> = { telegram: "تيليجرام", drive: "درايف" };

/**
 * Tells the admins (on WhatsApp) when a sync keeps failing, once per outage, and again when it recovers.
 * A Telegram login that was revoked is called out separately because it needs a manual fix.
 */
export class SyncAlerts {
  private fails = new Map<JobKind, number>();
  private alerted = new Set<JobKind>();
  constructor(private readonly d: AlertDeps) {}

  async onReport(r: JobReport): Promise<void> {
    const threshold = await this.d.threshold();
    if (r.ok) {
      this.fails.set(r.kind, 0);
      if (this.alerted.delete(r.kind))
        await this.d.notifyAdmins(`✅ عادت مزامنة ${KIND_AR[r.kind]} للعمل.`);
      return;
    }
    const n = (this.fails.get(r.kind) ?? 0) + 1;
    this.fails.set(r.kind, n);
    const sessionLost = r.kind === "telegram" && SESSION_ERROR.test(r.error ?? "");
    // A lost Telegram login will not fix itself, so say so on the first failure.
    const due = sessionLost ? n >= 1 : threshold > 0 && n >= threshold;
    if (!due || this.alerted.has(r.kind)) return;
    this.alerted.add(r.kind);
    const err = (r.error ?? "").replace(/\s+/g, " ").slice(0, 160);
    await this.d.notifyAdmins(
      sessionLost
        ? `🚨 انتهت جلسة تيليجرام. شغّل telegram:login محليًا وضع الجلسة الجديدة في TELEGRAM_SESSION ثم أعد التشغيل.\n${err}`
        : `⚠️ فشلت مزامنة ${KIND_AR[r.kind]} ${n} مرات متتالية.\nآخر خطأ: ${err}\nتفاصيل: /status`,
    );
  }
}

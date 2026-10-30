import { createHmac } from "node:crypto";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { messageCatalog } from "../bot/messages.js";
import {
  formatPairs,
  parsePairs,
  removePair,
  untranslatedWords,
  upsertPair,
} from "../library/translations.js";
import type { SettingsService } from "../settings/service.js";
import type { Overview } from "./panelData.js";
import { readBody, tokenMatches } from "./server.js";

export interface PanelDeps {
  token: string;
  settings: SettingsService;
  overview: () => Promise<Overview>;
  /** Titles of the channel's index messages, to find words that have no translation yet. */
  indexTitles: () => Promise<string[]>;
  logger: { warn: (o: object, m?: string) => void };
}

const BASE = "/admin/panel";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const sessionCookie = (token: string) =>
  createHmac("sha256", token).update("library-bot-panel").digest("hex");

function cookieOf(req: HttpReq, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c1f24;--card:#fff;--line:#d9dde3;--accent:#0b6bcb;--bad:#c62828;--ok:#2e7d32;--warn:#b26a00}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--fg:#e8eaed;--card:#1e2227;--line:#343a42;--accent:#6ab0ff;--bad:#ef6b6b;--ok:#6cc070;--warn:#e0a040}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:.6rem 1rem;display:flex;gap:1rem;flex-wrap:wrap;align-items:center}
header a{color:var(--fg);text-decoration:none;padding:.25rem .6rem;border-radius:6px}header a.on{background:var(--accent);color:#fff}
main{max-width:980px;margin:0 auto;padding:1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem;margin:0 0 1rem}
h1{font-size:1.25rem;margin:.2rem 0 1rem}h2{font-size:1.05rem;margin:0 0 .6rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.7rem}
.stat b{display:block;font-size:1.4rem}.muted{opacity:.7;font-size:.9rem}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
input,textarea,button{font:inherit;padding:.4rem .6rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
input,textarea{width:100%}button{background:var(--accent);color:#fff;border:0;cursor:pointer}button.alt{background:transparent;color:var(--bad);border:1px solid var(--bad)}
table{width:100%;border-collapse:collapse}td,th{padding:.35rem .4rem;border-bottom:1px solid var(--line);vertical-align:top;text-align:start}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}.row>*{flex:1 1 140px}.row>button{flex:0 0 auto}
.flash{padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;background:var(--ok);color:#fff}.flash.err{background:var(--bad)}
`;

function page(
  title: string,
  active: string,
  body: string,
  flash?: { text: string; err?: boolean },
) {
  const nav = [
    ["", "نظرة عامة"],
    ["/translations", "قاموس الترجمة"],
    ["/texts", "نصوص البوت"],
  ]
    .map(([p, l]) => `<a href="${BASE}${p}" class="${active === p ? "on" : ""}">${l}</a>`)
    .join("");
  const note = flash ? `<div class="flash${flash.err ? " err" : ""}">${esc(flash.text)}</div>` : "";
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style><header><strong>📚 لوحة البوت</strong>${nav}</header><main>${note}${body}</main></html>`;
}

const ago = (d: Date | null) => {
  if (!d) return "—";
  const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  return m < 1
    ? "الآن"
    : m < 90
      ? `منذ ${m} د`
      : m < 2880
        ? `منذ ${Math.round(m / 60)} س`
        : `منذ ${Math.round(m / 1440)} يوم`;
};

function overviewPage(o: Overview) {
  const stat = (v: string | number, l: string) =>
    `<div class="stat"><b>${esc(v)}</b>${esc(l)}</div>`;
  const syncs = o.syncs
    .map(
      (s) =>
        `<tr><td>${esc(s.kind)}</td><td class="${s.ok ? "ok" : s.ok === false ? "bad" : "muted"}">${s.running ? `⏳ ${esc(s.running)}` : s.ok === null ? "لم تعمل بعد" : s.ok ? "✅ ناجحة" : "❌ فشلت"}</td><td>${ago(s.at)}</td><td class="muted">${esc(s.error ?? "")}</td></tr>`,
    )
    .join("");
  const src = o.sources
    .map(
      (s) =>
        `<tr><td>${s.enabled ? "🟢" : "⚪"} ${esc(s.label)}</td><td>${esc(s.status)}</td><td>${ago(s.lastSyncAt)}</td><td class="bad">${esc(s.error ?? "")}</td></tr>`,
    )
    .join("");
  const del =
    o.delivery.map((d) => `${esc(d.outcome)}: <b>${d.n}</b>`).join(" • ") || "لا توجد بيانات";
  const runs = o.recentRuns
    .map(
      (r) =>
        `<tr><td>${esc(r.kind)}</td><td class="${r.status === "ok" || r.status === "success" ? "ok" : "bad"}">${esc(r.status)}</td><td>${ago(r.at)}</td><td class="muted">${esc((r.error ?? "").slice(0, 120))}</td></tr>`,
    )
    .join("");
  return page(
    "لوحة البوت",
    "",
    `<h1>نظرة عامة</h1>
<div class="card"><div class="grid">
${stat(o.whatsapp, "واتساب")}${stat(o.counts.resources, "ملف في المكتبة")}${stat(o.counts.uncategorized, "غير مصنّف")}${stat(o.counts.subscribers, "مشترك بالإشعارات")}
${stat(`${o.load.rssMb} MB`, "الذاكرة")}${stat(o.load.freeDiskMb === null ? "—" : `${o.load.freeDiskMb} MB`, "مساحة القرص الحرة")}${stat(`${o.load.running}/${o.load.queued}`, "تسليم جارٍ / منتظر")}${stat(o.load.cached, "ملف في الكاش")}
</div></div>
<div class="card"><h2>المزامنة</h2><table>${syncs}</table></div>
<div class="card"><h2>مصادر درايف</h2><table>${src || '<tr><td class="muted">لا توجد مصادر</td></tr>'}</table></div>
<div class="card"><h2>نتائج التسليم (7 أيام)</h2><p>${del}</p></div>
<div class="card"><h2>آخر عمليات المزامنة</h2><table>${runs}</table></div>`,
  );
}

function translationsPage(
  pairs: { ar: string; en: string }[],
  missing: { word: string; n: number; sample: string }[],
  flash?: { text: string; err?: boolean },
) {
  const rows = pairs
    .map(
      (p) =>
        `<tr><td><form method="post" class="row"><input type="hidden" name="action" value="replace"><input type="hidden" name="old" value="${esc(p.ar)}"><input name="ar" value="${esc(p.ar)}" dir="rtl" aria-label="عربي"><input name="en" value="${esc(p.en)}" dir="ltr" aria-label="English"><button>حفظ</button></form></td><td style="width:1%"><form method="post"><input type="hidden" name="action" value="delete"><input type="hidden" name="ar" value="${esc(p.ar)}"><button class="alt">حذف</button></form></td></tr>`,
    )
    .join("");
  const miss = missing
    .map(
      (m) =>
        `<tr><td><form method="post" class="row"><input type="hidden" name="action" value="add"><input type="hidden" name="en" value="${esc(m.word)}"><b dir="ltr">${esc(m.word)}</b><input name="ar" placeholder="المقابل العربي" dir="rtl" required><button>إضافة</button></form><div class="muted" dir="ltr">${m.n}× — ${esc(m.sample.slice(0, 70))}</div></td></tr>`,
    )
    .join("");
  return page(
    "قاموس الترجمة",
    "/translations",
    `<h1>قاموس الترجمة (عربي ⇄ إنجليزي)</h1>
<p class="muted">يُستعمل عند الكتابة للانتقال لفهرس مادة وعند البحث في الملفات: من يكتب «كيمياء حيوية» يصل إلى ما عنوانه Biochemistry والعكس. التغيير يسري فورًا دون إعادة تشغيل.</p>
<div class="card"><h2>إضافة أو استبدال</h2><form method="post" class="row"><input type="hidden" name="action" value="add"><input name="ar" placeholder="بالعربية (مثال: كيمياء حيوية)" dir="rtl" required><input name="en" placeholder="English (e.g. biochemistry)" dir="ltr" required><button>حفظ</button></form><p class="muted">إن وُجد نفس الكلمة العربية من قبل فستُستبدل ترجمتها القديمة.</p></div>
<div class="card"><h2>كلمات إنجليزية في عناوين الفهارس بلا مقابل عربي (${missing.length})</h2><table>${miss || '<tr><td class="muted">كل الكلمات لها مقابل 🎉</td></tr>'}</table></div>
<div class="card"><h2>الترجمات الحالية (${pairs.length})</h2><input id="q" placeholder="بحث…" oninput="for(const r of document.querySelectorAll('#pairs tr'))r.hidden=!r.innerText.toLowerCase().includes(this.value.toLowerCase())&&!Array.from(r.querySelectorAll('input[name=ar],input[name=en]')).some(i=>i.value.toLowerCase().includes(this.value.toLowerCase()))"><table id="pairs">${rows}</table></div>
<div class="card"><h2>تحرير نصي كامل</h2><form method="post"><input type="hidden" name="action" value="bulk"><textarea name="lines" rows="10" dir="auto">${esc(formatPairs(pairs).join("\n"))}</textarea><p class="muted">سطر لكل ترجمة بصيغة عربي=English. يستبدل القائمة كلها.</p><button>حفظ القائمة</button></form></div>`,
    flash,
  );
}

function textsPage(overrides: Record<string, string>, flash?: { text: string; err?: boolean }) {
  const rows = messageCatalog()
    .map((m) => {
      const cell = (lang: "ar" | "en", dflt: string) => {
        const k = `${m.key}.${lang}`;
        const custom = overrides[k]?.trim();
        return `<td><div class="muted" dir="${lang === "ar" ? "rtl" : "ltr"}" style="white-space:pre-wrap">${esc(dflt)}</div><textarea name="t.${esc(k)}" rows="3" dir="${lang === "ar" ? "rtl" : "ltr"}" placeholder="اتركه فارغًا لاستعمال الأصلي">${esc(overrides[k] ?? "")}</textarea>${custom ? '<span class="warn">معدَّل</span>' : ""}</td>`;
      };
      return `<tr><td><code>${esc(m.key)}</code></td>${cell("ar", m.ar)}${cell("en", m.en)}</tr>`;
    })
    .join("");
  return page(
    "نصوص البوت",
    "/texts",
    `<h1>نصوص البوت</h1><p class="muted">غيّر صياغة رسائل البوت بالعربية والإنجليزية. الحقل الفارغ = النص الأصلي. المتغيرات مثل {n} و{list} اتركها كما هي.</p>
<form method="post" class="card"><table><tr><th>المفتاح</th><th>العربية</th><th>English</th></tr>${rows}</table><p><button>حفظ كل التعديلات</button></p></form>`,
    flash,
  );
}

/**
 * The admin web panel: read-only health overview plus editors for the translation dictionary and the
 * bot's texts. Signed in with ADMIN_HTTP_TOKEN, then a cookie. Returns true when the request was handled.
 */
export function createPanel(deps: PanelDeps) {
  const html = (
    res: ServerResponse,
    code: number,
    body: string,
    headers: Record<string, string> = {},
  ) =>
    res
      .writeHead(code, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'",
        ...headers,
      })
      .end(body);

  const loginPage = (err?: boolean) =>
    `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>دخول</title><style>${CSS}</style><main style="max-width:380px"><div class="card"><h1>🔐 دخول لوحة البوت</h1>${err ? '<p class="bad">الرمز غير صحيح.</p>' : ""}<form method="post" action="${BASE}/login"><input type="password" name="token" placeholder="ADMIN_HTTP_TOKEN" autocomplete="current-password" required><p><button>دخول</button></p></form></div></main></html>`;

  const setCookie = (req: HttpReq) =>
    `bp=${sessionCookie(deps.token)}; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=2592000${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`;

  return async (req: HttpReq, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return false;
    const sub = url.pathname.slice(BASE.length) || "";
    const post = req.method === "POST";
    const get = req.method === "GET" || req.method === "HEAD";

    if (post && sub === "/login") {
      const form = new URLSearchParams((await readBody(req)) ?? "");
      if (!tokenMatches(form.get("token"), deps.token)) {
        html(res, 401, loginPage(true));
        return true;
      }
      res.writeHead(303, { location: BASE, "set-cookie": setCookie(req) }).end();
      return true;
    }
    // Link with ?token=… signs in once and removes the token from the address bar.
    const qt = url.searchParams.get("token");
    if (get && qt && tokenMatches(qt, deps.token)) {
      res.writeHead(303, { location: BASE, "set-cookie": setCookie(req) }).end();
      return true;
    }
    if (!tokenMatches(cookieOf(req, "bp"), sessionCookie(deps.token))) {
      html(res, 401, loginPage());
      return true;
    }

    if (get && sub === "") {
      html(res, 200, overviewPage(await deps.overview()));
      return true;
    }

    if (sub === "/translations" && (get || post)) {
      const pairs0 = parsePairs(await deps.settings.get("library.indexAliases"));
      let flash: { text: string; err?: boolean } | undefined;
      if (post) {
        const form = new URLSearchParams((await readBody(req)) ?? "");
        const action = form.get("action");
        const ar = form.get("ar") ?? "";
        const en = form.get("en") ?? "";
        let next = pairs0;
        if (action === "add") next = upsertPair(pairs0, { ar, en });
        else if (action === "replace")
          next = upsertPair(removePair(pairs0, form.get("old") ?? ""), { ar, en });
        else if (action === "delete") next = removePair(pairs0, ar);
        else if (action === "bulk") next = parsePairs((form.get("lines") ?? "").split(/\r?\n/));
        if (next === pairs0 && action !== "bulk")
          flash = { text: "لم يُحفظ شيء: املأ الحقلين.", err: true };
        else {
          try {
            await deps.settings.set("library.indexAliases", formatPairs(next), "panel");
            flash = { text: "تم الحفظ ✅" };
          } catch (e) {
            flash = { text: e instanceof Error ? e.message : "تعذّر الحفظ", err: true };
          }
        }
      }
      const pairs = parsePairs(await deps.settings.get("library.indexAliases"));
      const missing = untranslatedWords(await deps.indexTitles(), pairs);
      html(res, 200, translationsPage(pairs, missing, flash));
      return true;
    }

    if (sub === "/texts" && (get || post)) {
      let flash: { text: string; err?: boolean } | undefined;
      if (post) {
        const form = new URLSearchParams((await readBody(req)) ?? "");
        const known = new Set(messageCatalog().flatMap((m) => [`${m.key}.ar`, `${m.key}.en`]));
        const next: Record<string, string> = {};
        for (const [k, v] of form) {
          if (k.startsWith("t.") && known.has(k.slice(2)) && v.trim())
            next[k.slice(2)] = v.replace(/\r\n/g, "\n");
        }
        try {
          await deps.settings.set("text.overrides", next, "panel");
          flash = { text: "تم الحفظ ✅" };
        } catch (e) {
          flash = { text: e instanceof Error ? e.message : "تعذّر الحفظ", err: true };
        }
      }
      html(res, 200, textsPage(await deps.settings.get("text.overrides"), flash));
      return true;
    }

    html(res, 404, page("غير موجود", "", "<h1>الصفحة غير موجودة</h1>"));
    return true;
  };
}

import { createHmac } from "node:crypto";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import type { Overview } from "./panelData.js";
import { readBody, tokenMatches } from "./server.js";

export interface PanelDeps {
  token: string;
  overview: () => Promise<Overview>;
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

function page(title: string, body: string) {
  return `<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style><header><strong>📚 Library bot</strong></header><main>${body}</main></html>`;
}

const ago = (d: Date | null) => {
  if (!d) return "—";
  const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  return m < 1
    ? "just now"
    : m < 90
      ? `${m} min ago`
      : m < 2880
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} d ago`;
};

function overviewPage(o: Overview) {
  const stat = (v: string | number, l: string) =>
    `<div class="stat"><b>${esc(v)}</b>${esc(l)}</div>`;
  const syncs = o.syncs
    .map(
      (s) =>
        `<tr><td>${esc(s.kind)}</td><td class="${s.ok ? "ok" : s.ok === false ? "bad" : "muted"}">${s.running ? `⏳ ${esc(s.running)}` : s.ok === null ? "not run yet" : s.ok ? "✅ ok" : "❌ failed"}</td><td>${ago(s.at)}</td><td class="muted">${esc(s.error ?? "")}</td></tr>`,
    )
    .join("");
  const src = o.sources
    .map(
      (s) =>
        `<tr><td>${s.enabled ? "🟢" : "⚪"} ${esc(s.label)}</td><td>${esc(s.status)}</td><td>${ago(s.lastSyncAt)}</td><td class="bad">${esc(s.error ?? "")}</td></tr>`,
    )
    .join("");
  const del = o.delivery.map((d) => `${esc(d.outcome)}: <b>${d.n}</b>`).join(" • ") || "no data";
  const runs = o.recentRuns
    .map(
      (r) =>
        `<tr><td>${esc(r.kind)}</td><td class="${r.status === "ok" ? "ok" : "bad"}">${esc(r.status)}</td><td>${ago(r.at)}</td><td class="muted">${esc((r.error ?? "").slice(0, 120))}</td></tr>`,
    )
    .join("");
  return page(
    "Library bot",
    `<h1>Overview</h1>
<div class="card"><div class="grid">
${stat(o.whatsapp, "WhatsApp")}${stat(o.counts.resources, "files in library")}${stat(o.counts.uncategorized, "uncategorized")}${stat(o.counts.subscribers, "subscribers")}
${stat(`${o.load.rssMb} MB`, "memory")}${stat(o.load.freeDiskMb === null ? "—" : `${o.load.freeDiskMb} MB`, "free disk")}${stat(`${o.load.running}/${o.load.queued}`, "deliveries running / waiting")}${stat(o.load.cached, "files in upload cache")}
</div></div>
<div class="card"><h2>Sync</h2><table>${syncs}</table></div>
<div class="card"><h2>Drive sources</h2><table>${src || '<tr><td class="muted">none</td></tr>'}</table></div>
<div class="card"><h2>Delivery results (7 days)</h2><p>${del}</p></div>
<div class="card"><h2>Recent sync runs</h2><table>${runs}</table></div>`,
  );
}

/**
 * The admin web panel: a read-only health overview. Signed in with ADMIN_HTTP_TOKEN, then a cookie.
 * Returns true when the request was handled.
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
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        ...headers,
      })
      .end(body);

  const loginPage = (err?: boolean) =>
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><style>${CSS}</style><main style="max-width:380px"><div class="card"><h1>🔐 Sign in</h1>${err ? '<p class="bad">Wrong token.</p>' : ""}<form method="post" action="${BASE}/login"><input type="password" name="token" placeholder="ADMIN_HTTP_TOKEN" autocomplete="current-password" required><p><button>Sign in</button></p></form></div></main></html>`;

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
    // A link with ?token=… signs in once and removes the token from the address bar.
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
    html(res, 404, page("Not found", "<h1>Not found</h1>"));
    return true;
  };
}

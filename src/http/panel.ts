import { createHmac } from "node:crypto";
import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import type { BridgeUi } from "./bridgePanel.js";
import type { Overview } from "./panelData.js";
import { readBody, tokenMatches } from "./server.js";
import { BASE, CSS, esc, page } from "./ui.js";

export interface PanelDeps {
  token: string;
  overview: () => Promise<Overview>;
  logger: { warn: (o: object, m?: string) => void };
  /** WhatsApp <-> Telegram bridge pages (same sign-in as the rest of the panel). */
  bridge?: BridgeUi;
}

const sessionCookie = (token: string) =>
  createHmac("sha256", token).update("library-bot-panel").digest("hex");

function cookieOf(req: HttpReq, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
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
    if (deps.bridge && (sub === "/bridge" || sub.startsWith("/bridge/"))) {
      const r = await deps.bridge(req, sub.slice("/bridge".length) || "/", url);
      if (r.redirect) res.writeHead(303, { location: r.redirect }).end();
      else html(res, r.code ?? 200, r.body ?? "");
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

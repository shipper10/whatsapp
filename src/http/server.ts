import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage as HttpReq,
  type Server,
  type ServerResponse,
} from "node:http";
import QRCode from "qrcode";
import { parseWebhook, verifySignature } from "../providers/whatsapp/openwa.js";
import type { IncomingMessage } from "../providers/whatsapp/types.js";

const MAX_BODY = 1_048_576;

export interface LinkAdmin {
  /** Shared secret for /admin/link (sent as ?token= or Authorization: Bearer). */
  token: string;
  status: () => { state: string; qr?: string; me?: string };
  pairingCode: (phone: string) => Promise<string>;
}

export interface ServerDeps {
  /** OpenWA mode only. */
  webhook?: {
    secret: string;
    sessionId: string;
    onMessage: (eventId: string, msg: IncomingMessage) => Promise<void>;
  };
  /** Lite mode only. */
  link?: LinkAdmin;
  health: () => Promise<boolean>;
  logger: { warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
}

function readBody(req: HttpReq): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const send = (res: ServerResponse, code: number, body = "") =>
  res.writeHead(code, { "content-type": "application/json" }).end(body);

const html = (res: ServerResponse, code: number, body: string) =>
  res
    .writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    .end(body);

export function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function linkPage(link: LinkAdmin, token: string): Promise<string> {
  const st = link.status();
  let body: string;
  if (st.state === "open") body = `<p>✅ Linked${st.me ? `: ${esc(st.me)}` : ""}</p>`;
  else if (st.state === "qr" && st.qr) {
    const svg = await QRCode.toString(st.qr, { type: "svg", margin: 1, width: 280 });
    body = `${svg}<p>WhatsApp → Linked devices → Link a device → scan.</p>`;
  } else body = `<p>State: ${esc(st.state)}. Refreshing…</p>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="8"><title>Link WhatsApp</title><body style="font-family:sans-serif;text-align:center;padding:2rem">${body}<hr><form method="get" action="/admin/link/pair"><input type="hidden" name="token" value="${esc(token)}"><input name="phone" placeholder="Phone with country code, digits only" size="30"><button>Get pairing code</button></form></body>`;
}

export function createAppServer(deps: ServerDeps): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const readOnly = req.method === "GET" || req.method === "HEAD"; // uptime monitors often use HEAD
      if (readOnly && url.pathname === "/healthz") {
        const ok = await deps.health().catch(() => false);
        return send(res, ok ? 200 : 503, JSON.stringify({ ok }));
      }
      if (readOnly && url.pathname === "/") {
        return res
          .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          .end("Library bot is running.\n");
      }
      if (deps.link && req.method === "GET" && url.pathname.startsWith("/admin/link")) {
        const bearer = req.headers.authorization?.replace(/^Bearer /i, "");
        const token = url.searchParams.get("token") ?? bearer;
        if (!tokenMatches(token, deps.link.token)) return send(res, 401);
        if (url.pathname === "/admin/link/pair") {
          const phone = url.searchParams.get("phone") ?? "";
          if (!/^\d{7,15}$/.test(phone))
            return html(res, 400, "Invalid phone: digits only, with country code.");
          try {
            const code = await deps.link.pairingCode(phone);
            return html(
              res,
              200,
              `<body style="font-family:sans-serif;text-align:center;padding:2rem"><h1 dir="ltr">${esc(code)}</h1><p>WhatsApp → Linked devices → Link with phone number instead.</p>`,
            );
          } catch (e) {
            return html(res, 409, esc(e instanceof Error ? e.message : String(e)));
          }
        }
        if (url.pathname === "/admin/link/status")
          return send(res, 200, JSON.stringify({ state: deps.link.status().state }));
        return html(res, 200, await linkPage(deps.link, token ?? ""));
      }
      if (deps.webhook && req.method === "POST" && req.url === "/webhooks/openwa") {
        const wh = deps.webhook;
        const raw = await readBody(req);
        if (raw === null) return send(res, 413);
        const sig = req.headers["x-openwa-signature"];
        if (!verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, wh.secret)) {
          deps.logger.warn({}, "webhook rejected: bad signature");
          return send(res, 401);
        }
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          return send(res, 400);
        }
        // Acknowledge first: OpenWA retries on slow/failed responses, and handling can take seconds.
        send(res, 200, '{"ok":true}');
        const parsed = parseWebhook(json, wh.sessionId);
        if (parsed) void wh.onMessage(parsed.eventId, parsed.message);
        return;
      }
      send(res, 404);
    } catch (err) {
      deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "http error");
      if (!res.headersSent) send(res, 500);
    }
  });
}

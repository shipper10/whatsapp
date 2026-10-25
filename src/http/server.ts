import {
  createServer,
  type IncomingMessage as HttpReq,
  type Server,
  type ServerResponse,
} from "node:http";
import { parseWebhook, verifySignature } from "../providers/whatsapp/openwa.js";
import type { IncomingMessage } from "../providers/whatsapp/types.js";

const MAX_BODY = 1_048_576;

export interface ServerDeps {
  webhookSecret: string;
  sessionId: string;
  health: () => Promise<boolean>;
  onMessage: (eventId: string, msg: IncomingMessage) => Promise<void>;
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

export function createAppServer(deps: ServerDeps): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        const ok = await deps.health().catch(() => false);
        return send(res, ok ? 200 : 503, JSON.stringify({ ok }));
      }
      if (req.method === "POST" && req.url === "/webhooks/openwa") {
        const raw = await readBody(req);
        if (raw === null) return send(res, 413);
        const sig = req.headers["x-openwa-signature"];
        if (!verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, deps.webhookSecret)) {
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
        const parsed = parseWebhook(json, deps.sessionId);
        if (parsed) void deps.onMessage(parsed.eventId, parsed.message);
        return;
      }
      send(res, 404);
    } catch (err) {
      deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "http error");
      if (!res.headersSent) send(res, 500);
    }
  });
}

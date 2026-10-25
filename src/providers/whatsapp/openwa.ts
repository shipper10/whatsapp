import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  IncomingMessage,
  OutgoingDocument,
  OutgoingText,
  SendResult,
  WhatsAppProvider,
} from "./types.js";

/** `X-OpenWA-Signature: sha256=<hex>` over the raw request body. Constant-time compare. */
export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ParsedWebhook {
  /** Stable id for redelivery de-duplication. */
  eventId: string;
  message: IncomingMessage;
}

interface OpenWaEnvelope {
  event?: string;
  sessionId?: string;
  idempotencyKey?: string;
  data?: {
    id?: string;
    from?: string;
    chatId?: string;
    author?: string;
    senderPhone?: string | null;
    body?: string;
    type?: string;
    timestamp?: number;
    fromMe?: boolean;
    isGroup?: boolean;
    kind?: string;
    isStatusBroadcast?: boolean;
    mentionedIds?: string[];
  };
}

/**
 * Maps an OpenWA `message.received` webhook to a neutral IncomingMessage.
 * Returns null for anything the bot must ignore (other events, own messages, status/broadcast, non-text).
 * In groups the participant is the real sender (`author`), never the group id; if it cannot be determined
 * participantId is "" and the session layer refuses to proceed instead of sharing group state.
 */
export function parseWebhook(body: unknown, expectedSessionId: string): ParsedWebhook | null {
  const env = body as OpenWaEnvelope;
  const d = env?.data;
  if (!env || env.event !== "message.received" || !d) return null;
  if (env.sessionId !== expectedSessionId) return null;
  if (d.fromMe || d.isStatusBroadcast || !d.chatId || !d.id) return null;
  if (d.kind && d.kind !== "individual" && d.kind !== "group") return null;
  if (d.type !== "text" && d.type !== undefined) return null;
  const text = (d.body ?? "").trim();
  if (!text) return null;

  const isGroup = d.isGroup ?? d.chatId.endsWith("@g.us");
  const phoneAsId = d.senderPhone ? `${d.senderPhone}@c.us` : "";
  const participantId = isGroup ? (d.author ?? phoneAsId) : d.chatId;
  return {
    eventId: env.idempotencyKey ?? `${env.sessionId}:${d.id}`,
    message: {
      provider: "openwa",
      conversationId: d.chatId,
      participantId,
      isGroup,
      messageId: d.id,
      text,
      timestamp: d.timestamp ?? Math.floor(Date.now() / 1000),
      fromMe: false,
      mentionedIds: d.mentionedIds ?? [],
    },
  };
}

export interface OpenWaConfig {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenWaProvider implements WhatsAppProvider {
  readonly name = "openwa";
  private readonly f: typeof fetch;

  constructor(private readonly cfg: OpenWaConfig) {
    this.f = cfg.fetchImpl ?? fetch;
  }

  private async post(path: string, body: object, timeoutMs: number): Promise<SendResult> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(this.cfg.sessionId)}/messages/${path}`;
    const idem = randomUUID(); // same key on retry => OpenWA will not send twice
    let lastError = "unknown";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.f(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.cfg.apiKey,
            "idempotency-key": idem,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const json = (await res.json().catch(() => ({}))) as { messageId?: string; id?: string };
          return { confirmed: true, providerMessageId: json.messageId ?? json.id };
        }
        lastError = `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 409) break; // client errors are not retryable
      } catch (err) {
        lastError = err instanceof Error ? err.name : "network error";
      }
    }
    return { confirmed: false, error: lastError };
  }

  sendText(msg: OutgoingText) {
    return this.post(
      "send-text",
      {
        chatId: msg.conversationId,
        text: msg.text,
        ...(msg.quoteMessageId ? { quotedMessageId: msg.quoteMessageId } : {}),
      },
      this.cfg.timeoutMs ?? 20_000,
    );
  }

  async sendDocument(msg: OutgoingDocument) {
    const base64 = (await readFile(msg.filePath)).toString("base64");
    return this.post(
      "send-document",
      {
        chatId: msg.conversationId,
        base64,
        mimetype: msg.mimeType ?? "application/octet-stream",
        filename: msg.fileName,
        ...(msg.caption ? { caption: msg.caption } : {}),
        ...(msg.quoteMessageId ? { quotedMessageId: msg.quoteMessageId } : {}),
      },
      (this.cfg.timeoutMs ?? 20_000) * 6,
    );
  }
}

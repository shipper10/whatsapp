import type { ProgressSink } from "./progress.js";

export interface DeliveryTarget {
  /** Receives queue position, download percent and send status for this request. */
  progress?: ProgressSink;
  conversationId: string;
  /** Provider id of the message to quote (set in groups). */
  quoteMessageId?: string;
  /** The person's own language, when they chose one. */
  lang?: "ar" | "en";
}

export interface Deliverer {
  /** Sends the resource (and/or its links) to the target. Must never throw for expected failures. */
  deliver(resourceId: number, target: DeliveryTarget): Promise<void>;
  /** Sends the file of any synced Telegram message (with its text as caption), even if it is not a classified resource. */
  deliverMessage(messageId: number, target: DeliveryTarget): Promise<void>;
}

export interface DeliveryTarget {
  conversationId: string;
  /** Provider id of the message to quote (set in groups). */
  quoteMessageId?: string;
}

export interface Deliverer {
  /** Sends the resource (and/or its links) to the target. Must never throw for expected failures. */
  deliver(resourceId: number, target: DeliveryTarget): Promise<void>;
}

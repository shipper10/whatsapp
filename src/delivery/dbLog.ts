import type { Db } from "../db/client.js";
import { deliveryLogs } from "../db/schema.js";
import type { DeliveryLog } from "./fileDeliverer.js";

export class DbDeliveryLog implements DeliveryLog {
  constructor(private readonly db: Db) {}
  async record(
    resourceId: number | null,
    outcome: "file_sent" | "links_only" | "unavailable",
    sanitizedError?: string,
  ) {
    await this.db
      .insert(deliveryLogs)
      .values({ resourceId, outcome, error: sanitizedError ?? null });
  }
}

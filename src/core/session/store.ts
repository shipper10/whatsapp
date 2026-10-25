import { and, eq, lt } from "drizzle-orm";
import type { SessionState } from "../../bot/types.js";
import type { Db } from "../../db/client.js";
import { userSessions } from "../../db/schema.js";
import type { SessionKey } from "./key.js";

export interface SessionStore {
  /** Returns null when missing or expired. */
  get(key: SessionKey): Promise<SessionState | null>;
  save(key: SessionKey, state: SessionState, ttlMinutes: number): Promise<void>;
  purgeExpired(): Promise<number>;
}

/** Persistent per-participant sessions: survive restarts, unique on (provider, conversation, participant). */
export class DbSessionStore implements SessionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private where(k: SessionKey) {
    return and(
      eq(userSessions.provider, k.provider),
      eq(userSessions.conversationId, k.conversationId),
      eq(userSessions.participantId, k.participantId),
    );
  }

  async get(key: SessionKey) {
    const [row] = await this.db.select().from(userSessions).where(this.where(key));
    if (!row || row.expiresAt <= this.now()) return null;
    return row.sessionDataJson as SessionState;
  }

  async save(key: SessionKey, state: SessionState, ttlMinutes: number) {
    const expiresAt = new Date(this.now().getTime() + ttlMinutes * 60_000);
    const page = "page" in state.view ? state.view.page : 1;
    const values = {
      ...key,
      currentMenu: state.view.type,
      sessionDataJson: state,
      pageNumber: page,
      expiresAt,
      updatedAt: this.now(),
    };
    await this.db
      .insert(userSessions)
      .values(values)
      .onConflictDoUpdate({
        target: [userSessions.provider, userSessions.conversationId, userSessions.participantId],
        set: values,
      });
  }

  async purgeExpired() {
    const res = await this.db
      .delete(userSessions)
      .where(lt(userSessions.expiresAt, this.now()))
      .returning({ id: userSessions.id });
    return res.length;
  }
}

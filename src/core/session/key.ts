import type { IncomingMessage } from "../../providers/whatsapp/types.js";

export class MissingParticipantError extends Error {
  constructor() {
    super("Group message without a reliable participant id; refusing to share group state.");
  }
}

export interface SessionKey {
  provider: string;
  conversationId: string;
  participantId: string;
}

/**
 * Composite session key: provider + conversation + participant.
 * In a group the participant MUST be the real sender; we never fall back to the group id.
 */
export function sessionKeyFor(m: IncomingMessage): SessionKey {
  const participantId = m.participantId?.trim();
  if (!participantId || (m.isGroup && participantId === m.conversationId)) {
    throw new MissingParticipantError();
  }
  return { provider: m.provider, conversationId: m.conversationId, participantId };
}

export const sessionKeyString = (k: SessionKey) =>
  `${k.provider}|${k.conversationId}|${k.participantId}`;

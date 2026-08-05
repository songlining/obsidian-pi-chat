/**
 * Conversation registry — the plugin's own list of conversations.
 *
 * A conversation is the user-facing unit (what the bottom-right picker shows
 * and manages). It is NOT a Pi session: a conversation *contains* a Pi session
 * (its `sessionFile`) once the user has actually chatted in it. The registry
 * starts empty — nothing outside the plugin is imported.
 */
export interface ConversationRecord {
  /** Stable id, e.g. `conv-<ts>-<rand>`; doubles as the leaf view-state key. */
  id: string;
  /** User-facing name (empty until the user renames it). */
  name: string;
  /** Pi session file this conversation contains, once it exists. */
  sessionFile: string | null;
  createdAt: number;
  updatedAt: number;
}

export function newConversationId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function conversationLabel(record: ConversationRecord): string {
  return record.name || "Unnamed conversation";
}

/** Newest-first ordering for the picker. */
export function sortConversations(records: ConversationRecord[]): ConversationRecord[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createConversationRecord(
  id: string = newConversationId(),
  name = "",
): ConversationRecord {
  const now = Date.now();
  return { id, name, sessionFile: null, createdAt: now, updatedAt: now };
}

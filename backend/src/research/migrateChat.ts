import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

type MigratableDb = Pick<Database.Database, 'exec' | 'prepare' | 'transaction'>;

const MIGRATION_KEY = 'chat-conversations-to-research-2026-08';

type ChatConversationRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type ChatMessageRow = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  status: string;
  created_at: string;
};

/**
 * Copy legacy chat conversations and messages into the research tables (§8). The migration is
 * idempotent (guarded by a recorded migration key), transactional (all-or-nothing), and maps old
 * chat IDs to stable research IDs so re-running never duplicates rows. Old chat tables are kept.
 */
export function migrateChatConversationsToResearch(sqlite: MigratableDb) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const alreadyApplied = sqlite
    .prepare('SELECT key FROM schema_migrations WHERE key = ?')
    .get(MIGRATION_KEY) as { key: string } | undefined;
  if (alreadyApplied) return;

  // The chat tables may not exist on a fresh install; nothing to migrate then.
  const chatConversationTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_conversations'")
    .get() as { name: string } | undefined;
  const chatMessageTable = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'")
    .get() as { name: string } | undefined;

  const run = sqlite.transaction(() => {
    if (chatConversationTable && chatMessageTable) {
      const conversations = sqlite
        .prepare('SELECT * FROM chat_conversations')
        .all() as ChatConversationRow[];

      const insertConversation = sqlite.prepare(`
        INSERT OR IGNORE INTO research_conversations (id, title, topic, summary, created_at, updated_at)
        VALUES (?, ?, NULL, NULL, ?, ?)
      `);
      const insertMessage = sqlite.prepare(`
        INSERT OR IGNORE INTO research_messages (id, conversation_id, role, content, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const listMessages = sqlite.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC');

      for (const conversation of conversations) {
        const researchConversationId = mapId('conversation', conversation.id);
        insertConversation.run(
          researchConversationId,
          conversation.title,
          conversation.created_at,
          conversation.updated_at
        );

        const messages = listMessages.all(conversation.id) as ChatMessageRow[];
        for (const message of messages) {
          insertMessage.run(
            mapId('message', message.id),
            researchConversationId,
            message.role,
            message.content,
            message.status,
            message.created_at
          );
        }
      }
    }

    sqlite
      .prepare('INSERT OR IGNORE INTO schema_migrations (key, applied_at) VALUES (?, ?)')
      .run(MIGRATION_KEY, new Date().toISOString());
  });

  run();
}

/**
 * Deterministically derive a research row ID from a chat row ID so re-running the migration
 * targets the same rows. Formatted as a UUID-shaped string for consistency with randomUUID().
 */
export function mapId(kind: 'conversation' | 'message', chatId: string): string {
  const hex = createHash('sha256').update(`chat:${kind}:${chatId}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

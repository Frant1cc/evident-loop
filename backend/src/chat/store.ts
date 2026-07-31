import { randomUUID } from 'node:crypto';

import { sqlite } from '../db.js';
import type { ChatConversation, ChatConversationDetail, ChatMessage, ChatMessageStatus } from './types.js';

type ConversationRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  status: ChatMessageStatus;
  created_at: string;
};

export function listChatConversations(): ChatConversation[] {
  return sqlite
    .prepare('SELECT * FROM chat_conversations ORDER BY updated_at DESC')
    .all()
    .map((row) => toConversation(row as ConversationRow));
}

export function createChatConversation(): ChatConversation {
  const now = new Date().toISOString();
  const conversation: ChatConversation = {
    id: randomUUID(),
    title: '新会话',
    createdAt: now,
    updatedAt: now
  };

  sqlite
    .prepare('INSERT INTO chat_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt);

  return conversation;
}

export function getChatConversation(id: string): ChatConversation | undefined {
  const row = sqlite.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  return row ? toConversation(row) : undefined;
}

export function updateChatConversationTitle(id: string, title: string): ChatConversation | undefined {
  const updatedAt = new Date().toISOString();
  const result = sqlite.prepare('UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, updatedAt, id);
  if (!result.changes) return undefined;
  return getChatConversation(id);
}

export function createChatMessage(input: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
  const message: ChatMessage = {
    id: randomUUID(),
    ...input,
    createdAt: new Date().toISOString()
  };

  sqlite
    .prepare('INSERT INTO chat_messages (id, conversation_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(message.id, message.conversationId, message.role, message.content, message.status, message.createdAt);
  touchConversation(message.conversationId);
  return message;
}

export function updateChatMessage(id: string, changes: Pick<ChatMessage, 'content' | 'status'>): ChatMessage | undefined {
  sqlite.prepare('UPDATE chat_messages SET content = ?, status = ? WHERE id = ?').run(changes.content, changes.status, id);
  const row = sqlite.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as MessageRow | undefined;
  if (!row) return undefined;
  touchConversation(row.conversation_id);
  return toMessage(row);
}

export function listChatMessages(conversationId: string): ChatMessage[] {
  return sqlite
    .prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId)
    .map((row) => toMessage(row as MessageRow));
}

export function deleteChatConversation(id: string): boolean {
  return sqlite.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id).changes > 0;
}

export function getChatConversationDetail(conversationId: string): ChatConversationDetail | undefined {
  const conversation = getChatConversation(conversationId);
  return conversation ? { conversation, messages: listChatMessages(conversationId) } : undefined;
}

export function createConversationTitle(content: string): string {
  return content.length > 28 ? `${content.slice(0, 28)}...` : content;
}

function touchConversation(id: string) {
  sqlite.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

function toConversation(row: ConversationRow): ChatConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.created_at
  };
}

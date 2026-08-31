import { createHash } from 'node:crypto';

import {
  getResearchConversation,
  listResearchMessages,
  listResearchNotes,
  listResearchSources
} from '../../research/store.js';
import type { ResearchSnapshot } from './types.js';

/**
 * Builds the only input that the artifact agent is allowed to see. Tool traces,
 * system prompts, and streaming messages are intentionally absent.
 */
export function createResearchSnapshot(conversationId: string, now = new Date()): ResearchSnapshot {
  const conversation = getResearchConversation(conversationId);
  if (!conversation) throw new Error('Research conversation not found');

  const messages = listResearchMessages(conversationId)
    .filter((message) => message.status === 'complete')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    }))
    .sort(compareByCreatedAtAndId);
  const sources = listResearchSources(conversationId)
    .map((source) => ({
      id: source.id,
      citationKey: source.citationKey,
      title: source.title,
      file: source.file,
      ...(source.heading ? { heading: source.heading } : {}),
      content: source.content,
      startLine: source.startLine,
      endLine: source.endLine,
      score: source.score
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const notes = listResearchNotes(conversationId)
    .map((note) => ({
      id: note.id,
      content: note.content,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const stable = {
    conversationId,
    conversationTitle: conversation.title,
    ...(conversation.topic ? { topic: conversation.topic } : {}),
    ...(conversation.summary ? { summary: conversation.summary } : {}),
    messages,
    sources,
    notes
  };
  const digest = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return {
    ...stable,
    capturedAt: now.toISOString(),
    digest
  };
}

export function isResearchSnapshotStale(snapshot: ResearchSnapshot) {
  return createResearchSnapshot(snapshot.conversationId).digest !== snapshot.digest;
}

function compareByCreatedAtAndId(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

import { randomUUID } from 'node:crypto';

import { sqlite } from '../db.js';
import { redactToolArguments } from '../approvals/manager.js';
import type { RagSource } from '../rag/types.js';
import { parseLocator } from '../knowledge/locator.js';
import type { KnowledgeFormat } from '../knowledge/types.js';
import type { ContextState } from '../context/index.js';
import type {
  ResearchConversation,
  ResearchConversationDetail,
  ResearchMessage,
  ResearchMessageStatus,
  ResearchNote,
  ResearchPromptPreview,
  ResearchRun,
  ResearchRunInput,
  ResearchRunStatus,
  ResearchSource,
  ResearchStep,
  ResearchStepStatus,
  ResearchStepType
} from './types.js';

type ConversationRow = {
  id: string;
  title: string;
  topic: string | null;
  summary: string | null;
  context_state_json: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  status: ResearchMessageStatus;
  created_at: string;
};

type StepRow = {
  id: string;
  conversation_id: string;
  message_id: string;
  sequence: number;
  type: ResearchStepType;
  status: ResearchStepStatus;
  title: string;
  input_json: string | null;
  output_json: string | null;
  parent_step_id: string | null;
  tool_call_id: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};

type SourceRow = {
  id: string;
  message_id: string;
  source_id: string;
  citation_key: string;
  file: string;
  title: string;
  heading: string | null;
  content: string;
  start_line: number;
  end_line: number;
  score: number;
  locator_json: string | null;
  created_at: string;
};

type NoteRow = {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string;
  status: ResearchRunStatus;
  input_json: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export function listResearchConversations(): ResearchConversation[] {
  return sqlite
    .prepare('SELECT * FROM research_conversations ORDER BY updated_at DESC')
    .all()
    .map((row) => toConversation(row as ConversationRow));
}

export function createResearchConversation() {
  const now = new Date().toISOString();
  const conversation: ResearchConversation = {
    id: randomUUID(),
    title: '新研究',
    createdAt: now,
    updatedAt: now
  };

  sqlite
    .prepare('INSERT INTO research_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt);

  return conversation;
}

export function getResearchConversation(id: string): ResearchConversation | undefined {
  const row = sqlite.prepare('SELECT * FROM research_conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  return row ? toConversation(row) : undefined;
}

export function updateResearchConversation(id: string, changes: Pick<ResearchConversation, 'title' | 'topic' | 'summary'>) {
  const current = getResearchConversation(id);
  if (!current) return undefined;

  const next: ResearchConversation = {
    ...current,
    ...changes,
    updatedAt: new Date().toISOString()
  };
  sqlite
    .prepare('UPDATE research_conversations SET title = ?, topic = ?, summary = ?, updated_at = ? WHERE id = ?')
    .run(next.title, next.topic ?? null, next.summary ?? null, next.updatedAt, id);
  return next;
}

/** Saves only the current context work state; original messages and tool audit records stay append-only. */
export function updateResearchContextState(id: string, contextState: ContextState) {
  const current = getResearchConversation(id);
  if (!current) return undefined;
  const updatedAt = new Date().toISOString();
  sqlite
    .prepare('UPDATE research_conversations SET context_state_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(contextState), updatedAt, id);
  return getResearchConversation(id);
}

export function createResearchMessage(input: Omit<ResearchMessage, 'id' | 'createdAt'>) {
  const message: ResearchMessage = {
    id: randomUUID(),
    ...input,
    createdAt: new Date().toISOString()
  };
  sqlite
    .prepare('INSERT INTO research_messages (id, conversation_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(message.id, message.conversationId, message.role, message.content, message.status, message.createdAt);
  touchConversation(message.conversationId);
  return message;
}

export function updateResearchMessage(id: string, changes: Pick<ResearchMessage, 'content' | 'status'>) {
  sqlite.prepare('UPDATE research_messages SET content = ?, status = ? WHERE id = ?').run(changes.content, changes.status, id);
  const row = sqlite.prepare('SELECT * FROM research_messages WHERE id = ?').get(id) as MessageRow | undefined;
  if (!row) return undefined;
  touchConversation(row.conversation_id);
  return toMessage(row);
}

export function listResearchMessages(conversationId: string) {
  return sqlite
    .prepare('SELECT * FROM research_messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId)
    .map((row) => toMessage(row as MessageRow));
}

export function createResearchRun(input: {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  runInput: ResearchRunInput;
}) {
  const now = new Date().toISOString();
  const run: ResearchRun = {
    id: randomUUID(),
    conversationId: input.conversationId,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    status: 'queued',
    createdAt: now,
    updatedAt: now
  };
  sqlite.prepare(`INSERT INTO research_runs
    (id, conversation_id, user_message_id, assistant_message_id, status, input_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      run.id,
      run.conversationId,
      run.userMessageId,
      run.assistantMessageId,
      run.status,
      JSON.stringify(input.runInput),
      run.createdAt,
      run.updatedAt
    );
  return run;
}

export function getResearchRun(id: string): ResearchRun | undefined {
  const row = sqlite.prepare('SELECT * FROM research_runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

export function getResearchRunInput(id: string): ResearchRunInput | undefined {
  const row = sqlite.prepare('SELECT input_json FROM research_runs WHERE id = ?').get(id) as { input_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.input_json) as ResearchRunInput;
}

export function getActiveResearchRun(conversationId: string): ResearchRun | undefined {
  const row = sqlite.prepare(`SELECT * FROM research_runs
    WHERE conversation_id = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC LIMIT 1`).get(conversationId) as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

export function updateResearchRun(
  id: string,
  changes: { status: ResearchRunStatus; error?: string; startedAt?: string; completedAt?: string }
) {
  const current = sqlite.prepare('SELECT * FROM research_runs WHERE id = ?').get(id) as RunRow | undefined;
  if (!current) return undefined;
  const updatedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE research_runs
    SET status = ?, error = ?, started_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ?`)
    .run(
      changes.status,
      changes.error ?? null,
      changes.startedAt ?? current.started_at,
      changes.completedAt ?? current.completed_at,
      updatedAt,
      id
    );
  return getResearchRun(id);
}

export function listUnfinishedResearchRuns() {
  return sqlite.prepare(`SELECT * FROM research_runs WHERE status IN ('queued', 'running') ORDER BY created_at ASC`)
    .all()
    .map((row) => toRun(row as RunRow));
}

export function createResearchStep(input: Omit<ResearchStep, 'id' | 'startedAt' | 'completedAt'>) {
  const step: ResearchStep = {
    id: randomUUID(),
    ...input,
    startedAt: new Date().toISOString()
  };
  sqlite
    .prepare(`INSERT INTO research_steps
      (id, conversation_id, message_id, sequence, type, status, title, input_json, output_json, parent_step_id, tool_call_id, error, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      step.id,
      step.conversationId,
      step.messageId,
      step.sequence,
      step.type,
      step.status,
      step.title,
      serializeJson(step.input),
      serializeJson(step.output),
      step.parentStepId ?? null,
      step.toolCallId ?? null,
      step.error ?? null,
      step.startedAt,
      step.completedAt ?? null
    );
  return step;
}

export function updateResearchStep(id: string, changes: Pick<ResearchStep, 'status' | 'output' | 'error'>) {
  const completedAt = changes.status === 'running' ? null : new Date().toISOString();
  sqlite
    .prepare('UPDATE research_steps SET status = ?, output_json = ?, error = ?, completed_at = ? WHERE id = ?')
    .run(changes.status, serializeJson(changes.output), changes.error ?? null, completedAt, id);
  const row = sqlite.prepare('SELECT * FROM research_steps WHERE id = ?').get(id) as StepRow | undefined;
  return row ? toStep(row) : undefined;
}

export function listResearchSteps(conversationId: string) {
  return sqlite
    .prepare('SELECT * FROM research_steps WHERE conversation_id = ? ORDER BY sequence ASC')
    .all(conversationId)
    .map((row) => toStep(row as StepRow));
}

export function addResearchSource(messageId: string, source: RagSource, citationKey: string) {
  const existing = sqlite
    .prepare('SELECT * FROM research_sources WHERE message_id = ? AND source_id = ?')
    .get(messageId, source.id) as SourceRow | undefined;
  if (existing) return toSource(existing);

  const researchSource: ResearchSource = {
    ...source,
    id: randomUUID(),
    messageId,
    citationKey,
    createdAt: new Date().toISOString()
  };
  sqlite
    .prepare(`INSERT INTO research_sources
      (id, message_id, source_id, citation_key, file, title, heading, content, start_line, end_line, score, locator_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      researchSource.id,
      researchSource.messageId,
      source.id,
      researchSource.citationKey,
      researchSource.file,
      researchSource.title,
      researchSource.heading ?? null,
      researchSource.content,
      researchSource.startLine,
      researchSource.endLine,
      researchSource.score,
      source.locator ? JSON.stringify(source.locator) : null,
      researchSource.createdAt
    );
  return researchSource;
}

export function listResearchSources(conversationId: string) {
  return sqlite
    .prepare(`SELECT research_sources.* FROM research_sources
      JOIN research_messages ON research_messages.id = research_sources.message_id
      WHERE research_messages.conversation_id = ?
      ORDER BY research_sources.created_at ASC`)
    .all(conversationId)
    .map((row) => toSource(row as SourceRow));
}

export function listResearchNotes(conversationId: string) {
  return sqlite
    .prepare('SELECT * FROM research_notes WHERE conversation_id = ? ORDER BY updated_at DESC')
    .all(conversationId)
    .map((row) => toNote(row as NoteRow));
}

export function createResearchNote(conversationId: string, content: string) {
  const now = new Date().toISOString();
  const note: ResearchNote = { id: randomUUID(), conversationId, content, createdAt: now, updatedAt: now };
  sqlite
    .prepare('INSERT INTO research_notes (id, conversation_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(note.id, note.conversationId, note.content, note.createdAt, note.updatedAt);
  return note;
}

export function updateResearchNote(id: string, content: string) {
  const updatedAt = new Date().toISOString();
  sqlite.prepare('UPDATE research_notes SET content = ?, updated_at = ? WHERE id = ?').run(content, updatedAt, id);
  const row = sqlite.prepare('SELECT * FROM research_notes WHERE id = ?').get(id) as NoteRow | undefined;
  return row ? toNote(row) : undefined;
}

export function deleteResearchNote(id: string) {
  return sqlite.prepare('DELETE FROM research_notes WHERE id = ?').run(id).changes > 0;
}

export function deleteResearchConversation(id: string) {
  return sqlite.prepare('DELETE FROM research_conversations WHERE id = ?').run(id).changes > 0;
}

export function getResearchConversationDetail(
  conversationId: string,
  promptPreview: ResearchPromptPreview
): ResearchConversationDetail | undefined {
  const conversation = getResearchConversation(conversationId);
  if (!conversation) return undefined;
  const activeRun = getActiveResearchRun(conversationId);

  return {
    conversation,
    messages: listResearchMessages(conversationId),
    steps: listResearchSteps(conversationId),
    sources: listResearchSources(conversationId),
    notes: listResearchNotes(conversationId),
    promptPreview,
    ...(activeRun ? { activeRun } : {})
  };
}

function touchConversation(id: string) {
  sqlite.prepare('UPDATE research_conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

function serializeJson(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: string | null) {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function toConversation(row: ConversationRow): ResearchConversation {
  return {
    id: row.id,
    title: row.title,
    ...(row.topic ? { topic: row.topic } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(parseContextState(row.context_state_json) ? { contextState: parseContextState(row.context_state_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMessage(row: MessageRow): ResearchMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.created_at
  };
}

function toStep(row: StepRow): ResearchStep {
  const parsedInput = parseJson(row.input_json);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    sequence: row.sequence,
    type: row.type,
    status: row.status,
    title: row.title,
    ...(parsedInput === undefined ? {} : {
      input: row.type === 'tool' ? redactToolArguments(parsedInput) : parsedInput
    }),
    ...(parseJson(row.output_json) === undefined ? {} : { output: parseJson(row.output_json) }),
    ...(row.parent_step_id ? { parentStepId: row.parent_step_id } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  };
}

function parseContextState(value: string | null): ContextState | undefined {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' ? parsed as ContextState : undefined;
}

function toSource(row: SourceRow): ResearchSource {
  return {
    id: row.id,
    messageId: row.message_id,
    citationKey: row.citation_key,
    file: row.file,
    title: row.title,
    ...(row.heading ? { heading: row.heading } : {}),
    content: row.content,
    startLine: row.start_line,
    endLine: row.end_line,
    score: row.score,
    createdAt: row.created_at,
    ...(formatFromFile(row.file) ? { format: formatFromFile(row.file) } : {}),
    ...(parseLocator(parseJson(row.locator_json))
      ? { locator: parseLocator(parseJson(row.locator_json)) }
      : {})
  };
}

function formatFromFile(file: string): KnowledgeFormat | undefined {
  const extension = file.split('.').pop()?.toLowerCase();
  if (extension === 'md' || extension === 'txt' || extension === 'docx' || extension === 'pdf') return extension;
  return undefined;
}

function toNote(row: NoteRow): ResearchNote {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toRun(row: RunRow): ResearchRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    updatedAt: row.updated_at
  };
}

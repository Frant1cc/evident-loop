import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateKnowledgeSchema } from './knowledge/migrate.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const evidentLoopDbPath = resolve(currentDir, '../data/evident-loop.sqlite');
const legacyDbPath = resolve(currentDir, '../data/agent-demo.sqlite');
const defaultDbPath =
  existsSync(evidentLoopDbPath) || !existsSync(legacyDbPath)
    ? evidentLoopDbPath
    : legacyDbPath;

export const dbPath = process.env.SQLITE_DB_PATH
  ?? (process.env.NODE_TEST_CONTEXT ? ':memory:' : defaultDbPath);

if (dbPath !== ':memory:') {
  mkdirSync(dirname(dbPath), { recursive: true });
}

export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('foreign_keys = ON');
export const db = drizzle({ client: sqlite });

export const initDb = () => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS test_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      path TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'manual',
      format TEXT NOT NULL DEFAULT 'md',
      mime_type TEXT,
      original_name TEXT,
      original_size INTEGER,
      storage_key TEXT,
      parser_name TEXT NOT NULL DEFAULT 'markdown',
      parser_version TEXT NOT NULL DEFAULT '1',
      parse_warnings_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT,
      original_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS knowledge_documents_updated_at_idx
    ON knowledge_documents(updated_at);

    CREATE TABLE IF NOT EXISTS rag_evaluations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      completed_cases INTEGER NOT NULL DEFAULT 0,
      total_cases INTEGER NOT NULL,
      current_case_id TEXT,
      config_json TEXT NOT NULL,
      report_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS rag_evaluations_created_at_idx
    ON rag_evaluations(created_at DESC);

    CREATE TABLE IF NOT EXISTS web_evaluations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      completed_cases INTEGER NOT NULL DEFAULT 0,
      total_cases INTEGER NOT NULL,
      current_case_id TEXT,
      config_json TEXT NOT NULL,
      report_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS web_evaluations_created_at_idx
    ON web_evaluations(created_at DESC);

    CREATE TABLE IF NOT EXISTS web_evaluation_cases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      category TEXT NOT NULL,
      answerable INTEGER NOT NULL,
      include_domains_json TEXT,
      expected_domains_json TEXT NOT NULL,
      expected_evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS web_evaluation_cases_created_at_idx
    ON web_evaluation_cases(created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'error')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS chat_conversations_updated_at_idx
    ON chat_conversations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS chat_messages_conversation_created_at_idx
    ON chat_messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS research_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      topic TEXT,
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS research_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'error')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      input_json TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_message_id) REFERENCES research_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (assistant_message_id) REFERENCES research_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stream_events (
      stream_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (stream_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS stream_events_occurred_at_idx
      ON stream_events (occurred_at);


    CREATE TABLE IF NOT EXISTS research_steps (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('llm', 'tool')),
      status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'error')),
      title TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES research_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS research_sources (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      citation_key TEXT NOT NULL,
      file TEXT NOT NULL,
      title TEXT NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      score REAL NOT NULL,
      locator_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES research_messages(id) ON DELETE CASCADE,
      UNIQUE (message_id, source_id),
      UNIQUE (message_id, citation_key)
    );

    CREATE TABLE IF NOT EXISTS research_notes (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS research_conversations_updated_at_idx
    ON research_conversations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS research_messages_conversation_created_at_idx
    ON research_messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS research_runs_conversation_status_idx
    ON research_runs(conversation_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS research_steps_conversation_sequence_idx
    ON research_steps(conversation_id, sequence);
    CREATE INDEX IF NOT EXISTS research_sources_message_id_idx
    ON research_sources(message_id);
    CREATE INDEX IF NOT EXISTS research_notes_conversation_updated_at_idx
    ON research_notes(conversation_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('created', 'planning', 'awaiting_approval', 'running', 'paused', 'completed', 'failed', 'cancelled')),
      current_step_id TEXT,
      max_steps INTEGER NOT NULL CHECK (max_steps > 0),
      max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
      allowed_tools_json TEXT NOT NULL,
      checkpoint_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_plan_steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      objective TEXT NOT NULL,
      expected_evidence_json TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'blocked', 'skipped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      UNIQUE (task_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS agent_reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL UNIQUE,
      verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'needs_more_evidence')),
      summary TEXT NOT NULL,
      supported_claims_json TEXT NOT NULL,
      unsupported_claims_json TEXT NOT NULL,
      limitations_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES agent_plan_steps(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_evidence_gaps (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      description TEXT NOT NULL,
      required_evidence TEXT NOT NULL,
      suggested_query TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'scheduled', 'resolved', 'unresolved')),
      supplemental_step_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (review_id) REFERENCES agent_reviews(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES agent_plan_steps(id) ON DELETE CASCADE,
      FOREIGN KEY (supplemental_step_id) REFERENCES agent_plan_steps(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sources (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT,
      tool_execution_id TEXT,
      source_key TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('knowledge_document', 'document', 'web', 'tool_result', 'other')),
      title TEXT NOT NULL,
      uri TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES agent_plan_steps(id) ON DELETE SET NULL,
      FOREIGN KEY (tool_execution_id) REFERENCES tool_executions(id) ON DELETE SET NULL,
      UNIQUE (task_id, source_key)
    );

    CREATE TABLE IF NOT EXISTS agent_evidence (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT,
      source_id TEXT NOT NULL,
      evidence_key TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      locator_json TEXT,
      relevance_score REAL CHECK (relevance_score IS NULL OR (relevance_score >= 0 AND relevance_score <= 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES agent_plan_steps(id) ON DELETE SET NULL,
      FOREIGN KEY (source_id) REFERENCES agent_sources(id) ON DELETE CASCADE,
      UNIQUE (task_id, evidence_key)
    );

    CREATE TABLE IF NOT EXISTS agent_claims (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT,
      claim_key TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposed', 'supported', 'unsupported', 'conflicted')),
      confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES agent_plan_steps(id) ON DELETE SET NULL,
      UNIQUE (task_id, claim_key)
    );

    CREATE TABLE IF NOT EXISTS agent_claim_evidence (
      task_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'context')),
      rationale TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (claim_id, evidence_id),
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (claim_id) REFERENCES agent_claims(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES agent_evidence(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      UNIQUE (task_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS agent_checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      UNIQUE (task_id, version)
    );

    CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT,
      execution_key TEXT NOT NULL UNIQUE,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      arguments_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (step_id) REFERENCES agent_plan_steps(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('report')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS agent_tasks_updated_at_idx
    ON agent_tasks(updated_at DESC);
    CREATE INDEX IF NOT EXISTS agent_plan_steps_task_sequence_idx
    ON agent_plan_steps(task_id, sequence);
    CREATE INDEX IF NOT EXISTS agent_reviews_task_created_at_idx
    ON agent_reviews(task_id, created_at);
    CREATE INDEX IF NOT EXISTS agent_evidence_gaps_task_status_idx
    ON agent_evidence_gaps(task_id, status);
    CREATE INDEX IF NOT EXISTS agent_sources_task_step_idx
    ON agent_sources(task_id, step_id);
    CREATE INDEX IF NOT EXISTS agent_evidence_task_source_idx
    ON agent_evidence(task_id, source_id);
    CREATE INDEX IF NOT EXISTS agent_claims_task_step_idx
    ON agent_claims(task_id, step_id);
    CREATE INDEX IF NOT EXISTS agent_claim_evidence_task_claim_idx
    ON agent_claim_evidence(task_id, claim_id);
    CREATE INDEX IF NOT EXISTS agent_events_task_sequence_idx
    ON agent_events(task_id, sequence);
    CREATE INDEX IF NOT EXISTS agent_checkpoints_task_version_idx
    ON agent_checkpoints(task_id, version DESC);
    CREATE INDEX IF NOT EXISTS tool_executions_task_id_idx
    ON tool_executions(task_id);
    CREATE INDEX IF NOT EXISTS agent_artifacts_task_updated_at_idx
    ON agent_artifacts(task_id, updated_at DESC);
  `);

  // Existing installations created before the local-library metadata field.
  const columns = sqlite.prepare('PRAGMA table_info(web_evaluation_cases)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'metadata_json')) {
    sqlite.exec('ALTER TABLE web_evaluation_cases ADD COLUMN metadata_json TEXT');
  }

  migrateKnowledgeSchema(sqlite);
};

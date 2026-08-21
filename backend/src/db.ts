import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateKnowledgeSchema } from './knowledge/migrate.js';
import { migrateChatConversationsToResearch } from './research/migrateChat.js';

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

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'disabled',
      last_error TEXT,
      last_refreshed_at TEXT,
      authorization_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_tools (
      server_id TEXT NOT NULL,
      remote_name TEXT NOT NULL,
      model_name TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      input_schema_json TEXT NOT NULL,
      definition_hash TEXT NOT NULL DEFAULT '',
      annotations_json TEXT,
      tombstone INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      PRIMARY KEY (server_id, remote_name),
      FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS mcp_tools_server_ordinal_idx ON mcp_tools(server_id, ordinal);

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
      context_state_json TEXT,
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
      parent_step_id TEXT,
      tool_call_id TEXT,
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

    CREATE TABLE IF NOT EXISTS research_artifacts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      snapshot_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('planning', 'awaiting_confirmation', 'rendering', 'validating', 'repairing', 'completed', 'partial', 'failed', 'cancelled', 'superseded')),
      stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
      spec_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE,
      UNIQUE (conversation_id, version)
    );

    CREATE TABLE IF NOT EXISTS research_artifact_outputs (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      format TEXT NOT NULL CHECK (format IN ('pptx', 'pdf')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'rendering', 'validating', 'completed', 'failed', 'cancelled')),
      file_name TEXT,
      content_type TEXT,
      size INTEGER CHECK (size IS NULL OR size >= 0),
      storage_key TEXT,
      preview_key TEXT,
      provenance_json TEXT,
      rendered_spec_json TEXT,
      rendered_spec_digest TEXT,
      error TEXT,
      diagnostics_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (generation_id) REFERENCES research_artifacts(id) ON DELETE CASCADE,
      UNIQUE (generation_id, format)
    );

    CREATE INDEX IF NOT EXISTS research_artifacts_conversation_version_idx
    ON research_artifacts(conversation_id, version DESC);
    CREATE INDEX IF NOT EXISTS research_artifact_outputs_generation_status_idx
    ON research_artifact_outputs(generation_id, status);

    CREATE TABLE IF NOT EXISTS research_artifact_assets (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      source_id TEXT,
      original_page_url TEXT,
      image_url TEXT NOT NULL,
      license_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (license_confirmed IN (0, 1)),
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size > 0),
      pixel_width INTEGER,
      pixel_height INTEGER,
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (generation_id) REFERENCES research_artifacts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS research_artifact_assets_generation_idx
    ON research_artifact_assets(generation_id, created_at);

    CREATE TABLE IF NOT EXISTS research_artifact_image_consents (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      image_url TEXT NOT NULL,
      source_id TEXT,
      confirmed_at TEXT NOT NULL,
      FOREIGN KEY (generation_id) REFERENCES research_artifacts(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS research_artifact_image_consents_unique_idx
    ON research_artifact_image_consents(generation_id, image_url);

    CREATE TABLE IF NOT EXISTS artifact_image_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      encrypted_api_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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
    CREATE TABLE IF NOT EXISTS tool_approvals (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('research_run', 'agent_task')),
      scope_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      model_name TEXT NOT NULL,
      label TEXT NOT NULL,
      source TEXT NOT NULL,
      server_id TEXT,
      server_name TEXT,
      remote_name TEXT,
      read_only INTEGER NOT NULL DEFAULT 0,
      arguments_json TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled', 'invalidated')),
      requested_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS tool_approvals_scope_idx
      ON tool_approvals(scope_type, scope_id, requested_at);
    CREATE INDEX IF NOT EXISTS tool_approvals_pending_idx
      ON tool_approvals(status, scope_type, scope_id);
    CREATE INDEX IF NOT EXISTS agent_artifacts_task_updated_at_idx
    ON agent_artifacts(task_id, updated_at DESC);
  `);

  // Existing artifact output tables predate durable image provenance.
  ensureColumn('research_artifact_outputs', 'provenance_json', 'TEXT');
  ensureColumn('research_artifact_outputs', 'rendered_spec_json', 'TEXT');
  ensureColumn('research_artifact_outputs', 'rendered_spec_digest', 'TEXT');
  migrateArtifactStatusConstraint();
  ensureArtifactDraftRequestSchema();

// Existing local databases predate durable context state and native tool-call replay.
  // SQLite has no ADD COLUMN IF NOT EXISTS, so keep this tiny, idempotent migration here.
  ensureColumn('research_conversations', 'context_state_json', 'TEXT');
  ensureColumn('research_steps', 'parent_step_id', 'TEXT');
  ensureColumn('research_steps', 'tool_call_id', 'TEXT');
  ensureColumn('tool_approvals', 'remote_name', 'TEXT');
  ensureColumn('mcp_tools', 'definition_hash', "TEXT NOT NULL DEFAULT ''");
  // Existing installations created before the local-library metadata field.
  ensureColumn('web_evaluation_cases', 'metadata_json', 'TEXT');

  migrateKnowledgeSchema(sqlite);
  migrateChatConversationsToResearch(sqlite);
  // A pending approval represents an in-process waiter and cannot safely
  // survive a process restart. Expire every old waiter atomically at startup.
  sqlite.prepare("UPDATE tool_approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'")
    .run(new Date().toISOString());
};

function ensureColumn(table: string, column: string, definition: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * The artifact status CHECK was introduced before the immutable-version
 * `superseded` state. SQLite cannot alter a CHECK constraint in place, so
 * rebuild the small artifact family when an existing local database still has
 * the old constraint. Foreign keys stay enabled; dependent tables are copied
 * with references to the new parent before the legacy tables are dropped.
 */
function migrateArtifactStatusConstraint() {
  const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'research_artifacts'").get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'superseded'")) return;

  const rebuild = sqlite.transaction(() => {
    sqlite.exec(`
      DROP INDEX IF EXISTS research_artifacts_conversation_version_idx;
      ALTER TABLE research_artifacts RENAME TO research_artifacts_legacy;
      CREATE TABLE research_artifacts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        snapshot_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planning', 'awaiting_confirmation', 'rendering', 'validating', 'repairing', 'completed', 'partial', 'failed', 'cancelled', 'superseded')),
        stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
        spec_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE,
        UNIQUE (conversation_id, version)
      );
      INSERT INTO research_artifacts
        (id, conversation_id, version, snapshot_digest, status, stale, spec_json, snapshot_json, created_at, updated_at)
        SELECT id, conversation_id, version, snapshot_digest, status, stale, spec_json, snapshot_json, created_at, updated_at
        FROM research_artifacts_legacy;

      DROP INDEX IF EXISTS research_artifact_outputs_generation_status_idx;
      ALTER TABLE research_artifact_outputs RENAME TO research_artifact_outputs_legacy;
      CREATE TABLE research_artifact_outputs (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        format TEXT NOT NULL CHECK (format IN ('pptx', 'pdf')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'rendering', 'validating', 'completed', 'failed', 'cancelled')),
        file_name TEXT,
        content_type TEXT,
        size INTEGER CHECK (size IS NULL OR size >= 0),
        storage_key TEXT,
        preview_key TEXT,
        provenance_json TEXT,
        rendered_spec_json TEXT,
        rendered_spec_digest TEXT,
        error TEXT,
        diagnostics_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (generation_id) REFERENCES research_artifacts(id) ON DELETE CASCADE,
        UNIQUE (generation_id, format)
      );
      INSERT INTO research_artifact_outputs
        (id, generation_id, version, format, status, file_name, content_type, size, storage_key, preview_key, provenance_json, rendered_spec_json, rendered_spec_digest, error, diagnostics_json, attempts, created_at, updated_at)
        SELECT id, generation_id, version, format, status, file_name, content_type, size, storage_key, preview_key, provenance_json, rendered_spec_json, rendered_spec_digest, error, diagnostics_json, attempts, created_at, updated_at
        FROM research_artifact_outputs_legacy;

      DROP INDEX IF EXISTS research_artifact_assets_generation_idx;
      ALTER TABLE research_artifact_assets RENAME TO research_artifact_assets_legacy;
      CREATE TABLE research_artifact_assets (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        source_id TEXT,
        original_page_url TEXT,
        image_url TEXT NOT NULL,
        license_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (license_confirmed IN (0, 1)),
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size > 0),
        pixel_width INTEGER,
        pixel_height INTEGER,
        storage_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (generation_id) REFERENCES research_artifacts(id) ON DELETE CASCADE
      );
      INSERT INTO research_artifact_assets
        (id, generation_id, source_id, original_page_url, image_url, license_confirmed, mime_type, byte_size, pixel_width, pixel_height, storage_key, created_at)
        SELECT id, generation_id, source_id, original_page_url, image_url, license_confirmed, mime_type, byte_size, pixel_width, pixel_height, storage_key, created_at
        FROM research_artifact_assets_legacy;

      DROP INDEX IF EXISTS research_artifact_image_consents_unique_idx;
      ALTER TABLE research_artifact_image_consents RENAME TO research_artifact_image_consents_legacy;
      CREATE TABLE research_artifact_image_consents (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        image_url TEXT NOT NULL,
        source_id TEXT,
        confirmed_at TEXT NOT NULL,
        FOREIGN KEY (generation_id) REFERENCES research_artifacts(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE
      );
      INSERT INTO research_artifact_image_consents
        (id, generation_id, conversation_id, image_url, source_id, confirmed_at)
        SELECT id, generation_id, conversation_id, image_url, source_id, confirmed_at
        FROM research_artifact_image_consents_legacy;

      DROP TABLE research_artifact_outputs_legacy;
      DROP TABLE research_artifact_assets_legacy;
      DROP TABLE research_artifact_image_consents_legacy;
      DROP TABLE research_artifacts_legacy;
      CREATE INDEX research_artifacts_conversation_version_idx
        ON research_artifacts(conversation_id, version DESC);
      CREATE INDEX research_artifact_outputs_generation_status_idx
        ON research_artifact_outputs(generation_id, status);
      CREATE INDEX research_artifact_assets_generation_idx
        ON research_artifact_assets(generation_id, created_at);
      CREATE UNIQUE INDEX research_artifact_image_consents_unique_idx
        ON research_artifact_image_consents(generation_id, image_url);
    `);
  });
  rebuild();
}

function ensureArtifactDraftRequestSchema() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS research_artifact_draft_requests (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      research_run_id TEXT,
      preferences_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      generation_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES research_conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (generation_id) REFERENCES research_artifacts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS research_artifact_draft_requests_run_status_idx
    ON research_artifact_draft_requests(conversation_id, research_run_id, status, created_at);
  `);
}

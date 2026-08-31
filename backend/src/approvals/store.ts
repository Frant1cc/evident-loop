import { randomUUID } from 'node:crypto';

import { sqlite } from '../db.js';
import type {
  ApprovalScopeType,
  ApprovalStore,
  ToolApprovalRecord,
  ToolApprovalScope,
  ToolApprovalStatus
} from './contracts.js';

type ApprovalRow = {
  id: string;
  scope_type: ApprovalScopeType;
  scope_id: string;
  tool_call_id: string;
  tool_name: string;
  model_name: string;
  label: string;
  source: string;
  server_id: string | null;
  server_name: string | null;
  remote_name: string | null;
  read_only: number;
  arguments_json: string;
  definition_hash: string;
  status: ToolApprovalStatus;
  requested_at: string;
  decided_at: string | null;
};

export function createApprovalStore(): ApprovalStore {
  const ensureSchema = () => {
    sqlite.exec(`
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
      CREATE INDEX IF NOT EXISTS tool_approvals_scope_idx ON tool_approvals(scope_type, scope_id, requested_at);
      CREATE INDEX IF NOT EXISTS tool_approvals_pending_idx ON tool_approvals(status, scope_type, scope_id);
    `);
    const columns = sqlite.prepare('PRAGMA table_info(tool_approvals)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'remote_name')) {
      sqlite.exec('ALTER TABLE tool_approvals ADD COLUMN remote_name TEXT');
    }
  };

  const store: ApprovalStore = {
    ensureSchema,
    expirePending: (now) => {
      ensureSchema();
      return sqlite.prepare("UPDATE tool_approvals SET status = 'expired', decided_at = ? WHERE status = 'pending'")
        .run(now).changes;
    },
    create: (input) => {
      ensureSchema();
      const record: ToolApprovalRecord = {
        ...input,
        id: randomUUID(),
        status: 'pending'
      };
      sqlite.prepare(`INSERT INTO tool_approvals
        (id, scope_type, scope_id, tool_call_id, tool_name, model_name, label, source, server_id, server_name, remote_name, read_only, arguments_json, definition_hash, status, requested_at, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.id,
          record.scope.type,
          record.scope.id,
          record.toolCallId,
          record.toolName,
          record.modelName,
          record.label,
          record.source,
          record.serverId ?? null,
          record.serverName ?? null,
          record.remoteName ?? null,
          record.readOnly ? 1 : 0,
          JSON.stringify(record.arguments) ?? 'null',
          record.definitionHash,
          record.status,
          record.requestedAt,
          null
        );
      return record;
    },
    get: (id) => {
      ensureSchema();
      const row = sqlite.prepare('SELECT * FROM tool_approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
      return row ? toRecord(row) : undefined;
    },
    list: (scope) => {
      ensureSchema();
      const rows = scope
        ? sqlite.prepare('SELECT * FROM tool_approvals WHERE scope_type = ? AND scope_id = ? ORDER BY requested_at ASC')
          .all(scope.type, scope.id)
        : sqlite.prepare('SELECT * FROM tool_approvals ORDER BY requested_at DESC').all();
      return rows.map((row) => toRecord(row as ApprovalRow));
    },
    findPending: (scope, toolCallId) => {
      ensureSchema();
      const row = sqlite.prepare(`SELECT * FROM tool_approvals
        WHERE scope_type = ? AND scope_id = ? AND tool_call_id = ? AND status = 'pending'
        ORDER BY requested_at DESC LIMIT 1`).get(scope.type, scope.id, toolCallId) as ApprovalRow | undefined;
      return row ? toRecord(row) : undefined;
    },
    decide: (id, status, decidedAt) => {
      ensureSchema();
      const changed = sqlite.prepare(`UPDATE tool_approvals SET status = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'`).run(status, decidedAt, id).changes;
      return changed === 1 ? store.get(id) : undefined;
    },
    transition: (id, from, to, decidedAt) => {
      ensureSchema();
      const changed = sqlite.prepare('UPDATE tool_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = ?')
        .run(to, decidedAt, id, from).changes;
      return changed === 1 ? store.get(id) : undefined;
    }
  };

  ensureSchema();
  return store;
}

function toRecord(row: ApprovalRow): ToolApprovalRecord {
  let args: unknown = undefined;
  try {
    args = JSON.parse(row.arguments_json) as unknown;
  } catch {
    args = { raw: '[invalid persisted JSON]' };
  }
  return {
    id: row.id,
    scope: { type: row.scope_type, id: row.scope_id },
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    modelName: row.model_name,
    label: row.label,
    source: row.source,
    ...(row.server_id ? { serverId: row.server_id } : {}),
    ...(row.server_name ? { serverName: row.server_name } : {}),
    ...(row.remote_name ? { remoteName: row.remote_name } : {}),
    readOnly: Boolean(row.read_only),
    arguments: args,
    definitionHash: row.definition_hash,
    status: row.status,
    requestedAt: row.requested_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {})
  };
}

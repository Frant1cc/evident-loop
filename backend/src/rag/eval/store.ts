import { sqlite } from '../../db.js';
import type { RagEvalReport, RagEvalThresholds } from './run.js';

export type RagEvaluationStatus = 'queued' | 'running' | 'completed' | 'failed';

export type RagEvaluationConfig = {
  k: number;
  thresholds: RagEvalThresholds;
  collection: string;
  embeddingModel: string;
  /** 检索策略（schemaVersion 2 起记录），保证每次运行可复现 */
  retrieval?: 'dense' | 'hybrid';
  /** P3 查询改写是否启用（schemaVersion 4 起记录） */
  queryRewrite?: boolean;
  caseCount: number;
};

export type RagEvaluationRecord = {
  id: string;
  name: string;
  status: RagEvaluationStatus;
  completedCases: number;
  totalCases: number;
  currentCaseId?: string;
  config: RagEvaluationConfig;
  report?: RagEvalReport;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

type EvaluationRow = {
  id: string;
  name: string;
  status: RagEvaluationStatus;
  completed_cases: number;
  total_cases: number;
  current_case_id: string | null;
  config_json: string;
  report_json: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

export function createEvaluationRecord(record: RagEvaluationRecord) {
  sqlite.prepare(`
    INSERT INTO rag_evaluations (
      id, name, status, completed_cases, total_cases, current_case_id, config_json,
      report_json, error, created_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.name,
    record.status,
    record.completedCases,
    record.totalCases,
    record.currentCaseId ?? null,
    JSON.stringify(record.config),
    record.report ? JSON.stringify(record.report) : null,
    record.error ?? null,
    record.createdAt,
    record.startedAt ?? null,
    record.completedAt ?? null,
    record.updatedAt
  );
  return record;
}

export function listEvaluationRecords(limit = 50): RagEvaluationRecord[] {
  const rows = sqlite.prepare(`
    SELECT * FROM rag_evaluations ORDER BY created_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(limit, 100))) as EvaluationRow[];
  return rows.map(toRecord);
}

export function getEvaluationRecord(id: string): RagEvaluationRecord | undefined {
  const row = sqlite.prepare('SELECT * FROM rag_evaluations WHERE id = ?').get(id) as EvaluationRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function updateEvaluationRecord(
  id: string,
  patch: Partial<Pick<RagEvaluationRecord,
    'status' | 'completedCases' | 'currentCaseId' | 'report' | 'error' | 'startedAt' | 'completedAt'>>
) {
  const current = getEvaluationRecord(id);
  if (!current) return undefined;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  sqlite.prepare(`
    UPDATE rag_evaluations SET
      status = ?, completed_cases = ?, current_case_id = ?, report_json = ?, error = ?,
      started_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.status,
    next.completedCases,
    next.currentCaseId ?? null,
    next.report ? JSON.stringify(next.report) : null,
    next.error ?? null,
    next.startedAt ?? null,
    next.completedAt ?? null,
    next.updatedAt,
    id
  );
  return next;
}

export function deleteEvaluationRecord(id: string) {
  return sqlite.prepare('DELETE FROM rag_evaluations WHERE id = ?').run(id).changes > 0;
}

function toRecord(row: EvaluationRow): RagEvaluationRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    completedCases: row.completed_cases,
    totalCases: row.total_cases,
    currentCaseId: row.current_case_id ?? undefined,
    config: JSON.parse(row.config_json) as RagEvaluationConfig,
    report: row.report_json ? JSON.parse(row.report_json) as RagEvalReport : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at
  };
}

import { sqlite } from '../../db.js';
import type { WebEvalReport } from './run.js';

export type WebEvaluationStatus = 'queued' | 'running' | 'completed' | 'failed';
export type WebEvaluationConfig = { caseIds: string[]; suiteVersion: number; k: number };
export type WebEvaluationRecord = {
  id: string;
  name: string;
  status: WebEvaluationStatus;
  completedCases: number;
  totalCases: number;
  currentCaseId?: string;
  config: WebEvaluationConfig;
  report?: WebEvalReport;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

type Row = {
  id: string; name: string; status: WebEvaluationStatus; completed_cases: number; total_cases: number;
  current_case_id: string | null; config_json: string; report_json: string | null; error: string | null;
  created_at: string; started_at: string | null; completed_at: string | null; updated_at: string;
};

export function createWebEvaluationRecord(record: WebEvaluationRecord) {
  sqlite.prepare(`INSERT INTO web_evaluations (
    id, name, status, completed_cases, total_cases, current_case_id, config_json,
    report_json, error, created_at, started_at, completed_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id, record.name, record.status, record.completedCases, record.totalCases, record.currentCaseId ?? null,
    JSON.stringify(record.config), record.report ? JSON.stringify(record.report) : null, record.error ?? null,
    record.createdAt, record.startedAt ?? null, record.completedAt ?? null, record.updatedAt
  );
  return record;
}

export function listWebEvaluationRecords(limit = 50): WebEvaluationRecord[] {
  return (sqlite.prepare('SELECT * FROM web_evaluations ORDER BY created_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(limit, 100))) as Row[]).map(toRecord);
}

export function getWebEvaluationRecord(id: string) {
  const row = sqlite.prepare('SELECT * FROM web_evaluations WHERE id = ?').get(id) as Row | undefined;
  return row ? toRecord(row) : undefined;
}

export function updateWebEvaluationRecord(id: string, patch: Partial<Pick<WebEvaluationRecord,
  'status' | 'completedCases' | 'currentCaseId' | 'report' | 'error' | 'startedAt' | 'completedAt'>>) {
  const current = getWebEvaluationRecord(id);
  if (!current) return undefined;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  sqlite.prepare(`UPDATE web_evaluations SET status = ?, completed_cases = ?, current_case_id = ?,
    report_json = ?, error = ?, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`).run(
    next.status, next.completedCases, next.currentCaseId ?? null, next.report ? JSON.stringify(next.report) : null,
    next.error ?? null, next.startedAt ?? null, next.completedAt ?? null, next.updatedAt, id
  );
  return next;
}

export function deleteWebEvaluationRecord(id: string) {
  return sqlite.prepare('DELETE FROM web_evaluations WHERE id = ?').run(id).changes > 0;
}

function toRecord(row: Row): WebEvaluationRecord {
  return {
    id: row.id, name: row.name, status: row.status, completedCases: row.completed_cases, totalCases: row.total_cases,
    currentCaseId: row.current_case_id ?? undefined, config: JSON.parse(row.config_json) as WebEvaluationConfig,
    report: row.report_json ? JSON.parse(row.report_json) as WebEvalReport : undefined, error: row.error ?? undefined,
    createdAt: row.created_at, startedAt: row.started_at ?? undefined, completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at
  };
}

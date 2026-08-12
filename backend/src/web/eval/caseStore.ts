import { randomUUID } from 'node:crypto';

import { sqlite } from '../../db.js';
import type { WebEvalCase, WebEvalCategory, WebEvalEvidenceNeed } from './fixtures.js';

type CustomCase = WebEvalCase & { createdAt: string; updatedAt: string };
type Row = {
  id: string; title: string; question: string; category: WebEvalCategory; answerable: number;
  include_domains_json: string | null; expected_domains_json: string; expected_evidence_json: string;
  created_at: string; updated_at: string;
};

export function listCustomWebEvalCases(): CustomCase[] {
  return (sqlite.prepare('SELECT * FROM web_evaluation_cases ORDER BY created_at DESC').all() as Row[]).map(toCase);
}

export function createCustomWebEvalCase(input: unknown): CustomCase {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const title = text(value.title, 80);
  const question = text(value.question, 1_000);
  if (!title || !question) throw new Error('题目名称和问题内容不能为空');
  const answerable = value.answerable !== false;
  const includeDomains = domains(value.includeDomains);
  const expectedDomains = domains(value.expectedDomains ?? value.includeDomains);
  const evidenceLabels = arrayOfText(value.evidenceNeeds, 12, 120);
  if (answerable && !expectedDomains.length) throw new Error('可回答题请至少填写一个预期官方域名');
  if (answerable && !evidenceLabels.length) throw new Error('可回答题请至少填写一个要验证的证据点');
  const now = new Date().toISOString();
  const result: CustomCase = {
    id: `custom-${randomUUID()}`, title, question,
    category: answerable ? (evidenceLabels.length > 1 ? 'multi_claim' : 'official_api') : 'unanswerable',
    answerable, includeDomains: includeDomains.length ? includeDomains : undefined,
    expectedDomains,
    expectedEvidence: evidenceLabels.map((label, index) => ({ id: `need-${index + 1}`, label, groups: label.split(/[，,;；]/).map((item) => [item.trim()]).filter((item) => item[0]) })),
    createdAt: now, updatedAt: now
  };
  sqlite.prepare(`INSERT INTO web_evaluation_cases (
    id, title, question, category, answerable, include_domains_json, expected_domains_json, expected_evidence_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(result.id, result.title, result.question, result.category, Number(result.answerable),
      result.includeDomains ? JSON.stringify(result.includeDomains) : null, JSON.stringify(result.expectedDomains),
      JSON.stringify(result.expectedEvidence), now, now);
  return result;
}

export function deleteCustomWebEvalCase(id: string) {
  return sqlite.prepare('DELETE FROM web_evaluation_cases WHERE id = ?').run(id).changes > 0;
}

function toCase(row: Row): CustomCase {
  return {
    id: row.id, title: row.title, question: row.question, category: row.category, answerable: Boolean(row.answerable),
    includeDomains: row.include_domains_json ? JSON.parse(row.include_domains_json) as string[] : undefined,
    expectedDomains: JSON.parse(row.expected_domains_json) as string[],
    expectedEvidence: JSON.parse(row.expected_evidence_json) as WebEvalEvidenceNeed[],
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function text(value: unknown, max: number) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function arrayOfText(value: unknown, maxItems: number, maxLength: number) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems) : [];
}
function domains(value: unknown) {
  const raw = typeof value === 'string' ? value.split(/[，,;；\s]+/) : value;
  return arrayOfText(raw, 20, 253).map((item) => item.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean);
}

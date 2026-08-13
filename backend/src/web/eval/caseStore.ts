import { randomUUID } from 'node:crypto';

import { sqlite } from '../../db.js';
import type { WebEvalCase, WebEvalCategory, WebEvalDifficulty, WebEvalEvidenceNeed } from './fixtures.js';

export type CustomCase = WebEvalCase & { createdAt: string; updatedAt: string };
export type WebEvalLibraryExport = {
  schemaVersion: 1;
  exportedAt: string;
  benchmark: { version: number; caseCount: number };
  localCases: CustomCase[];
};

type Row = {
  id: string; title: string; question: string; category: WebEvalCategory; answerable: number;
  include_domains_json: string | null; expected_domains_json: string; expected_evidence_json: string;
  metadata_json: string | null; created_at: string; updated_at: string;
};

export function listCustomWebEvalCases(): CustomCase[] {
  return (sqlite.prepare('SELECT * FROM web_evaluation_cases ORDER BY created_at DESC').all() as Row[]).map(toCase);
}

export function createCustomWebEvalCase(input: unknown): CustomCase {
  const value = record(input);
  const result = buildCase(value);
  save(result);
  return result;
}

export function exportCustomWebEvalCases(version: number, caseCount: number): WebEvalLibraryExport {
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), benchmark: { version, caseCount }, localCases: listCustomWebEvalCases() };
}

export function importCustomWebEvalCases(input: unknown) {
  const value = record(input);
  if (value.schemaVersion !== 1 || !Array.isArray(value.localCases)) throw new Error('不是受支持的联网评测题库 JSON（需要 schemaVersion: 1 和 localCases）');
  const imported: CustomCase[] = [];
  const errors: string[] = [];
  for (const [index, raw] of value.localCases.entries()) {
    try {
      const source = record(raw);
      // 导入一律生成新的本地 ID，永远不覆盖固定基线或已有本地题。
      imported.push(buildCase({ ...source, evidenceNeeds: source.expectedEvidence ?? source.evidenceNeeds }));
    } catch (error) { errors.push(`第 ${index + 1} 题：${error instanceof Error ? error.message : '格式无效'}`); }
  }
  if (errors.length) throw new Error(`导入已取消：${errors.join('；')}`);
  const insert = sqlite.prepare(`INSERT INTO web_evaluation_cases (
    id, title, question, category, answerable, include_domains_json, expected_domains_json, expected_evidence_json, metadata_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const transaction = sqlite.transaction((items: CustomCase[]) => items.forEach((item) => insert.run(...rowValues(item))));
  transaction(imported);
  return { importedCount: imported.length, cases: imported };
}

export function deleteCustomWebEvalCase(id: string) {
  return sqlite.prepare('DELETE FROM web_evaluation_cases WHERE id = ?').run(id).changes > 0;
}

function buildCase(value: Record<string, unknown>): CustomCase {
  const title = text(value.title, 80);
  const question = text(value.question, 1_000);
  if (!title || !question) throw new Error('题目名称和问题内容不能为空');
  const answerable = value.answerable !== false;
  const includeDomains = domains(value.includeDomains);
  const expectedDomains = domains(value.expectedDomains ?? value.includeDomains);
  const expectedEvidence = needs(value.expectedEvidence ?? value.evidenceNeeds);
  if (answerable && !expectedDomains.length) throw new Error('可回答题请至少填写一个预期官方域名');
  if (answerable && !expectedEvidence.length) throw new Error('可回答题请至少填写一个要验证的证据点');
  const now = new Date().toISOString();
  return {
    id: `custom-${randomUUID()}`, title, question,
    category: category(value.category, answerable, expectedEvidence.length), answerable,
    includeDomains: includeDomains.length ? includeDomains : undefined, expectedDomains, expectedEvidence,
    tags: arrayOfText(value.tags, 12, 40), difficulty: difficulty(value.difficulty),
    // 本地题可单独选择，但不会偷偷进入固定基线套件。
    suites: [], canonicalUrls: urls(value.canonicalUrls), createdAt: now, updatedAt: now
  };
}

function save(item: CustomCase) {
  sqlite.prepare(`INSERT INTO web_evaluation_cases (
    id, title, question, category, answerable, include_domains_json, expected_domains_json, expected_evidence_json, metadata_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(...rowValues(item));
}

function rowValues(item: CustomCase) {
  return [item.id, item.title, item.question, item.category, Number(item.answerable),
    item.includeDomains ? JSON.stringify(item.includeDomains) : null, JSON.stringify(item.expectedDomains), JSON.stringify(item.expectedEvidence),
    JSON.stringify({ tags: item.tags, difficulty: item.difficulty, canonicalUrls: item.canonicalUrls }), item.createdAt, item.updatedAt] as const;
}

function toCase(row: Row): CustomCase {
  const metadata = parse<Record<string, unknown>>(row.metadata_json, {});
  return {
    id: row.id, title: row.title, question: row.question, category: row.category, answerable: Boolean(row.answerable),
    includeDomains: parse<string[]>(row.include_domains_json, []), expectedDomains: parse<string[]>(row.expected_domains_json, []),
    expectedEvidence: parse<WebEvalEvidenceNeed[]>(row.expected_evidence_json, []), tags: arrayOfText(metadata.tags, 12, 40),
    difficulty: difficulty(metadata.difficulty), suites: [], canonicalUrls: urls(metadata.canonicalUrls), createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function record(value: unknown) { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, max: number) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function arrayOfText(value: unknown, maxItems: number, maxLength: number) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems) : []; }
function domains(value: unknown) { const raw = typeof value === 'string' ? value.split(/[，,;；\s]+/) : value; return arrayOfText(raw, 20, 253).map((item) => item.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean); }
function urls(value: unknown) { return arrayOfText(value, 20, 2_000).filter((item) => /^https:\/\//.test(item)); }
function needs(value: unknown): WebEvalEvidenceNeed[] {
  if (Array.isArray(value) && value.every((item) => item && typeof item === 'object')) {
    return value.map((item, index) => {
      const source = record(item);
      const label = text(source.label, 120);
      const groups = Array.isArray(source.groups) ? source.groups.map((group) => arrayOfText(group, 12, 80)).filter((group) => group.length) : [];
      return label ? { id: text(source.id, 60) || `need-${index + 1}`, label, groups: groups.length ? groups : [[label]] } : undefined;
    }).filter((item): item is WebEvalEvidenceNeed => Boolean(item)).slice(0, 12);
  }
  return arrayOfText(value, 12, 120).map((label, index) => ({ id: `need-${index + 1}`, label, groups: label.split(/[，,;；]/).map((part) => [part.trim()]).filter((group) => group[0]) }));
}
function parse<T>(value: string | null, fallback: T): T { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
function difficulty(value: unknown): WebEvalDifficulty { return value === 'easy' || value === 'hard' ? value : 'medium'; }
function category(value: unknown, answerable: boolean, needCount: number): WebEvalCategory { if (!answerable) return 'unanswerable'; return value === 'freshness' || value === 'url_direct' || value === 'official_api' || value === 'multi_claim' ? value : needCount > 1 ? 'multi_claim' : 'official_api'; }

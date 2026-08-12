import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { retrieveWebEvidence } from '../controller.js';
import { getWebEvalCases, webEvalCases, webEvalSuiteVersion, type WebEvalCase } from './fixtures.js';
import { listCustomWebEvalCases } from './caseStore.js';
import { runWebEvaluation, type WebEvalProgress } from './run.js';
import { createWebEvaluationRecord, updateWebEvaluationRecord, type WebEvaluationRecord } from './store.js';

export type WebEvaluationEvent = { type: 'progress' | 'completed' | 'failed'; evaluation: WebEvaluationRecord; progress?: WebEvalProgress };
const events = new EventEmitter();
events.setMaxListeners(100);
let activeEvaluationId: string | undefined;

export function listWebEvaluationCases() {
  const baseline = webEvalCases.map((item) => ({ ...item, custom: false }));
  const custom = listCustomWebEvalCases().map((item) => ({ ...item, custom: true }));
  return [...baseline, ...custom].map(({ expectedEvidence, ...item }) => ({ ...item, evidenceNeeds: expectedEvidence.map(({ id, label }) => ({ id, label })) }));
}

export function createAndStartWebEvaluation(input: { name?: string; caseIds?: unknown; k?: unknown } = {}) {
  if (activeEvaluationId) throw new Error('已有联网评测正在运行，请等待完成后再启动下一次');
  const requestedIds = Array.isArray(input.caseIds) ? input.caseIds.filter((id): id is string => typeof id === 'string') : undefined;
  const allCases = [...webEvalCases, ...listCustomWebEvalCases()];
  const cases = requestedIds?.length ? allCases.filter((item) => requestedIds.includes(item.id)) : getWebEvalCases();
  if (!cases.length) throw new Error('至少选择一个有效的联网评测问题');
  if (requestedIds && cases.length !== new Set(requestedIds).size) throw new Error('问题集中包含未知用例');
  const k = input.k === undefined ? 3 : Number(input.k);
  if (!Number.isInteger(k) || k < 1 || k > 10) throw new Error('k 必须是 1 到 10 之间的整数');
  const now = new Date().toISOString();
  const record = createWebEvaluationRecord({
    id: randomUUID(), name: input.name?.trim().slice(0, 80) || `联网评测 · ${now.slice(0, 16).replace('T', ' ')}`,
    status: 'queued', completedCases: 0, totalCases: cases.length,
    config: { caseIds: cases.map((item) => item.id), suiteVersion: webEvalSuiteVersion, k },
    createdAt: now, updatedAt: now
  });
  activeEvaluationId = record.id;
  setImmediate(() => void runPersisted(record.id, cases, k));
  return record;
}

export function subscribeToWebEvaluation(id: string, listener: (event: WebEvaluationEvent) => void) {
  const name = `web-evaluation:${id}`;
  events.on(name, listener);
  return () => events.off(name, listener);
}

async function runPersisted(id: string, cases: WebEvalCase[], k: number) {
  try {
    updateWebEvaluationRecord(id, { status: 'running', startedAt: new Date().toISOString() });
    const report = await runWebEvaluation({
      cases, suiteVersion: webEvalSuiteVersion, k,
      retrieve: (testCase) => retrieveWebEvidence({
        question: testCase.question,
        includeDomains: testCase.includeDomains,
        timeRange: testCase.timeRange,
        requiredEvidence: testCase.expectedEvidence,
        expectNoAnswer: !testCase.answerable
      }),
      onProgress: async (progress) => {
        const record = updateWebEvaluationRecord(id, {
          completedCases: progress.completed, currentCaseId: progress.currentCase?.id
        });
        if (record) emit(id, { type: 'progress', evaluation: record, progress });
      }
    });
    const record = updateWebEvaluationRecord(id, {
      status: 'completed', completedCases: cases.length, currentCaseId: undefined,
      report, completedAt: new Date().toISOString()
    });
    if (record) emit(id, { type: 'completed', evaluation: record });
  } catch (error) {
    const record = updateWebEvaluationRecord(id, {
      status: 'failed', currentCaseId: undefined,
      error: error instanceof Error ? error.message : '联网评测失败', completedAt: new Date().toISOString()
    });
    if (record) emit(id, { type: 'failed', evaluation: record });
  } finally {
    if (activeEvaluationId === id) activeEvaluationId = undefined;
  }
}

function emit(id: string, event: WebEvaluationEvent) { events.emit(`web-evaluation:${id}`, event); }

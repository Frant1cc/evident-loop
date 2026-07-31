// 离线冒烟测试：用真实语料 + 朴素字符匹配检索器驱动新版 runRagEvaluation，
// 验证三级指标计算、不可答用例统计与报告结构（不依赖 Embedding/Qdrant）。
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chunkMarkdownDocument } from '../chunker.js';
import { assessRetrievalConfidence } from '../confidence.js';
import type { RagSource } from '../types.js';
import { ragEvalCases, ragEvalConfig } from './fixtures.js';
import { runRagEvaluation } from './run.js';

const knowledgeDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/knowledge');

const files = (await readdir(knowledgeDir)).filter((file) => file.endsWith('.md')).sort();
const chunks = (await Promise.all(files.map(async (file) => {
  const content = await readFile(resolve(knowledgeDir, file), 'utf8');
  const lines = content.split(/\r?\n/);
  const title = lines.find((line) => line.startsWith('# '))?.slice(2).trim() ?? file;
  return chunkMarkdownDocument({ file, title, content, lineCount: lines.length });
}))).flat();

function bigrams(value: string) {
  const cleaned = value.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let index = 0; index < cleaned.length - 1; index += 1) grams.add(cleaned.slice(index, index + 2));
  return grams;
}

async function naiveSearch(query: string, limit: number) {
  const queryGrams = bigrams(query);
  const results: RagSource[] = chunks
    .map((chunk) => {
      const text = `${chunk.title}\n${chunk.heading ?? ''}\n${chunk.content}`;
      const grams = bigrams(text);
      let hit = 0;
      for (const gram of queryGrams) if (grams.has(gram)) hit += 1;
      return { chunk, score: queryGrams.size ? hit / queryGrams.size : 0 };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ chunk, score }) => ({
      id: chunk.id,
      file: chunk.file,
      title: chunk.title,
      heading: chunk.heading,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score,
      semanticScore: score
    }));
  return { results, ...assessRetrievalConfidence(results) };
}

const report = await runRagEvaluation({
  cases: ragEvalCases,
  k: ragEvalConfig.k,
  thresholds: ragEvalConfig.thresholds,
  collection: 'smoke',
  embeddingModel: 'naive-bigram',
  search: naiveSearch
});

const { metrics } = report;
// 用例数量从 fixtures 动态推导，语料/用例扩充后无需再改这里
const totalCaseCount = ragEvalCases.length;
const answerableCaseCount = ragEvalCases.filter((testCase) => testCase.answerable !== false).length;
const unanswerableCaseCount = totalCaseCount - answerableCaseCount;

const assertions: Array<[string, boolean]> = [
  ['schemaVersion is 4', report.schemaVersion === 4],
  [`caseCount = ${totalCaseCount}`, metrics.caseCount === totalCaseCount],
  [`answerableCaseCount = ${answerableCaseCount}`, metrics.answerableCaseCount === answerableCaseCount],
  [`unanswerable block exists with ${unanswerableCaseCount} cases`, metrics.unanswerable?.caseCount === unanswerableCaseCount],
  ['heading metrics cover all answerable cases', metrics.headingCaseCount === answerableCaseCount],
  ['anchor metrics cover all answerable cases', metrics.anchorCaseCount === answerableCaseCount],
  ['file recall within [0,1]', metrics.recallAtK >= 0 && metrics.recallAtK <= 1],
  ['heading recall <= file recall', (metrics.headingRecallAtK ?? 0) <= metrics.recallAtK + 1e-9],
  ['anchor recall <= file recall', (metrics.anchorRecallAtK ?? 0) <= metrics.recallAtK + 1e-9],
  ['categories exclude unanswerable', report.categories.every((category) => category.category !== 'unanswerable')],
  [`category caseCounts sum to ${answerableCaseCount}`, report.categories.reduce((total, category) => total + category.caseCount, 0) === answerableCaseCount],
  ['every unanswerable case has top1Score recorded', report.cases.filter((c) => !c.answerable).every((c) => c.top1Score !== undefined)],
  ['every case has a confidence verdict', report.cases.every((c) => ['sufficient', 'weak', 'empty'].includes(c.verdict))],
  ['confidence gate covers all unanswerable cases', metrics.confidenceGate.rejectedUnanswerableCount <= unanswerableCaseCount],
  ['confidence gate covers all answerable cases', metrics.confidenceGate.falselyRejectedAnswerableCount <= answerableCaseCount],
  ['query rewrite diagnostics cover every case', metrics.queryRewrite.totalQueryCount === totalCaseCount],
  ['retrieved entries carry heading/anchor flags', report.cases.every((c) => c.retrieved.every((r) => typeof r.headingRelevant === 'boolean' && typeof r.anchorRelevant === 'boolean'))]
];

let failed = 0;
for (const [name, ok] of assertions) {
  if (!ok) {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

console.log(`\nSmoke run (naive-bigram retriever, ${chunks.length} chunks):`);
console.log(`File:    Recall@3=${metrics.recallAtK.toFixed(3)} MRR@3=${metrics.mrrAtK.toFixed(3)} PassRate=${metrics.passRate.toFixed(3)}`);
console.log(`Heading: Recall@3=${metrics.headingRecallAtK?.toFixed(3)} MRR@3=${metrics.headingMrrAtK?.toFixed(3)}`);
console.log(`Anchor:  Recall@3=${metrics.anchorRecallAtK?.toFixed(3)} MRR@3=${metrics.anchorMrrAtK?.toFixed(3)}`);
console.log(`Top1:    answerable=${metrics.answerableAvgTop1Score?.toFixed(3)} unanswerable avg=${metrics.unanswerable?.avgTop1Score.toFixed(3)} max=${metrics.unanswerable?.maxTop1Score.toFixed(3)}`);
console.log(`Gate:    rejectionRecall=${metrics.confidenceGate.rejectionRecall.toFixed(3)} falseRejectionRate=${metrics.confidenceGate.falseRejectionRate.toFixed(3)}`);
console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll assertions passed');
if (failed) process.exit(1);

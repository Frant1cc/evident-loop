import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConfiguredLlm } from '../../llm/config.js';

import { ragEvalConfig } from './fixtures.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const defaultCollection = 'rag_eval';
const defaultReportPath = resolve(projectRoot, '.rag-eval/report.json');

async function main() {
  validateEnvironment();

  const { executeRagEvaluation } = await import('./service.js');

  const report = await executeRagEvaluation({
    k: ragEvalConfig.k,
    thresholds: ragEvalConfig.thresholds,
    onProgress: ({ completed, total, currentCase, result }) => {
      if (currentCase && !result) console.log(`[${completed + 1}/${total}] ${currentCase.id}`);
    }
  });

  const reportPath = resolve(process.env.RAG_EVAL_REPORT_PATH ?? defaultReportPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const { metrics } = report;
  const k = ragEvalConfig.k;
  console.log(`\nRAG evaluation ${report.status} (${metrics.answerableCaseCount} answerable / ${metrics.caseCount} total cases, retrieval=${report.config.retrieval ?? 'dense'})`);
  console.log(`File level:    Recall@${k}=${formatMetric(metrics.recallAtK)}  MRR@${k}=${formatMetric(metrics.mrrAtK)}  PassRate=${formatMetric(metrics.passRate)}`);
  if (metrics.headingRecallAtK !== undefined) {
    console.log(`Heading level: Recall@${k}=${formatMetric(metrics.headingRecallAtK)}  MRR@${k}=${formatMetric(metrics.headingMrrAtK ?? 0)}  (${metrics.headingCaseCount} cases)`);
  }
  if (metrics.anchorRecallAtK !== undefined) {
    console.log(`Anchor level:  Recall@${k}=${formatMetric(metrics.anchorRecallAtK)}  MRR@${k}=${formatMetric(metrics.anchorMrrAtK ?? 0)}  (${metrics.anchorCaseCount} cases)`);
  }
  if (metrics.unanswerable) {
    const answerableAvg = metrics.answerableAvgTop1Score !== undefined ? formatMetric(metrics.answerableAvgTop1Score) : 'n/a';
    console.log(`Top1 score:    answerable avg=${answerableAvg}  unanswerable avg=${formatMetric(metrics.unanswerable.avgTop1Score)} max=${formatMetric(metrics.unanswerable.maxTop1Score)} (${metrics.unanswerable.caseCount} cases)`);
  }
  console.log(`Confidence:    rejection recall=${formatMetric(metrics.confidenceGate.rejectionRecall)} (${metrics.confidenceGate.rejectedUnanswerableCount}/${metrics.unanswerable?.caseCount ?? 0})  false rejection=${formatMetric(metrics.confidenceGate.falseRejectionRate)} (${metrics.confidenceGate.falselyRejectedAnswerableCount}/${metrics.answerableCaseCount})`);
  console.log(`Query rewrite: triggered=${metrics.queryRewrite.triggeredCaseCount}/${metrics.caseCount} (${formatMetric(metrics.queryRewrite.triggerRate)})  avg queries=${metrics.queryRewrite.avgQueryCount.toFixed(2)}  max=${metrics.queryRewrite.maxQueryCount}${metrics.queryRewrite.avgRewriteDurationMs === undefined ? '' : `  avg rewrite=${metrics.queryRewrite.avgRewriteDurationMs.toFixed(0)}ms`}`);
  console.log(`Evaluation corpus: docs/knowledge. Report: ${reportPath}`);

  for (const result of report.cases.filter((item) => item.answerable && !item.passed)) {
    console.error(`\nFailed ${result.id}: ${result.query}`);
    console.error(`Expected files: ${result.expectedFiles.join(', ')}`);
    for (const item of result.retrieved) {
      const flags = [
        item.relevant ? 'file' : undefined,
        item.headingRelevant ? 'heading' : undefined,
        item.anchorRelevant ? 'anchor' : undefined
      ].filter(Boolean).join('+');
      console.error(`#${item.rank} ${item.file} ${item.heading ? `(${item.heading}) ` : ''}score=${item.score.toFixed(4)}${flags ? ` [${flags}]` : ''}`);
    }
  }

  if (report.status === 'fail') process.exitCode = 1;
}

function validateEnvironment() {
  const configuredLlm = createConfiguredLlm();
  if (!process.env.EMBEDDING_API_KEY) {
    throw new Error('EMBEDDING_API_KEY is required for RAG evaluation. An LLM key is not required when query rewrite is disabled.');
  }
  if (
    ['1', 'true', 'on', 'yes'].includes((process.env.RAG_QUERY_REWRITE ?? '').trim().toLowerCase())
    && !configuredLlm.llm
  ) {
    throw new Error(`${configuredLlm.providerName} API key is required when RAG_QUERY_REWRITE is enabled.`);
  }

  const collection = process.env.RAG_EVAL_COLLECTION ?? process.env.QDRANT_COLLECTION;
  if (!collection) {
    process.env.RAG_EVAL_COLLECTION = defaultCollection;
  } else if (collection === 'knowledge_chunks') {
    throw new Error('RAG_EVAL_COLLECTION must not use the production knowledge_chunks collection.');
  } else {
    process.env.RAG_EVAL_COLLECTION = collection;
  }
}

function formatMetric(value: number) {
  return value.toFixed(3);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

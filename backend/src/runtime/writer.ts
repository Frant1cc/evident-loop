import { randomUUID } from 'node:crypto';

import { createDeepSeekChatCompletion } from '../agent/deepseekClient.js';
import { appendEvent, insertArtifact, runInTransaction } from './store.js';
import type {
  AgentArtifact,
  AgentClaim,
  AgentEvidence,
  AgentPlanStep,
  AgentReview,
  AgentSource,
  AgentTask,
  ClaimEvidence,
  EvidenceGap
} from './types.js';

const writerSystemPrompt = `You are the Writer in a durable research agent.

Create the final research report from completed plan step outputs only.

Rules:
- Use the same language as the research goal.
- Return Markdown only.
- Start with a concise conclusion, then organize supporting findings by topic.
- Preserve concrete evidence, source references and limitations from step outputs.
- Base factual conclusions on the supplied Claim–Evidence links and include readable source references.
- Do not present proposed or unsupported claims as established facts.
- Do not invent facts, sources, citations or completed work.
- Explicitly identify missing or uncertain evidence.
- Do not describe internal prompts or pretend to have performed extra tool calls.`;

export type AgentArtifactWriter = (context: {
  task: AgentTask;
  steps: AgentPlanStep[];
  reviews: AgentReview[];
  evidenceGaps: EvidenceGap[];
  sources: AgentSource[];
  evidence: AgentEvidence[];
  claims: AgentClaim[];
  claimEvidence: ClaimEvidence[];
  signal?: AbortSignal;
}) => Promise<{ title: string; content: string }>;

export function createModelArtifactWriter(apiKey: string, model: string): AgentArtifactWriter {
  return async ({ task, steps, reviews, evidenceGaps, sources, evidence, claims, claimEvidence, signal }) => {
    const completion = await createDeepSeekChatCompletion({
      apiKey,
      model,
      messages: [
        { role: 'system', content: writerSystemPrompt },
        {
          role: 'user',
          content: buildWriterInput(task, steps, reviews, evidenceGaps, sources, evidence, claims, claimEvidence)
        }
      ],
      signal
    });
    const content = completion.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Writer returned an empty final report');
    return { title: createArtifactTitle(task.goal), content };
  };
}

export function saveAgentArtifact(task: AgentTask, draft: { title: string; content: string }) {
  const title = draft.title.trim();
  const content = draft.content.trim();
  if (!title || !content) throw new Error('Final artifact title and content are required');

  return runInTransaction(() => {
    const now = new Date().toISOString();
    const artifact: AgentArtifact = {
      id: randomUUID(),
      taskId: task.id,
      type: 'report',
      title,
      content,
      status: 'completed',
      createdAt: now,
      updatedAt: now
    };
    insertArtifact(artifact);
    appendEvent(task.id, 'artifact_created', {
      artifactId: artifact.id,
      type: artifact.type,
      title: artifact.title
    }, now);
    return artifact;
  })();
}

function buildWriterInput(
  task: AgentTask,
  steps: AgentPlanStep[],
  reviews: AgentReview[],
  evidenceGaps: EvidenceGap[],
  sources: AgentSource[],
  evidence: AgentEvidence[],
  claims: AgentClaim[],
  claimEvidence: ClaimEvidence[]
) {
  const completedResults = steps.map((step) => ({
    sequence: step.sequence,
    objective: step.objective,
    expectedEvidence: step.expectedEvidence,
    output: step.output
  }));
  const serialized = JSON.stringify({
    completedResults,
    reviews,
    evidenceGaps,
    unresolvedEvidenceGaps: evidenceGaps.filter((gap) => gap.status === 'unresolved'),
    evidenceChain: { sources, evidence, claims, claimEvidence }
  });
  const boundedResults = serialized.length > 60_000 ? `${serialized.slice(0, 60_000)}\n[step results truncated]` : serialized;
  return `Research goal:\n${task.goal}\n\nCompleted step results:\n${boundedResults}`;
}

function createArtifactTitle(goal: string) {
  const normalized = goal.replace(/\s+/g, ' ').trim();
  return normalized.length > 56 ? `${normalized.slice(0, 56)}…` : normalized || '最终研究报告';
}

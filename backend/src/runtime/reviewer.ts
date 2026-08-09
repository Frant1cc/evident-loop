import { createDeepSeekChatCompletion } from '../agent/deepseekClient.js';
import { claimExtractionOutput } from './evidenceChainBuilder.js';
import type {
  AgentClaim,
  AgentEvidence,
  AgentPlanStep,
  AgentReviewDraft,
  AgentSource,
  AgentTask,
  ClaimEvidence,
  ToolExecution
} from './types.js';

const reviewerSystemPrompt = `You are the Reviewer in a durable research agent.

Evaluate the structured Claim–Evidence chain for the completed step against the step objective and every expected-evidence item. A confident step summary is not evidence. A supported claim must have a valid direct supporting relation to evidence whose source and content can be inspected. Detect unsupported claims, weak/context-only links, contradictions and missing expected evidence. Do not invent facts.

Return JSON only with this exact shape:
{
  "verdict": "pass" | "needs_more_evidence",
  "summary": "short review summary",
  "supportedClaims": ["claims supported by evidence"],
  "unsupportedClaims": ["claims not adequately supported"],
  "limitations": ["remaining limitations"],
  "evidenceGaps": [
    {
      "description": "what is missing",
      "requiredEvidence": "what evidence would close the gap",
      "suggestedQuery": "a focused retrieval query"
    }
  ]
}

Use "pass" only when the expected evidence is sufficiently supported. When verdict is "needs_more_evidence", include at least one actionable evidence gap. When verdict is "pass", evidenceGaps must be empty. Use the same language as the research goal.`;

export type AgentStepReviewer = (context: {
  task: AgentTask;
  step: AgentPlanStep;
  toolExecutions: ToolExecution[];
  sources: AgentSource[];
  evidence: AgentEvidence[];
  claims: AgentClaim[];
  claimEvidence: ClaimEvidence[];
  signal?: AbortSignal;
}) => Promise<AgentReviewDraft>;

export function createModelStepReviewer(apiKey: string, model: string): AgentStepReviewer {
  return async (context) => {
    const { signal } = context;
    const input = JSON.stringify(buildReviewerInput(context));
    const boundedInput = input.length > 60_000 ? `${input.slice(0, 60_000)}\n[review input truncated]` : input;
    const request = {
      apiKey,
      model,
      messages: [
        { role: 'system' as const, content: reviewerSystemPrompt },
        { role: 'user' as const, content: boundedInput }
      ],
      signal
    };
    let completion = await createDeepSeekChatCompletion(request);
    let content = completion.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      completion = await createDeepSeekChatCompletion(request);
      content = completion.choices?.[0]?.message?.content;
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(describeEmptyReviewerCompletion(completion));
    }
    return parseReviewerResponse(content);
  };
}

export function buildReviewerInput(
  { task, step, toolExecutions, sources, evidence, claims, claimEvidence }: Parameters<AgentStepReviewer>[0]
) {
  return {
    researchGoal: task.goal,
    step: {
      sequence: step.sequence,
      objective: step.objective,
      expectedEvidence: step.expectedEvidence,
      input: step.input,
      output: claimExtractionOutput(step.output)
    },
    toolExecutions: toolExecutions.map((execution) => ({
      toolName: execution.toolName,
      arguments: execution.arguments,
      status: execution.status,
      ...(execution.error ? { error: execution.error } : {})
    })),
    evidenceChain: { sources, evidence, claims, claimEvidence }
  };
}

export function describeEmptyReviewerCompletion(completion: unknown) {
  const value = isRecord(completion) ? completion : undefined;
  const choiceCount = Array.isArray(value?.choices) ? value.choices.length : 0;
  let raw: string;
  try {
    raw = JSON.stringify(completion).slice(0, 500);
  } catch {
    raw = '<unserializable completion>';
  }
  return `Reviewer returned an empty response (choices: ${choiceCount}): ${raw}`;
}

export function parseReviewerResponse(content: string): AgentReviewDraft {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(normalized) as unknown;
  } catch {
    throw new Error('Reviewer returned invalid JSON');
  }
  if (!isRecord(value) || (value.verdict !== 'pass' && value.verdict !== 'needs_more_evidence')) {
    throw new Error('Reviewer returned an invalid verdict');
  }

  const summary = requiredString(value.summary, 'summary');
  const evidenceGaps = Array.isArray(value.evidenceGaps)
    ? value.evidenceGaps.slice(0, 8).map((gap) => {
        if (!isRecord(gap)) throw new Error('Reviewer returned an invalid evidence gap');
        return {
          description: requiredString(gap.description, 'evidence gap description'),
          requiredEvidence: requiredString(gap.requiredEvidence, 'required evidence'),
          suggestedQuery: requiredString(gap.suggestedQuery, 'suggested query')
        };
      })
    : [];
  if (value.verdict === 'needs_more_evidence' && !evidenceGaps.length) {
    throw new Error('Reviewer must provide evidence gaps when evidence is insufficient');
  }

  return {
    verdict: value.verdict,
    summary,
    supportedClaims: stringArray(value.supportedClaims),
    unsupportedClaims: stringArray(value.unsupportedClaims),
    limitations: stringArray(value.limitations),
    evidenceGaps: value.verdict === 'pass' ? [] : evidenceGaps
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Reviewer ${field} is required`);
  return value.trim();
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

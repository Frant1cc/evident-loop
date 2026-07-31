import { createDeepSeekChatCompletion } from '../agent/deepseekClient.js';
import type { AgentTask, PlanStepDraft } from './types.js';

const plannerSystemPrompt = `You are the Planner in a durable research agent.

Break the user's research goal into a short sequential plan. Return JSON only, without markdown fences or commentary.

Schema:
{"steps":[{"objective":"clear executable objective","expectedEvidence":["specific evidence requirement"]}]}

Rules:
- Each step must have one concrete, independently verifiable objective.
- Describe evidence to collect, not conclusions to invent.
- Do not include a final writing step; the runtime handles final artifact generation separately.
- Do not exceed the requested maximum number of steps.
- Return at least one step.
- Write objectives and evidence requirements in the same language as the user's research goal.`;

export async function generatePlanWithModel(options: {
  task: AgentTask;
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}) {
  const outputLanguage = detectPlanLanguage(options.task.goal);
  const completion = await createDeepSeekChatCompletion({
    apiKey: options.apiKey,
    model: options.model,
    messages: [
      { role: 'system', content: plannerSystemPrompt },
      {
        role: 'user',
        content: `Research goal:\n${options.task.goal}\n\nOutput language: ${outputLanguage.instruction}\n${outputLanguage.requirement}\n\nMaximum steps: ${options.task.maxSteps}\nAllowed tools: ${options.task.allowedTools.join(', ') || 'not restricted'}`
      }
    ],
    signal: options.signal
  });
  const content = completion.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new Error('Planner returned an empty response');
  const plan = parsePlannerResponse(content, options.task.maxSteps);
  validatePlanLanguage(plan, outputLanguage.code);
  return plan;
}

function detectPlanLanguage(goal: string) {
  if (/\p{Script=Han}/u.test(goal)) {
    return {
      code: 'zh' as const,
      instruction: '简体中文（zh-CN）',
      requirement: '所有 objective（步骤名称）和 expectedEvidence（证据要求）必须使用简体中文；技术专有名词可以保留英文，但不能生成全英文句子。'
    };
  }

  return {
    code: 'other' as const,
    instruction: 'Use the same language as the research goal.',
    requirement: 'Every objective and expectedEvidence item must follow that language.'
  };
}

function validatePlanLanguage(plan: PlanStepDraft[], language: 'zh' | 'other') {
  if (language !== 'zh') return;

  const hasEnglishOnlyText = plan.some((step) =>
    !/\p{Script=Han}/u.test(step.objective)
    || step.expectedEvidence.some((item) => !/\p{Script=Han}/u.test(item))
  );
  if (hasEnglishOnlyText) {
    throw new Error('Planner 未按要求生成中文步骤，请重新生成计划');
  }
}

export function parsePlannerResponse(content: string, maxSteps: number): PlanStepDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFence(content));
  } catch {
    throw new Error('Planner returned invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { steps?: unknown }).steps)) {
    throw new Error('Planner response must contain a steps array');
  }

  const rawSteps = (parsed as { steps: unknown[] }).steps;
  if (!rawSteps.length) throw new Error('Planner must return at least one step');
  if (rawSteps.length > maxSteps) throw new Error(`Planner returned more than ${maxSteps} steps`);

  return rawSteps.map((rawStep, index) => {
    if (!rawStep || typeof rawStep !== 'object') throw new Error(`Planner step ${index + 1} must be an object`);
    const objective = String((rawStep as { objective?: unknown }).objective ?? '').trim();
    const evidence = (rawStep as { expectedEvidence?: unknown }).expectedEvidence;
    if (!objective) throw new Error(`Planner step ${index + 1} objective is required`);
    if (!Array.isArray(evidence) || !evidence.length || evidence.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error(`Planner step ${index + 1} expectedEvidence must be a non-empty string array`);
    }
    return { objective, expectedEvidence: [...new Set(evidence.map((item) => item.trim()))] };
  });
}

function stripMarkdownFence(content: string) {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

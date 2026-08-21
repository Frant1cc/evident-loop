import type { ResearchStep } from '../types/research';
import type { WordArtifact } from '../types/artifacts';

export type AuxiliaryStatus = 'idle' | 'running' | 'complete' | 'error';

export type AuxiliaryState = {
  status: AuxiliaryStatus;
  label: string;
  activity: string;
  count: number;
};

/**
 * Tool-name → user-facing label/activity used when that tool is producing
 * auxiliary content for a message. Add entries here when a new tool surfaces
 * artifacts (e.g. PDF export, dataset download) so the per-message indicator
 * picks it up automatically.
 */
export const ARTIFACT_TOOL_LABELS: Record<string, { label: string; activity: string }> = {
  generate_word_document: { label: '生成的文档', activity: '正在生成文档…' },
  start_artifact_generation: { label: 'PPT / PDF 大纲', activity: '正在生成大纲…' }
};

const FALLBACK_LABELS = { label: '附件', activity: '正在加载附件…' };

function labelsFor(toolName: string) {
  return ARTIFACT_TOOL_LABELS[toolName] ?? FALLBACK_LABELS;
}

/**
 * Aggregate per-message auxiliary state from raw streaming events. The state
 * answers three questions a parent component needs to render an indicator:
 *   1. Is anything still in flight? (`running` if any tool step is still running)
 *   2. Did anything fail? (`error` if the last attempt errored and nothing is still running)
 *   3. How many finished artifacts does the message have? (sum of completed tool outputs)
 *
 * The function is pure: same inputs always yield the same map, no reactivity
 * involved, so it can be tested directly.
 */
export function buildAuxiliaryState(
  steps: ResearchStep[],
  artifactsByMessageId: Map<string, WordArtifact[]>
): Map<string, AuxiliaryState> {
  const states = new Map<string, AuxiliaryState>();

  for (const step of steps) {
    if (step.type !== 'tool') continue;
    const labels = labelsFor(step.title);

    let state = states.get(step.messageId);
    if (!state) {
      state = { status: 'idle', label: labels.label, activity: labels.activity, count: 0 };
      states.set(step.messageId, state);
    }

    if (step.status === 'running') {
      state.status = 'running';
    } else if (step.status === 'error' && state.status !== 'running') {
      state.status = 'error';
    }
  }

  for (const [messageId, artifacts] of artifactsByMessageId) {
    const existing = states.get(messageId);
    if (existing) {
      existing.count = artifacts.length;
      if (existing.status === 'idle') existing.status = 'complete';
    } else {
      const labels = labelsFor('generate_word_document');
      states.set(messageId, {
        status: 'complete',
        label: labels.label,
        activity: labels.activity,
        count: artifacts.length
      });
    }
  }

  return states;
}

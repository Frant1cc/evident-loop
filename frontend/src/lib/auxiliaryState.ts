import type { ResearchStep } from '../types/research';
import type { ArtifactDraftRequest, ResearchArtifactGeneration } from '../types/artifacts';

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
  start_document_generation: { label: '文档草稿', activity: '正在准备文档草稿…' }
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
  generationsByMessageId: Map<string, ResearchArtifactGeneration[]>,
  draftRequests: ArtifactDraftRequest[] = []
): Map<string, AuxiliaryState> {
  const states = new Map<string, AuxiliaryState>();
  const requestsById = new Map(draftRequests.map((request) => [request.id, request]));

  for (const step of steps) {
    if (step.type !== 'tool') continue;
    const labels = labelsFor(step.title);

    let state = states.get(step.messageId);
    if (!state) {
      state = { status: 'idle', label: labels.label, activity: labels.activity, count: 0 };
      states.set(step.messageId, state);
    }

    const draftRequest = step.title === 'start_document_generation'
      ? requestsById.get(readDraftRequestId(step.output))
      : undefined;

    if (step.status === 'running' || draftRequest?.status === 'queued' || draftRequest?.status === 'running') {
      state.status = 'running';
    } else if (
      (step.status === 'error' || draftRequest?.status === 'failed' || draftRequest?.status === 'cancelled')
      && state.status !== 'running'
    ) {
      state.status = 'error';
    }
  }

  for (const [messageId, generations] of generationsByMessageId) {
    const existing = states.get(messageId);
    if (existing) {
      existing.count = generations.length;
      if (existing.status === 'idle') existing.status = 'complete';
    } else {
      const labels = labelsFor('start_document_generation');
      states.set(messageId, {
        status: 'complete',
        label: labels.label,
        activity: labels.activity,
        count: generations.length
      });
    }
  }

  return states;
}

function readDraftRequestId(output: unknown) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '';
  const value = output as { generationId?: unknown; requestId?: unknown };
  if (typeof value.generationId === 'string') return value.generationId;
  return typeof value.requestId === 'string' ? value.requestId : '';
}

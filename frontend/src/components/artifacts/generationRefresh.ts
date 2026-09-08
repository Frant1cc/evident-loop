import type { ArtifactDraftRequest, ResearchArtifactGeneration } from '../../types/artifacts';

export type GenerationRefreshToken = Readonly<{
  conversationId: string;
  sessionEpoch: number;
  sequence: number;
}>;

export function shouldApplyGenerationRefresh(
  request: GenerationRefreshToken,
  current: GenerationRefreshToken
) {
  return request.conversationId === current.conversationId
    && request.sessionEpoch === current.sessionEpoch
    && request.sequence === current.sequence;
}

export function resolveRequestedGeneration(
  requestOrGenerationId: string | undefined,
  requests: ArtifactDraftRequest[],
  generations: ResearchArtifactGeneration[]
) {
  if (!requestOrGenerationId) return undefined;
  const request = requests.find((item) => item.id === requestOrGenerationId);
  const generationId = request?.generationId ?? requestOrGenerationId;
  return generations.find((generation) => generation.id === generationId);
}

export function resolveRunGeneration(
  researchRunId: string | undefined,
  requests: ArtifactDraftRequest[],
  generations: ResearchArtifactGeneration[]
) {
  if (!researchRunId) return undefined;
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request?.researchRunId === researchRunId && request.status === 'completed') {
      return resolveRequestedGeneration(request.id, requests, generations);
    }
  }
  return undefined;
}

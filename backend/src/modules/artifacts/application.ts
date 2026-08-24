import type { LlmProvider } from '../../llm/contracts.js';
import {
  createArtifactGenerationService,
  type ArtifactGenerationService
} from '../../artifacts/generation/index.js';

export type ArtifactApplicationDependencies = {
  llm?: LlmProvider;
  model: string;
  artifactModel?: string;
  generationService?: ArtifactGenerationService;
  isResearchConversationActive?: (conversationId: string) => boolean;
};

/** Public use-case interface for draft/confirm/rendered research artifacts. */
export function createArtifactApplication(dependencies: ArtifactApplicationDependencies) {
  const generation = dependencies.generationService ?? createArtifactGenerationService({
    llm: dependencies.llm,
    model: dependencies.artifactModel?.trim() || dependencies.model,
    isResearchConversationActive: dependencies.isResearchConversationActive
  });
  return {
    createDraft: generation.createDraft,
    requestDraft: generation.requestDraft,
    flushPendingDrafts: generation.flushPendingDrafts,
    finalizePendingDrafts: generation.finalizePendingDrafts,
    recoverPendingDrafts: generation.recoverPendingDrafts,
    listDraftRequests: generation.listDraftRequests,
    getDraftRequest: generation.getDraftRequest,
    getGeneration: generation.get,
    listGenerations: generation.list,
    updateDraft: generation.updateDraft,
    startRender: generation.startRender,
    retryOutput: generation.retryOutput,
    renderOutput: generation.renderOutput,
    cancelRender: generation.cancel,
    waitForRender: generation.waitForRender,
    getOutput: generation.getOutput,
    readOutput: generation.readOutput,
    getOutputGeneration: generation.getOutputGeneration,
    assertGenerationConversation: generation.assertGenerationConversation,
    deleteConversationArtifacts: generation.deleteConversationArtifacts,
    deleteGeneration: generation.deleteGeneration,
    confirmImageUse: (generationId: string, imageUrl: string, sourceId?: string) => generation.createImageConsent(generationId, imageUrl, sourceId),
    fetchSourceImage: (input: Parameters<typeof generation.fetchSourceImage>[0], options: { signal?: AbortSignal } = {}, conversationId?: string) => {
      if (conversationId) generation.assertGenerationConversation(input.generationId, conversationId);
      return generation.fetchSourceImage(input, options);
    }
  };
}

export type ArtifactApplication = ReturnType<typeof createArtifactApplication>;

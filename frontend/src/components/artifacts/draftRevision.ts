export type DraftRevisionState = {
  draftRevision: number;
  persistedRevision: number;
};

export type GenerationDraftRevision = DraftRevisionState & {
  generationId: string;
  observedSpecJson: string;
  persistedSpecJson: string;
};

export function createGenerationDraftRevision(generationId: string, specJson: string): GenerationDraftRevision {
  return {
    generationId,
    draftRevision: 0,
    persistedRevision: 0,
    observedSpecJson: specJson,
    persistedSpecJson: specJson
  };
}

export function observeGenerationDraftRevision(state: GenerationDraftRevision, specJson: string): GenerationDraftRevision {
  if (specJson === state.observedSpecJson) return state;
  return {
    ...state,
    observedSpecJson: specJson,
    draftRevision: specJson === state.persistedSpecJson ? state.draftRevision : nextDraftRevision(state.draftRevision)
  };
}

export function markGenerationDraftPersisted(
  state: GenerationDraftRevision,
  revision: number,
  specJson: string
): GenerationDraftRevision {
  return { ...state, persistedRevision: revision, persistedSpecJson: specJson };
}

export function nextDraftRevision(revision: number) {
  return revision + 1;
}

export function hasUnpersistedDraftChanges(state: DraftRevisionState) {
  return state.draftRevision !== state.persistedRevision;
}

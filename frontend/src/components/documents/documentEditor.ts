import { computed, ref, watch } from 'vue';
import type { ArtifactSpec, LongformBlock, ResearchArtifactGeneration } from '../../types/artifacts';
import {
  createGenerationDraftRevision,
  hasUnpersistedDraftChanges,
  markGenerationDraftPersisted,
  observeGenerationDraftRevision,
  type GenerationDraftRevision
} from '../artifacts/draftRevision';
import {
  createArtifactSessionToken,
  shouldApplyArtifactSessionResponse,
  type ArtifactSessionToken
} from '../artifacts/sessionEpoch';

export type DraftSaveState = 'saved' | 'dirty' | 'saving' | 'error';

type RevisionRecord = GenerationDraftRevision & { pendingSave?: Promise<boolean> };

export type DocumentEditorState = {
  saveState: DraftSaveState;
  error: string;
  busy: boolean;
};

export function useDocumentEditor(
  conversationId: () => string | undefined,
  enabled: () => boolean,
  sessionEpoch: () => number
) {
  const revisionRecords = new Map<string, RevisionRecord>();
  const saveState = ref<DraftSaveState>('saved');
  const error = ref('');
  const busy = ref(false);
  let saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  function currentSessionToken(): ArtifactSessionToken {
    return createArtifactSessionToken(conversationId(), sessionEpoch());
  }

  function isCurrentSession(token: ArtifactSessionToken) {
    return shouldApplyArtifactSessionResponse(token, currentSessionToken(), enabled());
  }

  function resetRevisionBaseline(generation: ResearchArtifactGeneration | undefined): RevisionRecord | undefined {
    if (!generation) return undefined;
    const json = JSON.stringify(generation.spec);
    const record = createGenerationDraftRevision(generation.id, json);
    revisionRecords.set(generation.id, record);
    return record;
  }

  function syncDraftRevision(generation: ResearchArtifactGeneration | undefined) {
    if (!generation) return;
    const json = JSON.stringify(generation.spec);
    const record = revisionRecords.get(generation.id) ?? resetRevisionBaseline(generation);
    if (!record) return;
    const updated = observeGenerationDraftRevision(record, json);
    revisionRecords.set(generation.id, updated);

    // Update save state based on revision
    if (hasUnpersistedDraftChanges(updated)) {
      if (saveState.value === 'saved') saveState.value = 'dirty';
    } else {
      if (saveState.value === 'dirty') saveState.value = 'saved';
    }
  }

  function scheduleSave(callback: () => Promise<boolean>, delay = 600) {
    if (saveDebounceTimer !== undefined) {
      clearTimeout(saveDebounceTimer);
    }
    saveState.value = 'dirty';
    saveDebounceTimer = setTimeout(() => {
      saveDebounceTimer = undefined;
      void callback();
    }, delay);
  }

  async function flushSave(callback: () => Promise<boolean>): Promise<boolean> {
    if (saveDebounceTimer !== undefined) {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = undefined;
    }
    if (saveState.value === 'dirty' || saveState.value === 'saving' || saveState.value === 'error') {
      return await callback();
    }
    return true;
  }

  function clearRevisions() {
    revisionRecords.clear();
    saveState.value = 'saved';
    error.value = '';
    if (saveDebounceTimer !== undefined) {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = undefined;
    }
  }

  return {
    saveState: computed(() => saveState.value),
    error: computed(() => error.value),
    busy: computed(() => busy.value),
    resetRevisionBaseline,
    syncDraftRevision,
    scheduleSave,
    flushSave,
    clearRevisions,
    isCurrentSession,
    currentSessionToken,
    revisionRecords,
    setSaveState: (state: DraftSaveState) => { saveState.value = state; },
    setError: (msg: string) => { error.value = msg; },
    setBusy: (value: boolean) => { busy.value = value; }
  };
}

export function generateBlockId(): string {
  return `block_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function createDefaultLongformBlock(type: LongformBlock['type']): LongformBlock {
  const id = generateBlockId();
  switch (type) {
    case 'heading':
      return { id, type: 'heading', level: 1, text: '', citations: [] };
    case 'paragraph':
      return { id, type: 'paragraph', text: '', citations: [] };
    case 'bulletList':
      return { id, type: 'bulletList', items: [''], citations: [] };
    case 'numberedList':
      return { id, type: 'numberedList', items: [''], citations: [] };
    case 'table':
      return { id, type: 'table', headers: [''], rows: [['']],  citations: [] };
    case 'pageBreak':
      return { id, type: 'pageBreak' };
    default:
      return { id, type: 'paragraph', text: '', citations: [] };
  }
}

export function moveArrayItem<T>(array: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex < 0 || fromIndex >= array.length || toIndex < 0 || toIndex >= array.length) {
    return array;
  }
  const result = [...array];
  const [item] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, item);
  return result;
}

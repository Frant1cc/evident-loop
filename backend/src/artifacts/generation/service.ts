import { createHash } from 'node:crypto';

import { createResearchSnapshot, isResearchSnapshotStale } from './snapshot.js';
import {
  cloneArtifactGenerationAsVersion,
  cloneArtifactGenerationMedia,
  createArtifactGeneration,
  createArtifactOutput,
  deleteArtifactRecordsForConversation,
  getArtifactGeneration,
  getArtifactOutput,
  getArtifactOutputByFormat,
  listArtifactBinaryReferences,
  listArtifactBinaryReferencesForGeneration,
  createArtifactImageConsent,
  getArtifactImageConsent,
  listArtifactImageConsents,
  listArtifactGenerations,
  listAllArtifactGenerations,
  listArtifactAssets,
  deleteArtifactRecordsForGeneration,
  updateArtifactGeneration,
  updateArtifactOutput,
  updateArtifactSpec,
  claimArtifactDraftRequest,
  createArtifactDraftRequest,
  failInFlightArtifactDraftRequests,
  finalizeArtifactDraftRequests,
  finishArtifactDraftRequest,
  getArtifactDraftRequest,
  listArtifactDraftRequests
} from './repository.js';
import { lastUserTextFromSnapshot, resolveArtifactFormats } from './formats.js';
import { parseArtifactPreferences, parseArtifactSpec } from './schema.js';
import { createArtifactAgent, type ArtifactAgent } from './agent.js';
import {
  createDefaultArtifactQualityInspector,
  createDefaultRenderers,
  RendererUnavailableError
} from './renderers.js';
import { artifactBinaryStore } from './binaryStore.js';
import { fetchSourceImage, validateImageUrl } from './images.js';
import type {
  ArtifactBinaryStore,
  ArtifactFormat,
  ArtifactGeneration,
  ArtifactOutput,
  ArtifactQualityInspector,
  ArtifactRenderer,
  ArtifactSpec,
  ArtifactStatus,
  RendererResult,
  ArtifactRenderAsset,
  ArtifactVisualProvenance
} from './types.js';
import type { LlmProvider } from '../../llm/contracts.js';

export class ArtifactNotFoundError extends Error {
  readonly code = 'artifact_not_found';
}

export class ArtifactStaleError extends Error {
  readonly code = 'artifact_snapshot_stale';
}

export class ArtifactStateError extends Error {
  readonly code = 'artifact_invalid_state';
}

export type ArtifactGenerationService = ReturnType<typeof createArtifactGenerationService>;

export function createArtifactGenerationService(options: {
  llm?: LlmProvider;
  model: string;
  agent?: ArtifactAgent;
  renderers?: Partial<Record<ArtifactFormat, ArtifactRenderer>>;
  qualityInspector?: ArtifactQualityInspector;
  binaryStore?: ArtifactBinaryStore;
  isResearchConversationActive?: (conversationId: string) => boolean;
  imageFetchImpl?: typeof fetch;
}) {
  const agent = options.agent ?? createArtifactAgent({ llm: options.llm, model: options.model });
  const renderers = { ...createDefaultRenderers(), ...options.renderers } as Record<ArtifactFormat, ArtifactRenderer>;
  const qualityInspector = options.qualityInspector ?? createDefaultArtifactQualityInspector();
  const binaryStore = options.binaryStore ?? artifactBinaryStore;
  const activeControllers = new Map<string, AbortController>();
  const renderPromises = new Map<string, Promise<void>>();
  const mediaPromises = new Map<string, Promise<unknown>>();
  const deletingConversations = new Set<string>();
  const deletingGenerations = new Set<string>();
  // Synchronous lifecycle transitions (draft -> confirmed, delete) use this
  // guard as their critical section. Media tasks consult it before starting
  // and again immediately before their durable writes.
  const transitioningGenerations = new Set<string>();

  const get = (id: string) => {
    const generation = getArtifactGeneration(id);
    if (!generation) return undefined;
    if ((generation.status === 'awaiting_confirmation' || generation.status === 'planning') && isResearchSnapshotStale(generation.snapshot)) {
      return updateArtifactGeneration(id, { stale: true }) ?? generation;
    }
    return generation;
  };

  const createDraft = async (conversationId: string, rawPreferences?: unknown, signal?: AbortSignal) => {
    if (deletingConversations.has(conversationId)) {
      throw new ArtifactStateError('Research conversation artifacts are being deleted');
    }
    if (options.isResearchConversationActive?.(conversationId)) {
      throw new ArtifactStateError('Wait for the active research run to complete before creating an artifact draft');
    }
    const parsedPreferences = rawPreferences === undefined ? undefined : parseArtifactPreferences(rawPreferences);
    const snapshot = createResearchSnapshot(conversationId);
    if (!snapshot.messages.length) throw new ArtifactStateError('Research conversation has no completed messages');
    const preferences = {
      ...parsedPreferences,
      formats: resolveArtifactFormats({
        requested: parsedPreferences?.formats,
        userText: lastUserTextFromSnapshot(snapshot)
      })
    };
    const spec = await agent.plan(snapshot, preferences, signal);
    // A run can start while the text model is planning. Re-check immediately
    // before persistence so a draft can never be created from a moving
    // conversation boundary; callers should queue it for the run-complete
    // coordinator instead.
    if (options.isResearchConversationActive?.(conversationId)) {
      throw new ArtifactStateError('Research run started while the artifact draft was being planned');
    }
    return createArtifactGeneration({ conversationId, snapshot, spec, status: 'awaiting_confirmation' });
  };

  const requestDraft = async (
    conversationId: string,
    rawPreferences?: unknown,
    signal?: AbortSignal,
    context?: { researchRunId?: string }
  ) => {
    if (!options.isResearchConversationActive?.(conversationId)) {
      return { queued: false as const, generation: await createDraft(conversationId, rawPreferences, signal) };
    }
    if (!context?.researchRunId) {
      throw new ArtifactStateError('An active research run must provide its durable identity before queuing an artifact draft');
    }
    const preferences = rawPreferences === undefined ? undefined : parseArtifactPreferences(rawPreferences);
    const request = createArtifactDraftRequest({
      conversationId,
      researchRunId: context.researchRunId,
      preferences
    });
    return {
      queued: true as const,
      requestId: request.id,
      conversationId,
      message: 'Research is still running. The artifact draft will be created from the completed conversation snapshot when the run finishes.'
    };
  };

  const flushPendingDrafts = async (conversationId: string, researchRunId?: string) => {
    const requests = listArtifactDraftRequests(conversationId, researchRunId)
      .filter((request) => request.status === 'queued');
    const generations = [];
    for (const request of requests) {
      const claimed = claimArtifactDraftRequest(request.id);
      if (!claimed) continue;
      try {
        const generation = await createDraft(conversationId, claimed.preferences);
        finishArtifactDraftRequest({ id: claimed.id, status: 'completed', generationId: generation.id });
        generations.push(generation);
      } catch (error) {
        // Planning failures stay observable on the durable request row. The
        // research run itself remains terminal and the user can retry from the
        // explicit artifact entry point.
        finishArtifactDraftRequest({
          id: claimed.id,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Artifact planning failed'
        });
      }
    }
    return generations;
  };

  const finalizePendingDrafts = (
    conversationId: string,
    status: 'failed' | 'cancelled',
    researchRunId?: string,
    error = status === 'cancelled' ? 'The research run was cancelled' : 'The research run failed'
  ) => finalizeArtifactDraftRequests({ conversationId, researchRunId, status, error });

  const recoverPendingDrafts = () => failInFlightArtifactDraftRequests(
    'The backend restarted while planning this artifact draft; please request it again'
  );

  const updateDraft = (id: string, rawSpec: unknown) => {
    const current = get(id);
    if (!current) throw new ArtifactNotFoundError('Artifact draft not found');
    if (current.stale) throw new ArtifactStaleError('Artifact draft is stale; create a new draft from the conversation');
    if (current.status !== 'awaiting_confirmation' && current.status !== 'planning') {
      throw new ArtifactStateError('Only an awaiting-confirmation artifact draft can be edited');
    }
    const spec = normalizeArtifactSpecTargets(parseArtifactSpec(rawSpec));
    return updateArtifactSpec(id, spec);
  };

  const startRender = (id: string, signal?: AbortSignal) => {
    const draft = get(id);
    if (!draft) throw new ArtifactNotFoundError('Artifact draft not found');
    if (deletingGenerations.has(draft.id) || deletingConversations.has(draft.conversationId)) {
      throw new ArtifactStateError('Research conversation artifacts are being deleted');
    }
    if (draft.stale || isResearchSnapshotStale(draft.snapshot)) {
      updateArtifactGeneration(id, { stale: true });
      throw new ArtifactStaleError('Artifact draft is stale; create a new draft before rendering');
    }
    if (draft.status !== 'awaiting_confirmation' && draft.status !== 'planning') {
      throw new ArtifactStateError('Artifact draft is not awaiting confirmation');
    }
    if (transitioningGenerations.has(draft.id)) {
      throw new ArtifactStateError('Artifact draft confirmation is already in progress');
    }
    if (hasPendingMediaTasks(draft.id)) {
      throw new ArtifactStateError('Wait for draft image operations to finish before confirming the artifact');
    }
    transitioningGenerations.add(draft.id);
    try {
      // No await occurs in this critical section: once the pending-media
      // check passes, clone/re-home and freeze the source draft atomically
      // with respect to every media entry point in this service.
      const generation = cloneArtifactGenerationAsVersion(draft);
      let mediaCopy: ReturnType<typeof cloneArtifactGenerationMedia>;
      try {
        mediaCopy = cloneArtifactGenerationMedia(draft.id, generation.id);
      } catch (error) {
        deleteArtifactRecordsForGeneration(generation.id);
        throw error;
      }
      updateArtifactGeneration(id, { status: 'superseded' });
      for (const format of generation.spec.formats) createArtifactOutput(generation.id, generation.version, format);
      launchRender(generation.id, signal, undefined, mediaCopy);
      return getArtifactGeneration(generation.id)!;
    } finally {
      transitioningGenerations.delete(draft.id);
    }
  };

  const retryOutput = (outputId: string, signal?: AbortSignal) => {
    const output = getArtifactOutput(outputId);
    if (!output) throw new ArtifactNotFoundError('Artifact output not found');
    const generation = getArtifactGeneration(output.generationId);
    if (!generation) throw new ArtifactNotFoundError('Artifact generation not found');
    if (deletingGenerations.has(generation.id) || deletingConversations.has(generation.conversationId)) {
      throw new ArtifactStateError('Artifact generation is being deleted');
    }
    // A confirmed immutable version intentionally remains renderable after the
    // conversation changes. Only an unconfirmed draft is stale-sensitive.
    if (output.status !== 'failed' && output.status !== 'cancelled') {
      throw new ArtifactStateError('Only a failed or cancelled artifact output can be retried');
    }
    updateArtifactGeneration(generation.id, { status: 'rendering' });
    launchRender(generation.id, signal, output.format);
    return getArtifactGeneration(generation.id)!;
  };

  const renderOutput = (generationId: string, format: ArtifactFormat, signal?: AbortSignal) => {
    const generation = getArtifactGeneration(generationId);
    if (!generation) throw new ArtifactNotFoundError('Artifact generation not found');
    if (deletingGenerations.has(generationId) || deletingConversations.has(generation.conversationId)) {
      throw new ArtifactStateError('Artifact generation is being deleted');
    }
    if (generation.stale || generation.status === 'awaiting_confirmation' || generation.status === 'planning' || generation.status === 'superseded') {
      throw new ArtifactStateError('Only a confirmed immutable render version can use the single-format pipeline');
    }
    const output = getArtifactOutputByFormat(generationId, format);
    if (!output) throw new ArtifactNotFoundError(`Artifact ${format} output not found`);
    if (output.status !== 'failed' && output.status !== 'cancelled') {
      throw new ArtifactStateError('Only a failed or cancelled artifact output can use the single-format pipeline');
    }
    updateArtifactGeneration(generationId, { status: 'rendering' });
    launchRender(generationId, signal, format);
    return getArtifactGeneration(generationId)!;
  };

  function launchRender(
    id: string,
    signal?: AbortSignal,
    onlyFormat?: ArtifactFormat,
    mediaCopy?: ReturnType<typeof cloneArtifactGenerationMedia>
  ) {
    const taskKey = `${id}:${onlyFormat ?? 'all'}`;
    // A retry for each format owns a separate task. Never replace a live
    // controller/promise with another format's work under the generation id.
    if (renderPromises.has(taskKey)) return;
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    activeControllers.set(taskKey, controller);
    const promise = renderGeneration(id, controller.signal, onlyFormat, mediaCopy)
      .finally(() => {
        if (activeControllers.get(taskKey) === controller) activeControllers.delete(taskKey);
        if (renderPromises.get(taskKey) === promise) renderPromises.delete(taskKey);
      });
    renderPromises.set(taskKey, promise);
    void promise;
  }

  function runMediaTask<T>(
    generationId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal
  ) {
    const generation = getArtifactGeneration(generationId);
    if (!generation) throw new ArtifactNotFoundError('Artifact generation not found');
    if (deletingGenerations.has(generationId) || deletingConversations.has(generation.conversationId)) {
      throw new ArtifactStateError('Artifact generation is being deleted');
    }
    if (transitioningGenerations.has(generationId)) {
      throw new ArtifactStateError('Artifact generation confirmation is in progress');
    }
    const taskKey = `${generationId}:media:${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16)}`;
    const controller = new AbortController();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
    }
    activeControllers.set(taskKey, controller);
    const promise = operation(controller.signal).finally(() => {
      if (activeControllers.get(taskKey) === controller) activeControllers.delete(taskKey);
      if (mediaPromises.get(taskKey) === promise) mediaPromises.delete(taskKey);
    });
    mediaPromises.set(taskKey, promise);
    return promise;
  }

  const tasksForGeneration = (id: string) => {
    const prefix = `${id}:`;
    return [
      ...renderPromises.entries(),
      ...mediaPromises.entries()
    ].filter(([key]) => key.startsWith(prefix));
  };

  const hasPendingMediaTasks = (id: string) => [...mediaPromises.keys()].some((key) => key.startsWith(`${id}:media:`));

  const waitForGenerationTasks = async (id: string) => {
    // A delete/cancel marks the generation as deleting first, so no new task
    // can be added while this drain is in progress. The loop still handles a
    // task that schedules its final promise during the first await.
    while (true) {
      const tasks = tasksForGeneration(id).map(([, promise]) => promise);
      if (!tasks.length) return;
      await Promise.allSettled(tasks);
      if (!tasksForGeneration(id).length) return;
    }
  };

  const cancel = (id: string) => {
    const generation = getArtifactGeneration(id);
    if (!generation) throw new ArtifactNotFoundError('Artifact generation not found');
    for (const [taskKey, controller] of activeControllers) {
      if (taskKey.startsWith(`${id}:`)) controller.abort(new Error('Artifact generation cancelled'));
    }
    if (generation.status === 'rendering' || generation.status === 'validating' || generation.status === 'repairing') {
      updateArtifactGeneration(id, { status: 'cancelled' });
      for (const output of generation.outputs) {
        if (output.status === 'pending' || output.status === 'rendering' || output.status === 'validating') {
          updateArtifactOutput(output.id, { status: 'cancelled', error: 'Artifact generation cancelled' });
        }
      }
    }
    return getArtifactGeneration(id)!;
  };

  const deleteConversationArtifacts = async (
    conversationId: string,
    commitConversationDelete?: () => Promise<boolean> | boolean
  ) => {
    if (deletingConversations.has(conversationId)) throw new ArtifactStateError('Research conversation deletion is already in progress');
    deletingConversations.add(conversationId);
    const generations = listArtifactGenerations(conversationId);
    try {
      for (const generation of generations) {
        for (const [taskKey, controller] of activeControllers) {
          if (taskKey.startsWith(`${generation.id}:`)) controller.abort(new Error('Conversation deleted'));
        }
      }
      await Promise.all(generations.map((generation) => waitForGenerationTasks(generation.id)));
      const references = deduplicateReferences(listArtifactBinaryReferences(conversationId));
      const backups: Array<{ key: string; buffer: Buffer }> = [];
      try {
        for (const reference of references) {
          const buffer = await binaryStore.get(reference.key);
          if (buffer) {
            backups.push({ key: reference.key, buffer });
            await binaryStore.delete(reference.key);
          }
        }
        if (commitConversationDelete) {
          const committed = await commitConversationDelete();
          if (!committed) throw new Error('Research conversation deletion did not commit');
        } else {
          deleteArtifactRecordsForConversation(conversationId);
        }
      } catch (error) {
        for (const backup of backups) {
          try {
            await binaryStore.put(backup.key, backup.buffer);
          } catch {
            // Preserve the original failure while best-effort compensation restores the store.
          }
        }
        throw error;
      }
      return generations.length;
    } finally {
      deletingConversations.delete(conversationId);
    }
  };

  const createImageConsent = (generationId: string, imageUrl: string, sourceId?: string) => {
    const generation = getArtifactGeneration(generationId);
    if (!generation) throw new ArtifactNotFoundError('Artifact generation not found');
    assertMutableMediaGeneration(generation);
    let normalizedUrl: string;
    try {
      normalizedUrl = validateImageUrl(imageUrl);
    } catch (error) {
      throw new ArtifactStateError(error instanceof Error ? error.message : 'Image consent requires a valid HTTPS URL');
    }
    return createArtifactImageConsent({
      generationId,
      conversationId: generation.conversationId,
      imageUrl: normalizedUrl,
      ...(sourceId ? { sourceId } : {})
    });
  };

  function assertMutableMediaGeneration(generation: ArtifactGeneration) {
    if (deletingGenerations.has(generation.id) || deletingConversations.has(generation.conversationId)) {
      throw new ArtifactStateError('Artifact generation is being deleted');
    }
    if (transitioningGenerations.has(generation.id)) {
      throw new ArtifactStateError('Artifact generation confirmation is in progress');
    }
    if (generation.status !== 'awaiting_confirmation' && generation.status !== 'planning') {
      throw new ArtifactStateError('Only a planning or awaiting-confirmation draft can add image consent or assets');
    }
  }

  function assertMediaTaskStillMutable(generationId: string) {
    const generation = getArtifactGeneration(generationId);
    if (!generation) throw new ArtifactNotFoundError('Artifact generation not found');
    assertMutableMediaGeneration(generation);
  }

  const verifyImageConsent = (generationId: string, consentId: string, imageUrl: string) => {
    const generation = getArtifactGeneration(generationId);
    const consent = getArtifactImageConsent(consentId);
    if (!generation || !consent || consent.generationId !== generationId || consent.conversationId !== generation.conversationId) {
      throw new ArtifactStateError('Image usage consent does not belong to this artifact generation');
    }
    const normalizedUrl = new URL(imageUrl).toString();
    if (normalizedUrl !== consent.imageUrl) throw new ArtifactStateError('Image URL does not match the confirmed usage consent');
    return consent;
  };

  const readOutput = async (outputId: string, preview = false) => {
    const output = getArtifactOutput(outputId);
    if (!output) return undefined;
    const key = `generations/${output.generationId}/v${output.version}/${output.format}-${output.id}${preview && output.format === 'pptx' ? '-preview' : ''}`;
    const buffer = await binaryStore.get(key);
    return buffer ? { output, buffer, preview } : undefined;
  };

  async function renderGeneration(
    id: string,
    signal: AbortSignal,
    onlyFormat?: ArtifactFormat,
    mediaCopy?: ReturnType<typeof cloneArtifactGenerationMedia>
  ) {
    const generation = getArtifactGeneration(id);
    if (!generation) return;
    try {
      if (mediaCopy) await copyRehomedAssetBinaries(mediaCopy.mediaCopies, binaryStore, signal);
      const spec = generation.spec;
      const formats = onlyFormat ? [onlyFormat] : spec.formats;
      const outputByFormat = new Map(
        generation.outputs.map((output) => [output.format, output])
      );
      let successful = 0;

      for (const format of formats) {
        throwIfAborted(signal);
        const output = outputByFormat.get(format)
          ?? (onlyFormat ? createArtifactOutput(id, generation.version, format) : undefined);
        if (!output) continue;
        const result = await renderOne(output, format, spec, generation.snapshot, signal);
        if (result) successful += 1;
      }

      const latest = getArtifactGeneration(id);
      if (!latest) return;
      const statuses = latest.outputs.map((output) => output.status);
      const hasCompleted = statuses.includes('completed');
      const hasFailed = statuses.includes('failed');
      const status: ArtifactStatus = hasCompleted && hasFailed
        ? 'partial'
        : hasCompleted && statuses.every((item) => item === 'completed')
          ? 'completed'
          : signal.aborted ? 'cancelled' : successful > 0 ? 'partial' : 'failed';
      updateArtifactGeneration(id, { status });
    } catch (error) {
      if (!signal.aborted) {
        const message = getErrorMessage(error);
        updateArtifactGeneration(id, { status: 'failed' });
        for (const output of getArtifactGeneration(id)?.outputs ?? []) {
          if (output.status === 'pending' || output.status === 'rendering' || output.status === 'validating') {
            updateArtifactOutput(output.id, { status: 'failed', error: message, diagnostics: [message] });
          }
        }
      } else {
        updateArtifactGeneration(id, { status: 'cancelled' });
        for (const output of getArtifactGeneration(id)?.outputs ?? []) {
          if (output.status === 'pending' || output.status === 'rendering' || output.status === 'validating') {
            updateArtifactOutput(output.id, { status: 'cancelled', error: 'Artifact generation cancelled' });
          }
        }
      }
    }
  }

  async function renderOne(
    output: ArtifactOutput,
    format: ArtifactFormat,
    initialSpec: ArtifactSpec,
    snapshot: ArtifactGeneration['snapshot'],
    signal: AbortSignal
  ) {
    let spec = initialSpec;
    let lastDiagnostics: string[] = [];
    let lastProgress: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      throwIfAborted(signal);
      updateArtifactOutput(output.id, { status: 'rendering', attempts: attempt, error: undefined });
      let storageKey: string | undefined;
      let previewKey: string | undefined;
      let storageWritten = false;
      try {
        const renderer = renderers[format];
        // Word currently has no image blocks, so it must not perform media IO.
        // Fixed-layout outputs can consume only user-authorized source assets;
        // when none are available their renderers use deterministic geometry.
        const resolvedAssets = format === 'docx'
          ? { assets: [], provenance: [] }
          : await resolveRenderAssets(output.generationId, binaryStore);
        const execution = await agent.execute({
          format,
          spec,
          snapshot,
          renderer,
          qualityInspector,
          context: {
            signal,
            assets: resolvedAssets.assets,
            snapshot,
            visualProvenance: resolvedAssets.provenance,
            // Surface per-step renderer progress to the polled generation
            // detail so the UI can show a live pipeline, not just statuses.
            // Only persist when the message changes to avoid hot-path writes.
            onProgress: (message) => {
              if (message === lastProgress) return;
              lastProgress = message;
              updateArtifactOutput(output.id, { progress: message });
            }
          }
        });
        throwIfAborted(signal);
        const result = {
          ...execution.result,
          provenance: mergeProvenance(resolvedAssets.provenance, execution.result.provenance),
          // Persist the exact spec used by this successful attempt. The
          // renderer may add diagnostics, but must not silently alter it.
          renderedSpec: spec
        } satisfies RendererResult;
        updateArtifactGeneration(output.generationId, { status: 'validating' });
        updateArtifactOutput(output.id, { status: 'validating' });
        const report = execution.quality;
        if (!report.ok) {
          lastDiagnostics = report.diagnostics;
          throw new Error(report.diagnostics.join('; '));
        }
        storageKey = `generations/${output.generationId}/v${output.version}/${format}-${output.id}`;
        await binaryStore.put(storageKey, result.buffer);
        storageWritten = true;
        if (report.preview ?? result.preview) {
          previewKey = `${storageKey}-preview`;
          await binaryStore.put(previewKey, report.preview ?? result.preview!);
        } else if (format === 'pdf') {
          previewKey = storageKey;
        }
        throwIfAborted(signal);
        updateArtifactOutput(output.id, {
          status: 'completed',
          fileName: result.fileName,
          contentType: result.contentType,
          size: result.buffer.byteLength,
          storageKey,
          ...(previewKey ? { previewKey } : {}),
          provenance: result.provenance,
          renderedSpec: spec,
          renderedSpecDigest: digestArtifactSpec(spec),
          diagnostics: [...(result.diagnostics ?? []), ...report.diagnostics]
        });
        return true;
      } catch (error) {
        if (storageWritten && storageKey) {
          try { await binaryStore.delete(storageKey); } catch { /* cleanup is best effort */ }
        }
        if (previewKey && previewKey !== storageKey) {
          try { await binaryStore.delete(previewKey); } catch { /* cleanup is best effort */ }
        }
        if (signal.aborted) {
          throwIfAborted(signal);
        }
        lastDiagnostics = [...lastDiagnostics, getErrorMessage(error)];
        if (error instanceof RendererUnavailableError || isRendererUnavailable(error)) {
          updateArtifactOutput(output.id, {
            status: 'failed',
            error: getErrorMessage(error),
            diagnostics: lastDiagnostics
          });
          return false;
        }
        if (attempt >= 3) {
          updateArtifactOutput(output.id, {
            status: 'failed',
            error: getErrorMessage(error),
            diagnostics: lastDiagnostics
          });
          return false;
        }
        updateArtifactGeneration(output.generationId, { status: 'repairing' });
        try {
          // A confirmed generation is immutable. Repairs are format-local so
          // a PPTX retry cannot rewrite the shared brief used by PDF (or vice
          // versa); only the successful attempt's effective spec is persisted
          // on that output.
          const repaired = await agent.repair(spec, format, lastDiagnostics, signal);
          if (repaired) spec = mergeFormatLocalRepair(spec, repaired, format);
        } catch (repairError) {
          lastDiagnostics.push(getErrorMessage(repairError));
        }
        updateArtifactGeneration(output.generationId, { status: 'rendering' });
      }
    }
    return false;
  }

  return {
    createDraft,
    requestDraft,
    flushPendingDrafts,
    finalizePendingDrafts,
    recoverPendingDrafts,
    listDraftRequests: (conversationId: string, researchRunId?: string) => listArtifactDraftRequests(conversationId, researchRunId),
    getDraftRequest: (id: string) => {
      return getArtifactDraftRequest(id);
    },
    get,
    list: (conversationId: string) => listArtifactGenerations(conversationId).map((generation) => {
      if ((generation.status === 'awaiting_confirmation' || generation.status === 'planning') && isResearchSnapshotStale(generation.snapshot)) {
        return updateArtifactGeneration(generation.id, { stale: true }) ?? generation;
      }
      return generation;
    }),
    listAll: () => listAllArtifactGenerations().map((generation) => {
      if ((generation.status === 'awaiting_confirmation' || generation.status === 'planning') && isResearchSnapshotStale(generation.snapshot)) {
        return updateArtifactGeneration(generation.id, { stale: true }) ?? generation;
      }
      return generation;
    }),
    updateDraft,
    startRender,
    retryOutput,
    renderOutput,
    cancel,
    waitForRender: (id: string) => waitForGenerationTasks(id),
    deleteConversationArtifacts,
    createImageConsent,
    verifyImageConsent,
    fetchSourceImage: (
      input: Omit<Parameters<typeof fetchSourceImage>[0], 'licenseConfirmed' | 'consentId'> & { consentId: string },
      fetchOptions: { signal?: AbortSignal } = {}
    ) => {
      const consent = verifyImageConsent(input.generationId, input.consentId, input.imageUrl);
      const generation = getArtifactGeneration(input.generationId);
      if (!generation) throw new ArtifactNotFoundError('Artifact generation not found');
      assertMutableMediaGeneration(generation);
      if (consent.sourceId && input.sourceId && consent.sourceId !== input.sourceId) {
        throw new ArtifactStateError('Image source id does not match the confirmed usage consent');
      }
      return runMediaTask(input.generationId, (signal) => fetchSourceImage(
        { ...input, sourceId: consent.sourceId ?? input.sourceId, licenseConfirmed: true },
        {
          ...fetchOptions,
          signal,
          store: binaryStore,
          fetchImpl: options.imageFetchImpl,
          beforePersist: () => assertMediaTaskStillMutable(input.generationId)
        }
      ), fetchOptions.signal);
    },
    assertGenerationConversation: (generationId: string, conversationId: string) => {
      const generation = getArtifactGeneration(generationId);
      if (!generation || generation.conversationId !== conversationId) {
        throw new ArtifactNotFoundError('Artifact generation is not in the current research conversation');
      }
      return generation;
    },
    deleteGeneration: async (id: string) => {
      const generation = getArtifactGeneration(id);
      if (!generation) throw new ArtifactNotFoundError('Artifact generation not found');
      if (deletingGenerations.has(id)) throw new ArtifactStateError('Artifact generation deletion is already in progress');
      deletingGenerations.add(id);
      for (const [taskKey, controller] of activeControllers) {
        if (taskKey.startsWith(`${id}:`)) controller.abort(new Error('Artifact generation deleted'));
      }
      try {
        await waitForGenerationTasks(id);
        const references = deduplicateReferences(listArtifactBinaryReferencesForGeneration(id));
        const backups: Array<{ key: string; buffer: Buffer }> = [];
        try {
          for (const reference of references) {
            const buffer = await binaryStore.get(reference.key);
            if (buffer) {
              backups.push({ key: reference.key, buffer });
              await binaryStore.delete(reference.key);
            }
          }
          return deleteArtifactRecordsForGeneration(id);
        } catch (error) {
          for (const backup of backups) {
            try { await binaryStore.put(backup.key, backup.buffer); } catch { /* preserve original failure */ }
          }
          throw error;
        }
      } finally {
        deletingGenerations.delete(id);
      }
    },
    getOutput: (id: string) => getArtifactOutput(id),
    readOutput,
    getOutputGeneration: (id: string) => {
      const output = getArtifactOutput(id);
      return output ? getArtifactGeneration(output.generationId) : undefined;
    }
  };
}

function deduplicateReferences(references: Array<{ storageKey: string; previewKey?: string }>) {
  const keys = new Set<string>();
  for (const reference of references) {
    keys.add(reference.storageKey);
    if (reference.previewKey) keys.add(reference.previewKey);
  }
  return [...keys].map((key) => ({ key }));
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Artifact generation cancelled');
}

function getErrorMessage(error: unknown) {
  if (error instanceof RendererUnavailableError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : 'Artifact renderer failed';
}

function isRendererUnavailable(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'renderer_unavailable');
}

async function loadRenderAssets(generationId: string, store: ArtifactBinaryStore): Promise<ArtifactRenderAsset[]> {
  const assets: ArtifactRenderAsset[] = [];
  for (const asset of listArtifactAssets(generationId)) {
    if (!asset.licenseConfirmed) continue;
    // Asset provenance remains persisted even when the binary was removed or
    // a previous fetch was incomplete; such an asset is simply unavailable to
    // the renderer and must not block the complete text artifact.
    const data = await store.get(asset.storageKey);
    if (!data) continue;
    assets.push({
      id: asset.id,
      imageUrl: asset.imageUrl,
      ...(asset.originalPageUrl ? { originalPageUrl: asset.originalPageUrl } : {}),
      mimeType: asset.mimeType,
      data,
      licenseConfirmed: asset.licenseConfirmed
    });
  }
  return assets;
}

async function copyRehomedAssetBinaries(
  mediaCopies: Array<{ sourceStorageKey: string; targetStorageKey: string }>,
  store: ArtifactBinaryStore,
  signal: AbortSignal
) {
  const copied: string[] = [];
  try {
    for (const media of mediaCopies) {
      throwIfAborted(signal);
      const data = await store.get(media.sourceStorageKey);
      // Metadata is intentionally retained when a previous fetch lost its
      // binary. Render resolution will skip that record and use its fallback.
      if (!data) continue;
      await store.put(media.targetStorageKey, data);
      copied.push(media.targetStorageKey);
    }
  } catch (error) {
    await Promise.all(copied.map(async (key) => {
      try { await store.delete(key); } catch { /* preserve the original copy error */ }
    }));
    throw error;
  }
}

async function resolveRenderAssets(
  generationId: string,
  store: ArtifactBinaryStore
) {
  const assets = await loadRenderAssets(generationId, store);
  if (assets.length) {
    return {
      assets,
      provenance: [{
        kind: 'authorized_source_asset' as const,
        assetIds: assets.map((asset) => asset.id),
        sourceUrls: assets.map((asset) => asset.imageUrl)
      }]
    };
  }

  return {
    assets,
    provenance: [{
      kind: 'builtin_vector_shape' as const,
      detail: 'No authorized source asset was available'
    }]
  };
}

function mergeProvenance(...values: Array<ArtifactVisualProvenance[] | undefined>) {
  const merged: ArtifactVisualProvenance[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const item of value ?? []) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function mergeFormatLocalRepair(base: ArtifactSpec, repaired: ArtifactSpec, format: ArtifactFormat): ArtifactSpec {
  const repairedPresentation = format === 'pptx'
    ? { ...repaired.presentation, targetSlideCount: repaired.presentation.slides.length }
    : base.presentation;
  const repairedPdf = format === 'pdf'
    ? { ...repaired.pdf, targetPageCount: repaired.pdf.sections.length + 2 }
    : base.pdf;
  return normalizeArtifactSpecTargets({
    ...base,
    // Keep the frozen shared brief and user-facing choices byte-for-byte
    // stable. A repair may only change the plan/layout for its own format.
    title: base.title,
    audience: base.audience,
    theme: base.theme,
    branding: base.branding,
    brief: base.brief,
    presentation: repairedPresentation,
    pdf: repairedPdf
  });
}

function normalizeArtifactSpecTargets(spec: ArtifactSpec): ArtifactSpec {
  const slideCount = spec.presentation.slides.length;
  if (slideCount < 8 || slideCount > 15) {
    throw new ArtifactStateError(`Presentation plan contains ${slideCount} slides; keep 8-15 substantive slides`);
  }
  const pageCount = spec.pdf.sections.length + 2;
  if (pageCount < 6 || pageCount > 20) {
    throw new ArtifactStateError(`PDF plan resolves to ${pageCount} pages; keep 6-20 substantive pages`);
  }
  return {
    ...spec,
    presentation: { ...spec.presentation, targetSlideCount: slideCount },
    pdf: { ...spec.pdf, targetPageCount: pageCount }
  };
}

function digestArtifactSpec(spec: ArtifactSpec) {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

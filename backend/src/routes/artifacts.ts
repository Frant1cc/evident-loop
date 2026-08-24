import { Router, type Response } from 'express';

import { artifactStore, type ArtifactStore } from '../artifacts/store.js';
import type { ArtifactApplication } from '../modules/artifacts/index.js';
import { failure } from '../response.js';

type ArtifactReader = Pick<ArtifactStore, 'get'>;

export function createArtifactsRouter(
  store: ArtifactReader = artifactStore,
  generation?: ArtifactApplication
) {
  const router = Router();

  router.get('/artifacts/:artifactId/download', async (req, res) => {
    await sendArtifact(store, req.params.artifactId, res, 'attachment');
  });

  router.get('/artifacts/:artifactId/preview', async (req, res) => {
    await sendArtifact(store, req.params.artifactId, res, 'inline');
  });

  if (generation) registerGenerationRoutes(router, generation);

  return router;
}

export const artifactsRouter = createArtifactsRouter();

async function sendArtifact(
  store: ArtifactReader,
  artifactId: string,
  res: Response,
  disposition: 'attachment' | 'inline'
) {
  const artifact = await store.get(artifactId);
  if (!artifact) {
    res.status(404).json(failure('Document artifact not found or expired'));
    return;
  }

  res.setHeader('Content-Type', artifact.contentType);
  res.setHeader('Content-Length', String(artifact.size));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', createContentDisposition(artifact.fileName, disposition));
  res.sendFile(artifact.filePath, (error) => {
    if (!error) return;
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const action = disposition === 'inline' ? 'preview' : 'download';
    res.status(500).json(failure(`Failed to ${action} document artifact`));
  });
}

function registerGenerationRoutes(router: Router, generation: ArtifactApplication) {
  router.post('/research/conversations/:conversationId/artifacts/drafts', async (req, res) => {
    if (!isOpaqueId(req.params.conversationId)) {
      res.status(404).json(failure('Research conversation not found'));
      return;
    }
    try {
      const draft = await generation.createDraft(req.params.conversationId, req.body);
      res.status(201).json({ code: 1, message: 'Artifact draft created', data: { generation: draft } });
    } catch (error) {
      respondArtifactError(res, error);
    }
  });

  router.get('/research/conversations/:conversationId/artifacts', (req, res) => {
    if (!isOpaqueId(req.params.conversationId)) {
      res.status(404).json(failure('Research conversation not found'));
      return;
    }
    try {
      res.json({ code: 1, message: 'success', data: { generations: generation.listGenerations(req.params.conversationId) } });
    } catch (error) {
      respondArtifactError(res, error);
    }
  });

  router.get('/research/conversations/:conversationId/artifact-requests', (req, res) => {
    if (!isOpaqueId(req.params.conversationId)) {
      res.status(404).json(failure('Research conversation not found'));
      return;
    }
    try {
      res.json({
        code: 1,
        message: 'success',
        data: { requests: generation.listDraftRequests(req.params.conversationId) }
      });
    } catch (error) {
      respondArtifactError(res, error);
    }
  });

  router.get('/artifacts/generations/:generationId', (req, res) => {
    if (!isOpaqueId(req.params.generationId)) {
      res.status(404).json(failure('Artifact generation not found'));
      return;
    }
    const item = generation.getGeneration(req.params.generationId);
    if (!item) {
      res.status(404).json(failure('Artifact generation not found'));
      return;
    }
    res.json({ code: 1, message: 'success', data: { generation: item } });
  });

  router.patch('/artifacts/generations/:generationId', (req, res) => {
    if (!isOpaqueId(req.params.generationId)) {
      res.status(404).json(failure('Artifact draft not found'));
      return;
    }
    try {
      const item = generation.updateDraft(req.params.generationId, req.body?.spec ?? req.body);
      if (!item) {
        res.status(404).json(failure('Artifact draft not found'));
        return;
      }
      res.json({ code: 1, message: 'Artifact draft updated', data: { generation: item } });
    } catch (error) {
      respondArtifactError(res, error);
    }
  });

  router.post('/artifacts/generations/:generationId/render', (req, res) => {
    if (!isOpaqueId(req.params.generationId)) {
      res.status(404).json(failure('Artifact generation not found'));
      return;
    }
    try {
      const item = generation.startRender(req.params.generationId);
      res.status(202).json({ code: 1, message: 'Artifact rendering started', data: { generation: item } });
    } catch (error) {
      respondArtifactError(res, error);
    }
  });

  router.post('/artifacts/generations/:generationId/image-consents', (req, res) => {
    if (!isOpaqueId(req.params.generationId)) {
      res.status(404).json(failure('Artifact generation not found'));
      return;
    }
    try {
      const imageUrl = String(req.body?.imageUrl ?? '').trim();
      const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId : undefined;
      const consent = generation.confirmImageUse(req.params.generationId, imageUrl, sourceId);
      res.status(201).json({ code: 1, message: 'Image usage confirmed', data: { consent } });
    } catch (error) {
      respondArtifactError(res, error, 400);
    }
  });

  router.post('/artifacts/generations/:generationId/images/source', async (req, res) => {
    if (!isOpaqueId(req.params.generationId)) {
      res.status(404).json(failure('Artifact generation not found'));
      return;
    }
    try {
      const imageUrl = String(req.body?.imageUrl ?? '').trim();
      const consentId = String(req.body?.consentId ?? '').trim();
      const originalPageUrl = typeof req.body?.originalPageUrl === 'string' ? req.body.originalPageUrl.trim() : undefined;
      const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : undefined;
      const asset = await generation.fetchSourceImage({
        generationId: req.params.generationId,
        imageUrl,
        consentId,
        ...(originalPageUrl ? { originalPageUrl } : {}),
        ...(sourceId ? { sourceId } : {})
      });
      res.status(201).json({ code: 1, message: 'Authorized source image stored', data: { asset } });
    } catch (error) {
      respondArtifactError(res, error, 400);
    }
  });

  router.delete('/artifacts/generations/:generationId', async (req, res) => {
    if (!isOpaqueId(req.params.generationId)) {
      res.status(404).json(failure('Artifact generation not found'));
      return;
    }
    try {
      const deleted = await generation.deleteGeneration(req.params.generationId);
      if (!deleted) {
        res.status(404).json(failure('Artifact generation not found'));
        return;
      }
      res.json({ code: 1, message: 'Artifact generation deleted', data: { deleted: true } });
    } catch (error) {
      respondArtifactError(res, error);
    }
  });

  router.post('/artifacts/generations/:generationId/cancel', (req, res) => {
    if (!isOpaqueId(req.params.generationId)) {
      res.status(404).json(failure('Artifact generation not found'));
      return;
    }
    try {
      const item = generation.cancelRender(req.params.generationId);
      res.json({ code: 1, message: 'Artifact rendering cancelled', data: { generation: item } });
    } catch (error) {
      respondArtifactError(res, error);
    }
  });

  router.post('/artifacts/outputs/:outputId/retry', (req, res) => {
    if (!isOpaqueId(req.params.outputId)) {
      res.status(404).json(failure('Artifact output not found'));
      return;
    }
    try {
      const item = generation.retryOutput(req.params.outputId);
      res.status(202).json({ code: 1, message: 'Artifact output retry started', data: { generation: item } });
    } catch (error) {
      respondArtifactError(res, error);
    }
  });

  router.get('/artifact-files/:outputId/:action', async (req, res) => {
    if (!isOpaqueId(req.params.outputId)) {
      res.status(404).json(failure('Artifact file not found'));
      return;
    }
    const action = req.params.action;
    if (action !== 'download' && action !== 'preview') {
      res.status(404).json(failure('Artifact file not found'));
      return;
    }
    const output = generation.getOutput(req.params.outputId);
    if (!output || output.status !== 'completed') {
      res.status(404).json(failure('Artifact output not found or not ready'));
      return;
    }
    const payload = await generation.readOutput(req.params.outputId, action === 'preview');
    if (!payload) {
      res.status(404).json(failure('Artifact binary not found'));
      return;
    }
    const previewContentType = action === 'preview' && output.format === 'pptx'
      ? 'image/png'
      : action === 'preview' && output.format === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : output.contentType ?? 'application/octet-stream';
    res.setHeader('Content-Type', previewContentType);
    res.setHeader('Content-Length', String(payload.buffer.byteLength));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', createContentDisposition(output.fileName ?? `research.${output.format}`, action === 'download' ? 'attachment' : 'inline'));
    res.send(payload.buffer);
  });

}

function respondArtifactError(res: Response, error: unknown, defaultStatus = 400) {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const status = code === 'artifact_not_found' ? 404 : code === 'artifact_snapshot_stale' ? 409 : defaultStatus;
  res.status(status).json(failure(error instanceof Error ? error.message : 'Artifact request failed'));
}

function isOpaqueId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createContentDisposition(fileName: string, disposition: 'attachment' | 'inline') {
  const asciiFallback =
    fileName
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_')
      .slice(0, 150) || 'document.docx';
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

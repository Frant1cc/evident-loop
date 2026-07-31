import { Router, type Response } from 'express';

import { artifactStore, type ArtifactStore } from '../artifacts/store.js';
import { failure } from '../response.js';

type ArtifactReader = Pick<ArtifactStore, 'get'>;

export function createArtifactsRouter(store: ArtifactReader = artifactStore) {
  const router = Router();

  router.get('/artifacts/:artifactId/download', async (req, res) => {
    await sendArtifact(store, req.params.artifactId, res, 'attachment');
  });

  router.get('/artifacts/:artifactId/preview', async (req, res) => {
    await sendArtifact(store, req.params.artifactId, res, 'inline');
  });

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

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactBinaryStore } from './types.js';

const safeSegment = /^[A-Za-z0-9._-]+$/;

/** Local Docker-volume implementation. The interface is deliberately S3-shaped. */
export class LocalArtifactBinaryStore implements ArtifactBinaryStore {
  private readonly root: string;

  constructor(root = process.env.ARTIFACT_BINARY_DIR ?? path.join(process.cwd(), 'data', 'artifact-binaries')) {
    this.root = path.resolve(root);
  }

  async put(key: string, buffer: Buffer) {
    const filePath = this.resolveKey(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, buffer, { flag: 'wx' });
      const { rename } = await import('node:fs/promises');
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async get(key: string) {
    try {
      return await readFile(this.resolveKey(key));
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await rm(this.resolveKey(key), { force: true });
  }

  private resolveKey(key: string) {
    const segments = key.split('/');
    if (!segments.length || segments.some((segment) => !segment || !safeSegment.test(segment))) {
      throw new Error('Invalid artifact binary storage key');
    }
    const resolved = path.resolve(this.root, ...segments);
    const relative = path.relative(this.root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Artifact binary storage key escapes its root');
    }
    return resolved;
  }
}

export const artifactBinaryStore = new LocalArtifactBinaryStore();

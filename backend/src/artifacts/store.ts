import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';

export type ArtifactMetadata = {
  artifactId: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
  expiresAt: string;
};

export type StoredArtifact = ArtifactMetadata & {
  filePath: string;
};

type ArtifactStoreOptions = {
  directory?: string;
  ttlMs?: number;
};

const artifactIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const defaultTtlMs = 24 * 60 * 60 * 1_000;

export class ArtifactStore {
  private readonly directory: string;
  private readonly ttlMs: number;

  constructor(options: ArtifactStoreOptions = {}) {
    this.directory = path.resolve(
      options.directory ??
        process.env.ARTIFACTS_DIR ??
        path.join(process.cwd(), 'data', 'artifacts')
    );
    this.ttlMs = options.ttlMs ?? getConfiguredTtlMs();
  }

  async create(buffer: Buffer, requestedFileName: string): Promise<StoredArtifact> {
    await mkdir(this.directory, { recursive: true });

    const artifactId = randomUUID();
    const fileName = sanitizeDocxFileName(requestedFileName);
    const now = new Date();
    const metadata: ArtifactMetadata = {
      artifactId,
      fileName,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: buffer.byteLength,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString()
    };
    const filePath = this.getFilePath(artifactId);
    const metadataPath = this.getMetadataPath(artifactId);
    const fileTempPath = `${filePath}.tmp`;
    const metadataTempPath = `${metadataPath}.tmp`;

    try {
      await writeFile(fileTempPath, buffer, { flag: 'wx' });
      await writeFile(metadataTempPath, JSON.stringify(metadata), {
        encoding: 'utf8',
        flag: 'wx'
      });
      await rename(fileTempPath, filePath);
      await rename(metadataTempPath, metadataPath);
    } catch (error) {
      await Promise.all([
        rm(fileTempPath, { force: true }),
        rm(metadataTempPath, { force: true }),
        rm(filePath, { force: true }),
        rm(metadataPath, { force: true })
      ]);
      throw error;
    }

    return { ...metadata, filePath };
  }

  async get(artifactId: string): Promise<StoredArtifact | null> {
    if (!artifactIdPattern.test(artifactId)) return null;

    try {
      const metadata = JSON.parse(
        await readFile(this.getMetadataPath(artifactId), 'utf8')
      ) as ArtifactMetadata;
      if (metadata.artifactId !== artifactId) return null;
      if (Date.parse(metadata.expiresAt) <= Date.now()) {
        await this.delete(artifactId);
        return null;
      }

      const filePath = this.getFilePath(artifactId);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return null;

      return {
        ...metadata,
        size: fileStat.size,
        filePath
      };
    } catch {
      return null;
    }
  }

  async delete(artifactId: string) {
    if (!artifactIdPattern.test(artifactId)) return;
    await Promise.all([
      rm(this.getFilePath(artifactId), { force: true }),
      rm(this.getMetadataPath(artifactId), { force: true })
    ]);
  }

  async cleanupExpired() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    let deleted = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const artifactId = entry.name.slice(0, -'.json'.length);
      if (!artifactIdPattern.test(artifactId)) continue;

      try {
        const metadata = JSON.parse(
          await readFile(this.getMetadataPath(artifactId), 'utf8')
        ) as ArtifactMetadata;
        if (Date.parse(metadata.expiresAt) > Date.now()) continue;
        await this.delete(artifactId);
        deleted += 1;
      } catch {
        await this.delete(artifactId);
        deleted += 1;
      }
    }

    return deleted;
  }

  private getFilePath(artifactId: string) {
    return path.join(this.directory, `${artifactId}.docx`);
  }

  private getMetadataPath(artifactId: string) {
    return path.join(this.directory, `${artifactId}.json`);
  }
}

export const artifactStore = new ArtifactStore();

export function startArtifactCleanup() {
  const interval = setInterval(() => {
    artifactStore.cleanupExpired().catch((error) => {
      console.error('Artifact cleanup failed', error);
    });
  }, 60 * 60 * 1_000);
  interval.unref();
  return interval;
}

export function sanitizeDocxFileName(requestedFileName: string) {
  const normalized = requestedFileName
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150);
  const baseName = normalized.replace(/(?:\.docx)+$/gi, '').trim() || 'document';
  return `${baseName}.docx`;
}

function getConfiguredTtlMs() {
  const hours = Number(process.env.ARTIFACT_TTL_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) return defaultTtlMs;
  return Math.min(hours, 24 * 30) * 60 * 60 * 1_000;
}

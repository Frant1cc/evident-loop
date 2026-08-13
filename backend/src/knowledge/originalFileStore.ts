import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getKnowledgeFilesDir } from './config.js';
import type { OriginalFileStore } from './types.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultFilesDir = resolve(currentDir, '../../data/knowledge-files');

export function createOriginalFileStore(directory = getKnowledgeFilesDir() ?? defaultFilesDir): OriginalFileStore {
  const root = resolve(directory);

  return {
    async save({ bytes, extension }) {
      await mkdir(root, { recursive: true });
      const normalizedExtension = normalizeExtension(extension);
      const storageKey = `${randomUUID()}${normalizedExtension}`;
      const target = storagePath(root, storageKey);
      const tempPath = `${target}.${randomUUID()}.tmp`;

      try {
        await writeFile(tempPath, bytes);
        await rename(tempPath, target);
        return storageKey;
      } catch (error) {
        await rm(tempPath, { force: true });
        throw error;
      }
    },

    async read(storageKey) {
      return readFile(storagePath(root, storageKey));
    },

    async delete(storageKey) {
      await rm(storagePath(root, storageKey), { force: true });
    }
  };
}

export const originalFileStore = createOriginalFileStore();

export function hashBuffer(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeExtension(extension: string) {
  const value = extension.trim().toLowerCase();
  if (!value) return '';
  return value.startsWith('.') ? value : `.${value}`;
}

function storagePath(root: string, storageKey: string) {
  if (!storageKey || storageKey.includes('\0') || storageKey.includes('..') || storageKey.includes('/') || storageKey.includes('\\') || isAbsolute(storageKey)) {
    throw new Error('Invalid storage key');
  }

  if (!extname(storageKey)) {
    throw new Error('Invalid storage key');
  }

  const resolved = join(root, storageKey);
  if (!resolved.startsWith(root)) {
    throw new Error('Invalid storage key');
  }

  return resolved;
}

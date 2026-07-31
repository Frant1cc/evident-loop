import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RagDocument } from '../types.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const repositoryKnowledgeDirectory = resolve(projectRoot, 'docs/knowledge');

export async function loadRepositoryEvaluationCorpus(): Promise<RagDocument[]> {
  const files = (await readdir(repositoryKnowledgeDirectory))
    .filter((file) => extname(file).toLowerCase() === '.md')
    .sort();

  return Promise.all(files.map(async (file) => {
    const content = await readFile(resolve(repositoryKnowledgeDirectory, file), 'utf8');
    const lines = content.split(/\r?\n/);
    const titleLine = lines.find((line) => line.startsWith('# '));
    return {
      file,
      title: titleLine?.replace(/^#\s+/, '').trim() || basename(file, extname(file)),
      content,
      lineCount: lines.length
    };
  }));
}

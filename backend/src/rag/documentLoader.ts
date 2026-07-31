import type { RagDocument } from './types.js';
import { listKnowledgeDocuments } from './knowledgeFiles.js';

export function loadMarkdownDocuments(): RagDocument[] {
  return listKnowledgeDocuments();
}

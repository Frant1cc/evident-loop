import { listKnowledgeDocuments, readKnowledgeDocument } from '../rag/knowledgeFiles.js';

type SearchDocsArgs = {
  query?: unknown;
  limit?: unknown;
};

type ReadDocumentArgs = {
  file?: unknown;
  maxChars?: unknown;
};

type SearchResult = {
  file: string;
  line: number;
  preview: string;
};

const maxDocumentChars = 12000;

export function searchDocs(args: unknown) {
  const { query, limit } = parseSearchDocsArgs(args);
  const results: SearchResult[] = [];
  const normalizedQuery = query.toLowerCase();

  for (const document of listKnowledgeDocuments()) {
    const lines = document.content.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(normalizedQuery)) continue;

      results.push({
        file: document.file,
        line: index + 1,
        preview: line.trim().slice(0, 240)
      });

      if (results.length >= limit) {
        return { query, results };
      }
    }
  }

  return { query, results };
}

export function readDocument(args: unknown) {
  const { file, maxChars } = parseReadDocumentArgs(args);
  const document = readKnowledgeDocument(file);
  const truncated = document.content.length > maxChars;

  return {
    file: document.file,
    content: document.content.slice(0, maxChars),
    truncated,
    totalChars: document.content.length
  };
}

function parseSearchDocsArgs(args: unknown) {
  if (!args || typeof args !== 'object') {
    throw new Error('search_docs requires a query string');
  }

  const { query, limit } = args as SearchDocsArgs;

  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('search_docs requires a query string');
  }

  return {
    query: query.trim(),
    limit: typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 5
  };
}

function parseReadDocumentArgs(args: unknown) {
  if (!args || typeof args !== 'object') {
    throw new Error('read_document requires a file string');
  }

  const { file, maxChars } = args as ReadDocumentArgs;

  if (typeof file !== 'string' || !file.trim()) {
    throw new Error('read_document requires a file string');
  }

  return {
    file: file.trim(),
    maxChars: typeof maxChars === 'number' && Number.isInteger(maxChars) && maxChars > 0 ? Math.min(maxChars, maxDocumentChars) : maxDocumentChars
  };
}

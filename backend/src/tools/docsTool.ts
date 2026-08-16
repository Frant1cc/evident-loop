import { readKnowledgeDocument } from '../rag/knowledgeFiles.js';

type ReadDocumentArgs = {
  file?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  maxChars?: unknown;
};

const maxDocumentChars = 12000;

export function readDocument(args: unknown) {
  const { file, startLine, endLine, maxChars } = parseReadDocumentArgs(args);
  const document = readKnowledgeDocument(file);
  const lines = document.content.split(/\r?\n/);
  if (startLine > lines.length) throw new Error(`read_document startLine exceeds document length (${lines.length})`);

  const requestedEndLine = Math.min(endLine ?? lines.length, lines.length);
  const requestedContent = lines.slice(startLine - 1, requestedEndLine).join('\n');
  const content = requestedContent.slice(0, maxChars);
  const truncated = content.length < requestedContent.length;
  const includedLineCount = content ? content.split('\n').length : 0;
  const actualEndLine = includedLineCount ? startLine + includedLineCount - 1 : startLine;

  return {
    file: document.file,
    content,
    startLine,
    endLine: actualEndLine,
    totalLines: lines.length,
    truncated,
    ...(truncated ? { nextStartLine: actualEndLine + 1 } : {}),
    // Kept for historical consumers of read_document results.
    totalChars: document.content.length
  };
}

function parseReadDocumentArgs(args: unknown) {
  if (!args || typeof args !== 'object') {
    throw new Error('read_document requires a file string');
  }

  const { file, startLine, endLine, maxChars } = args as ReadDocumentArgs;

  if (typeof file !== 'string' || !file.trim()) {
    throw new Error('read_document requires a file string');
  }

  const parsedStartLine = parseOptionalLine(startLine, 'startLine') ?? 1;
  const parsedEndLine = parseOptionalLine(endLine, 'endLine');
  if (parsedEndLine !== undefined && parsedEndLine < parsedStartLine) {
    throw new Error('read_document endLine must be greater than or equal to startLine');
  }

  return {
    file: file.trim(),
    startLine: parsedStartLine,
    endLine: parsedEndLine,
    maxChars: typeof maxChars === 'number' && Number.isInteger(maxChars) && maxChars > 0 ? Math.min(maxChars, maxDocumentChars) : maxDocumentChars
  };
}

function parseOptionalLine(value: unknown, name: 'startLine' | 'endLine') {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`read_document ${name} must be a positive integer`);
  }
  return value;
}

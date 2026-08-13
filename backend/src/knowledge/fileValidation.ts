import { basename, extname } from 'node:path';

import { getKnowledgeMaxUploadBytes } from './config.js';
import {
  fileTooLargeError,
  KnowledgeImportError,
  unsupportedFormatError
} from './errors.js';
import type { KnowledgeFormat, KnowledgeUpload } from './types.js';
import { inspectZip } from './zipInspect.js';

const formatByExtension: Record<string, KnowledgeFormat> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.docx': 'docx',
  '.pdf': 'pdf'
};

const pdfMagic = Buffer.from('%PDF-');
const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function sanitizeOriginalName(originalName: string) {
  const name = basename(originalName.replace(/\\/g, '/')).replace(/[\0-\x1f\x7f]/g, '').trim();
  if (!name || name === '.' || name === '..' || name.includes('..')) {
    throw new KnowledgeImportError('文件名不合法。', 400);
  }
  return name;
}

export function sanitizeKnowledgePath(value: string, format: KnowledgeFormat) {
  const cleaned = value.replace(/\\/g, '/').replace(/[\0-\x1f\x7f]/g, '').trim();
  if (!cleaned || cleaned.startsWith('/') || cleaned.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new KnowledgeImportError('Document path must be a relative knowledge path', 400);
  }

  const expected = `.${format === 'md' ? 'md' : format}`;
  const extension = extname(cleaned).toLowerCase();
  if (format === 'md') {
    if (extension !== '.md' && extension !== '.markdown') {
      throw new KnowledgeImportError('Only Markdown (.md) documents are supported', 400);
    }
  } else if (extension !== expected) {
    throw new KnowledgeImportError(`Document path must end with ${expected}`, 400);
  }

  return cleaned;
}

export function detectKnowledgeFormat(input: KnowledgeUpload): KnowledgeFormat {
  const originalName = sanitizeOriginalName(input.originalName);
  const extension = extname(originalName).toLowerCase();
  const format = formatByExtension[extension];
  if (!format) throw unsupportedFormatError();

  if (input.size > getKnowledgeMaxUploadBytes() || input.buffer.length > getKnowledgeMaxUploadBytes()) {
    throw fileTooLargeError(getKnowledgeMaxUploadBytes());
  }

  const magic = detectMagic(input.buffer);
  if (format === 'pdf') {
    if (magic !== 'pdf') throw unsupportedFormatError();
    return 'pdf';
  }
  if (format === 'docx') {
    if (magic !== 'zip') throw unsupportedFormatError();
    assertSafeDocxArchive(input.buffer);
    return 'docx';
  }
  if (magic === 'pdf' || magic === 'zip' || magic === 'binary') {
    throw unsupportedFormatError();
  }
  return format;
}

export function pathFromOriginalName(originalName: string, format: KnowledgeFormat) {
  const safeName = sanitizeOriginalName(originalName);
  const base = safeName.replace(/\.[^.]+$/u, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'document';
  return `${base}.${format === 'md' ? 'md' : format}`;
}

function detectMagic(buffer: Buffer) {
  if (buffer.length >= 5 && buffer.subarray(0, 5).equals(pdfMagic)) return 'pdf';
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(zipMagic)) return 'zip';
  if (buffer.includes(0)) return 'binary';
  return 'text';
}

function assertSafeDocxArchive(buffer: Buffer) {
  let inspection;
  try {
    inspection = inspectZip(buffer);
  } catch {
    throw new KnowledgeImportError('无法读取 Word 文件，请确认文件未损坏。', 422);
  }

  const names = new Set(inspection.entries.map((entry) => entry.name));
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
    throw new KnowledgeImportError('无法读取 Word 文件，请确认文件未损坏。', 422);
  }

  if (inspection.entries.length > 10_000) {
    throw new KnowledgeImportError('Word 文件结构异常，已拒绝导入。', 422);
  }

  if (inspection.uncompressedTotal > 80_000_000) {
    throw new KnowledgeImportError('Word 文件解压后过大，已拒绝导入。', 413);
  }

  if (inspection.compressedTotal > 0 && inspection.uncompressedTotal / inspection.compressedTotal > 200) {
    throw new KnowledgeImportError('Word 文件压缩比异常，已拒绝导入。', 422);
  }
}

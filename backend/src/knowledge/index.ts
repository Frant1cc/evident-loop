import { getKnowledgeMaxExtractedBytes, getKnowledgeMaxUploadBytes } from './config.js';
import { KnowledgeImportError } from './errors.js';
import { decodeMultipartFilename, detectKnowledgeFormat, sanitizeOriginalName } from './fileValidation.js';
import { resolveParser } from './parserRegistry.js';
import type { KnowledgeUpload } from './types.js';

const maxConversationAttachmentChars = 80_000;

/** Parse a conversation attachment without adding it to the shared knowledge base. */
export async function parseConversationAttachment(upload: KnowledgeUpload) {
  const name = sanitizeOriginalName(upload.originalName);
  const input = { ...upload, originalName: name };
  const format = detectKnowledgeFormat(input);
  const parsed = await resolveParser(input).parse(input);
  if (Buffer.byteLength(parsed.content, 'utf8') > getKnowledgeMaxExtractedBytes()
    || parsed.content.length > maxConversationAttachmentChars) {
    throw new KnowledgeImportError('文档内容过长，当前对话附件最多支持 8 万字符。请拆分文档后重试。', 413);
  }
  return { name, format, size: upload.size, content: parsed.content };
}

export { decodeMultipartFilename, getKnowledgeMaxUploadBytes, KnowledgeImportError };
export type { KnowledgeUpload };

import { artifactStore } from '../artifacts/store.js';
import { resolveDocumentSpec } from '../documents/presets.js';
import { renderWordDocument } from '../documents/renderer.js';
import { parseDocumentSpec } from '../documents/schema.js';
import type { ToolContext } from './registry.js';

export async function generateWordDocument(args: unknown, context?: ToolContext) {
  throwIfAborted(context?.signal);
  const input = parseDocumentSpec(args);
  const spec = resolveDocumentSpec(input);
  const buffer = await renderWordDocument(spec);
  throwIfAborted(context?.signal);
  const artifact = await artifactStore.create(buffer, spec.fileName);
  if (context?.signal?.aborted) {
    await artifactStore.delete(artifact.artifactId);
    throwIfAborted(context.signal);
  }

  return {
    artifactId: artifact.artifactId,
    fileName: artifact.fileName,
    preset: spec.format.name,
    downloadUrl: `/api/artifacts/${artifact.artifactId}/download`,
    previewUrl: `/api/artifacts/${artifact.artifactId}/preview`,
    size: artifact.size,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt
  };
}

export function isExplicitWordDocumentRequest(message: string) {
  const normalized = message.toLowerCase();
  const mentionsWord = /\bdocx\b|\bword\b|微软\s*word/.test(normalized);
  const requestsArtifact =
    /(生成|创建|制作|导出|下载|保存|整理成|转成|输出|提供)/.test(normalized) ||
    /\b(generate|create|export|download|save|produce|make|convert)\b/.test(normalized);
  return mentionsWord && requestsArtifact;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Document generation was cancelled');
  }
}

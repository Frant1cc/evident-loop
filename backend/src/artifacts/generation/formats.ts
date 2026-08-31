import type { ArtifactFormat, ResearchSnapshot } from './types.js';

export const ARTIFACT_FORMATS = ['pptx', 'docx', 'pdf'] as const;

const PPTX_PATTERN = /\bpptx?\b|幻灯片|演示文稿|幻灯|powerpoint/i;
const DOCX_PATTERN = /\bdocx?\b|word|文档|长篇文档/i;
const PDF_PATTERN = /\bpdf\b|长篇报告/i;

export function normalizeArtifactFormats(value: unknown): ArtifactFormat[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const selected = new Set<ArtifactFormat>();
  for (const item of value) {
    if (item === 'pptx' || item === 'docx' || item === 'pdf') selected.add(item);
  }
  const formats = ARTIFACT_FORMATS.filter((format) => selected.has(format));
  return formats.length ? formats : undefined;
}

export function inferArtifactFormats(text: string): ArtifactFormat[] | undefined {
  const wantsPptx = PPTX_PATTERN.test(text);
  const wantsDocx = DOCX_PATTERN.test(text);
  const wantsPdf = PDF_PATTERN.test(text);
  const formats = ARTIFACT_FORMATS.filter((format) =>
    (format === 'pptx' ? wantsPptx : format === 'docx' ? wantsDocx : wantsPdf)
  );
  return formats.length ? formats : undefined;
}

export function lastUserTextFromSnapshot(snapshot: ResearchSnapshot) {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message?.role === 'user' && message.content.trim()) return message.content;
  }
  return '';
}

export function resolveArtifactFormats(input: {
  requested?: unknown;
  userText?: string;
}): ArtifactFormat[] {
  return normalizeArtifactFormats(input.requested)
    ?? (input.userText ? inferArtifactFormats(input.userText) : undefined)
    ?? [...ARTIFACT_FORMATS];
}

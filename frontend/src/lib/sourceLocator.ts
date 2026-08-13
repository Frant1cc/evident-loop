export type KnowledgeFormat = 'md' | 'txt' | 'docx' | 'pdf';

export type SourceLocator = {
  normalizedLineStart: number;
  normalizedLineEnd: number;
  originalLineStart?: number;
  originalLineEnd?: number;
  pageStart?: number;
  pageEnd?: number;
};

export function formatSourceLocator(
  locator?: SourceLocator,
  fallback?: { startLine: number; endLine: number }
) {
  if (locator?.pageStart) {
    return locator.pageEnd && locator.pageEnd !== locator.pageStart
      ? `第 ${locator.pageStart}–${locator.pageEnd} 页`
      : `第 ${locator.pageStart} 页`;
  }

  if (locator?.originalLineStart) {
    const end = locator.originalLineEnd ?? locator.originalLineStart;
    return end !== locator.originalLineStart
      ? `原文第 ${locator.originalLineStart}–${end} 行`
      : `原文第 ${locator.originalLineStart} 行`;
  }

  const start = locator?.normalizedLineStart ?? fallback?.startLine;
  const end = locator?.normalizedLineEnd ?? fallback?.endLine;
  if (!start) return '';
  if (!end || end === start) return `第 ${start} 行`;
  return `第 ${start}–${end} 行`;
}

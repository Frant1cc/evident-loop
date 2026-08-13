import type { SourceLocator } from './types.js';

export function mergeLocators(locators: Array<SourceLocator | undefined>): SourceLocator | undefined {
  const defined = locators.filter((locator): locator is SourceLocator => Boolean(locator));
  if (!defined.length) return undefined;

  return {
    normalizedLineStart: Math.min(...defined.map((locator) => locator.normalizedLineStart)),
    normalizedLineEnd: Math.max(...defined.map((locator) => locator.normalizedLineEnd)),
    ...optionalRange(defined, 'originalLineStart', 'originalLineEnd'),
    ...optionalRange(defined, 'pageStart', 'pageEnd')
  };
}

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

export function isPdfPageHeading(value: string) {
  return /^第\s*\d+(?:[–-]\d+)?\s*页$/u.test(value.trim());
}

export function parseLocator(value: unknown): SourceLocator | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const locator = value as Partial<SourceLocator>;
  if (typeof locator.normalizedLineStart !== 'number' || typeof locator.normalizedLineEnd !== 'number') {
    return undefined;
  }

  return {
    normalizedLineStart: locator.normalizedLineStart,
    normalizedLineEnd: locator.normalizedLineEnd,
    ...(typeof locator.originalLineStart === 'number' ? { originalLineStart: locator.originalLineStart } : {}),
    ...(typeof locator.originalLineEnd === 'number' ? { originalLineEnd: locator.originalLineEnd } : {}),
    ...(typeof locator.pageStart === 'number' ? { pageStart: locator.pageStart } : {}),
    ...(typeof locator.pageEnd === 'number' ? { pageEnd: locator.pageEnd } : {})
  };
}

function optionalRange(
  locators: SourceLocator[],
  startKey: 'originalLineStart' | 'pageStart',
  endKey: 'originalLineEnd' | 'pageEnd'
) {
  const starts = locators.map((locator) => locator[startKey]).filter((value): value is number => typeof value === 'number');
  const ends = locators.map((locator) => locator[endKey]).filter((value): value is number => typeof value === 'number');
  if (!starts.length && !ends.length) return {};
  const start = starts.length ? Math.min(...starts) : Math.min(...ends);
  const end = ends.length ? Math.max(...ends) : Math.max(...starts);
  return { [startKey]: start, [endKey]: end };
}

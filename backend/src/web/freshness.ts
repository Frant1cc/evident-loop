import type { FetchPageResult } from '../tools/fetchPageTool.js';
import type { WebSearchResult } from '../tools/webSearchTool.js';

export type FreshnessStatus = 'matched' | 'outside_window' | 'unknown' | 'future_date' | 'not_required';

export function resolveSourceFreshness(input: {
  candidate: WebSearchResult;
  page: FetchPageResult;
  timeRange?: 'day' | 'week' | 'month' | 'year';
  nowMs: number;
}) {
  const publishedAt = normalizeDate(input.candidate.publishedAt)
    ?? extractLabeledPublicationDate(`${input.page.title}\n${input.page.content.slice(0, 2_500)}`);
  if (!input.timeRange) return { status: 'not_required' as const, publishedAt };
  if (!publishedAt) return { status: 'unknown' as const };

  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) return { status: 'unknown' as const };
  if (publishedMs > input.nowMs + 36 * 60 * 60 * 1_000) {
    return { status: 'future_date' as const, publishedAt };
  }
  const cutoff = freshnessCutoff(input.timeRange, input.nowMs);
  return {
    status: publishedMs >= cutoff ? 'matched' as const : 'outside_window' as const,
    publishedAt
  };
}

export function freshnessCutoff(timeRange: 'day' | 'week' | 'month' | 'year', nowMs: number) {
  const date = new Date(nowMs);
  if (timeRange === 'day') return nowMs - 24 * 60 * 60 * 1_000;
  if (timeRange === 'week') return nowMs - 7 * 24 * 60 * 60 * 1_000;
  if (timeRange === 'month') {
    date.setUTCMonth(date.getUTCMonth() - 1);
    return date.getTime();
  }
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.getTime();
}

function extractLabeledPublicationDate(raw: string) {
  const value = raw.replace(/\\([\-/.])/g, '$1');
  const datePattern = '(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{4}年\\d{1,2}月\\d{1,2}日|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{4})';
  const match = value.match(new RegExp(`(?:published|posted|updated|last updated|publication date|发布日期|发布于|更新于)\\s*[:：-]?\\s*(${datePattern})`, 'i'));
  return normalizeDate(match?.[1]);
}

function normalizeDate(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const normalized = value.trim()
    .replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, '$1-$2-$3');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

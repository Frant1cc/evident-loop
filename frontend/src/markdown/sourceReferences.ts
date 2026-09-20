import { Marked, type Token } from 'marked';

export type MarkdownSource = {
  citationKey: string;
  file: string;
  title: string;
  heading?: string;
  content: string;
};

const linkLexer = new Marked({ gfm: true, breaks: true });

export function buildSourceLinkNumberMap(content: string, sources: MarkdownSource[]) {
  const numbers = new Map<string, number>();
  let nextNumber = sources.reduce(
    (maximum, source, index) => Math.max(maximum, sourceNumber(source.citationKey, index)),
    0
  ) + 1;

  sources.forEach((source, index) => {
    numbers.set(normalizeSourceHref(source.file), sourceNumber(source.citationKey, index));
  });

  const tokens = linkLexer.lexer(content);
  linkLexer.walkTokens(tokens, (token: Token) => {
    if (token.type !== 'link' || !isSourceLinkLabel(plainLinkLabel(token.text))) return;
    const href = normalizeSourceHref(token.href);
    if (!numbers.has(href)) numbers.set(href, nextNumber++);
  });

  return numbers;
}

export function isSourceLinkLabel(value: string) {
  return /^(?:来源|参考来源|网页来源|source|sources|reference|references|official source|support|contradiction)(?:\s*\d+)?$/iu.test(value);
}

export function plainLinkLabel(value: string) {
  return value.replace(/<[^>]*>/gu, '').replace(/[*_~`]/gu, '').trim();
}

export function sourceNumber(key: string, fallbackIndex: number) {
  const match = /^S(\d+)$/iu.exec(key.trim());
  return match ? Number(match[1]) : Math.max(0, fallbackIndex) + 1;
}

export function normalizeSourceHref(value: string) {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/u, '');
    return url.toString();
  } catch {
    return trimmed.replace(/\/+$/u, '');
  }
}

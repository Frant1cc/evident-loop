export type PresentationHtmlTextTarget =
  | { type: 'title' }
  | { type: 'bullet'; index: number; duplicateOccurrence?: number };

export type PresentationHtmlPatchResult = {
  html: string;
  replaced: boolean;
};

/**
 * Updates editable copy inside authored slide HTML without rebuilding its
 * element tree. Keeping the existing nodes, classes, and inline geometry is
 * what prevents a text edit from silently replacing the designed layout.
 */
export function patchPresentationHtmlText(
  html: string,
  previousText: string,
  nextText: string,
  target: PresentationHtmlTextTarget
): PresentationHtmlPatchResult {
  const marked = patchMarkedText(html, nextText, target);
  if (marked.replaced || previousText === nextText) return marked;

  const textNode = patchTextNode(
    html,
    previousText,
    nextText,
    target.type === 'bullet' ? target.duplicateOccurrence ?? 0 : 0
  );
  if (textNode.replaced) return textNode;

  return target.type === 'title'
    ? patchSemanticContainer(html, previousText, nextText, ['h1', 'h2', 'h3'])
    : patchSemanticContainer(html, previousText, nextText, ['li', 'p']);
}

function patchMarkedText(
  html: string,
  nextText: string,
  target: PresentationHtmlTextTarget
): PresentationHtmlPatchResult {
  const attributeName = target.type === 'title' ? 'data-el-field' : 'data-el-bullet-index';
  const attributeValue = target.type === 'title' ? 'title' : String(target.index);
  const pattern = new RegExp(
    `(<([a-z][\\w:-]*)\\b(?=[^>]*\\b${attributeName}\\s*=\\s*["']${escapeRegExp(attributeValue)}["'])[^>]*>)([\\s\\S]*?)(<\\/\\2\\s*>)`,
    'i'
  );
  if (!pattern.test(html)) return { html, replaced: false };
  return {
    html: html.replace(pattern, (_match, opening: string, _tag: string, _content: string, closing: string) =>
      `${opening}${escapeHtml(nextText)}${closing}`
    ),
    replaced: true
  };
}

function patchTextNode(
  html: string,
  previousText: string,
  nextText: string,
  targetOccurrence: number
): PresentationHtmlPatchResult {
  if (!previousText) return { html, replaced: false };

  const candidates = [...new Set([
    escapeHtml(previousText),
    escapeHtmlText(previousText),
    previousText
  ])].filter(Boolean);
  let cursor = 0;
  let occurrence = 0;
  let output = '';

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    const textEnd = tagStart === -1 ? html.length : tagStart;
    const text = html.slice(cursor, textEnd);
    const match = findCandidate(text, candidates);
    if (match && occurrence === targetOccurrence) {
      return {
        html: `${output}${text.slice(0, match.index)}${escapeHtml(nextText)}${text.slice(match.index + match.value.length)}${html.slice(textEnd)}`,
        replaced: true
      };
    }
    if (match) occurrence += 1;
    output += text;
    if (tagStart === -1) break;

    const tagEnd = findTagEnd(html, tagStart + 1);
    if (tagEnd === -1) {
      output += html.slice(tagStart);
      break;
    }
    output += html.slice(tagStart, tagEnd + 1);
    cursor = tagEnd + 1;
  }

  return { html, replaced: false };
}

function patchSemanticContainer(
  html: string,
  previousText: string,
  nextText: string,
  tags: string[]
): PresentationHtmlPatchResult {
  const expected = normalizeText(previousText);
  if (!expected) return { html, replaced: false };

  for (const tag of tags) {
    const pattern = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)(<\\/${tag}\\s*>)`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      if (normalizeText(decodeHtml(stripTags(match[2] ?? ''))) !== expected) continue;
      const start = match.index;
      const replacement = `${match[1]}${escapeHtml(nextText)}${match[3]}`;
      return {
        html: `${html.slice(0, start)}${replacement}${html.slice(start + match[0].length)}`,
        replaced: true
      };
    }
  }

  return { html, replaced: false };
}

function findCandidate(text: string, candidates: string[]) {
  let match: { index: number; value: string } | undefined;
  for (const candidate of candidates) {
    const index = text.indexOf(candidate);
    if (index === -1 || (match && match.index <= index)) continue;
    match = { index, value: candidate };
  }
  return match;
}

function findTagEnd(html: string, start: number) {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const character = html[index] ?? '';
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function stripTags(value: string) {
  return value.replace(/<[^>]*>/g, ' ');
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#39|apos);/gi, "'");
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeHtmlText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value: string) {
  return escapeHtmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

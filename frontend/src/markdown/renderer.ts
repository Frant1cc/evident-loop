import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import {
  buildSourceLinkNumberMap,
  isSourceLinkLabel,
  normalizeSourceHref,
  plainLinkLabel,
  sourceNumber,
  type MarkdownSource
} from './sourceReferences';

export type MarkdownRenderOptions = {
  streaming?: boolean;
  sources?: MarkdownSource[];
  sourceLinkNumbers?: ReadonlyMap<string, number>;
};

type CitationToken = {
  type: 'citation';
  raw: string;
  key: string;
};

let renderingStreamingContent = false;
let renderingSources: MarkdownSource[] = [];
let renderingSourceLinkNumbers: ReadonlyMap<string, number> = new Map();

const markdown = new Marked({
  gfm: true,
  breaks: true,
  extensions: [
    {
      name: 'citation',
      level: 'inline',
      start(source) {
        const index = source.search(/\[S\d+\]/);
        return index === -1 ? undefined : index;
      },
      tokenizer(source) {
        const match = /^\[(S\d+)\]/.exec(source);
        if (!match) return undefined;
        return { type: 'citation', raw: match[0], key: match[1] } satisfies CitationToken;
      },
      renderer(token) {
        const { key } = token as CitationToken;
        const source = renderingSources.find((item) => item.citationKey.toLowerCase() === key.toLowerCase());
        return renderSourceMarker({
          key,
          number: sourceNumber(key, renderingSources.indexOf(source!)),
          source
        });
      }
    }
  ],
  renderer: {
    code(token: Tokens.Code) {
      const language = normalizeLanguage(token.lang);
      const label = getLanguageLabel(language);
      const streaming = renderingStreamingContent && !isClosedFencedCodeBlock(token.raw);
      const state = streaming ? 'streaming' : 'complete';
      const stateLabel = streaming ? '<span class="markdown-code-state">生成中</span>' : '';
      const disabled = streaming ? ' disabled' : '';

      return [
        `<div class="markdown-code-block" data-code-block data-code-state="${state}" data-language="${escapeHtml(language)}">`,
        '<div class="markdown-code-toolbar">',
        `<span class="markdown-code-language">${escapeHtml(label)}</span>`,
        stateLabel,
        `<button type="button" class="markdown-code-copy" data-copy-code aria-label="复制 ${escapeHtml(label)} 代码"${disabled}><span data-copy-label>复制</span></button>`,
        '</div>',
        `<pre><code class="${language ? `language-${escapeHtml(language)}` : 'language-plaintext'}">${escapeHtml(token.text)}</code></pre>`,
        '</div>'
      ].join('');
    },
    link(token: Tokens.Link) {
      const label = plainLinkLabel(token.text);
      if (isSourceLinkLabel(label)) {
        const normalizedHref = normalizeSourceHref(token.href);
        const source = renderingSources.find((item) => normalizeSourceHref(item.file) === normalizedHref);
        const number = source
          ? sourceNumber(source.citationKey, renderingSources.indexOf(source))
          : renderingSourceLinkNumbers.get(normalizedHref);

        if (number !== undefined) {
          return renderSourceMarker({
            key: source?.citationKey,
            number,
            source,
            href: token.href
          });
        }
      }

      const text = this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(token.href)}"${title}>${text}</a>`;
    }
  }
});

export function renderMarkdown(content: string, options: MarkdownRenderOptions = {}) {
  if (!content) return '';
  const previousStreamingState = renderingStreamingContent;
  const previousSources = renderingSources;
  const previousSourceLinkNumbers = renderingSourceLinkNumbers;
  renderingStreamingContent = options.streaming ?? false;
  renderingSources = options.sources ?? [];
  renderingSourceLinkNumbers = options.sourceLinkNumbers ?? buildSourceLinkNumberMap(content, renderingSources);

  try {
    const rendered = markdown.parse(content) as string;
    const sanitized = DOMPurify.sanitize(rendered, {
      ADD_ATTR: [
        'aria-label',
        'data-citation-key',
        'data-code-block',
        'data-code-state',
        'data-copy-code',
        'data-copy-label',
        'data-language',
        'data-source-number',
        'data-source-url',
        'rel',
        'target'
      ],
      ADD_TAGS: ['button']
    });
    return removeSourceMarkersFromLinks(sanitized);
  } finally {
    renderingStreamingContent = previousStreamingState;
    renderingSources = previousSources;
    renderingSourceLinkNumbers = previousSourceLinkNumbers;
  }
}

export function splitStableMarkdown(content: string) {
  if (!content) return { stable: '', tail: '' };
  const tokens = markdown.lexer(content);
  let cursor = 0;
  let stableEnd = 0;

  for (const token of tokens) {
    cursor += token.raw.length;
    if (token.type === 'space' && /(?:\r?\n){2,}/.test(token.raw)) stableEnd = cursor;
  }

  return {
    stable: content.slice(0, stableEnd),
    tail: content.slice(stableEnd)
  };
}

export function isClosedFencedCodeBlock(raw: string) {
  const opener = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(raw);
  if (!opener) return true;
  const marker = opener[1]!;
  const markerCharacter = marker[0]!;

  return raw
    .slice(opener[0].length)
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      return trimmed.length >= marker.length && [...trimmed].every((character) => character === markerCharacter);
    });
}

function removeSourceMarkersFromLinks(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const marker of template.content.querySelectorAll<HTMLElement>('a .markdown-source-marker')) {
    marker.replaceWith(document.createTextNode(marker.textContent ?? ''));
  }
  return template.innerHTML;
}

function renderSourceMarker(options: {
  key?: string;
  number: number;
  source?: MarkdownSource;
  href?: string;
}) {
  const explicitHref = options.href;
  const href = explicitHref ?? options.source?.file;
  const isWebSource = Boolean(href && /^https?:\/\//iu.test(href));
  const label = options.source?.heading?.trim() || options.source?.title?.trim();
  const ariaLabel = `${isWebSource ? '打开' : '查看'}来源 ${options.number}${label ? `：${label}` : ''}`;
  const attributes = [
    'class="markdown-source-marker"',
    `data-source-number="${options.number}"`,
    options.key ? `data-citation-key="${escapeHtml(options.key)}"` : '',
    href ? `data-source-url="${escapeHtml(href)}"` : '',
    `aria-label="${escapeHtml(ariaLabel)}"`
  ].filter(Boolean).join(' ');
  const number = `<span aria-hidden="true">${options.number}</span>`;

  if (isWebSource) {
    return `<a href="${escapeHtml(href!)}" target="_blank" rel="noopener noreferrer" ${attributes}>${number}</a>`;
  }
  if (explicitHref) return `<a href="${escapeHtml(explicitHref)}" ${attributes}>${number}</a>`;
  return `<button type="button" ${attributes}>${number}</button>`;
}

export function normalizeLanguage(value?: string) {
  const language = value?.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  const aliases: Record<string, string> = {
    cjs: 'javascript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    'c++': 'cpp',
    html: 'xml',
    vue: 'xml',
    md: 'markdown',
    yml: 'yaml',
    text: 'plaintext',
    txt: 'plaintext'
  };
  return aliases[language] ?? language.replace(/[^a-z0-9_+#.-]/g, '');
}

export function getLanguageLabel(language: string) {
  const labels: Record<string, string> = {
    bash: 'Shell',
    cpp: 'C++',
    css: 'CSS',
    java: 'Java',
    javascript: 'JavaScript',
    json: 'JSON',
    markdown: 'Markdown',
    plaintext: 'Plain text',
    python: 'Python',
    sql: 'SQL',
    typescript: 'TypeScript',
    xml: 'HTML / XML',
    yaml: 'YAML'
  };
  return labels[language] ?? (language ? language.toUpperCase() : 'Code');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

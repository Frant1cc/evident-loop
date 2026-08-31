import type {
  IntentSignal,
  RetrievalCapability,
  RetrievalIntent,
  VerticalDomain
} from './types.js';

const URL_PATTERN = /https?:\/\/[^\s<>\])}"']+/gi;

const FRESHNESS_HIGH = [
  '今天', '今日', '刚刚', '实时', '现在', '当前', '截至目前',
  'today', 'live', 'realtime', 'right now', 'as of now'
];
const FRESHNESS_MEDIUM = [
  '最新', '最近', '近期', '本周', '本月', 'latest', 'recent', 'this week', 'this month'
];
const OFFICIAL_DOCS_HIGH = [
  '官方文档', '开发者文档', 'api reference', 'api docs', 'sdk docs',
  'official documentation', 'official docs', 'developer documentation'
];
const OFFICIAL_DOCS_CONTEXT = [
  'api', 'sdk', '参数', '配置', '接入', '版本', '函数', 'reference',
  'configuration', 'integration', 'method', 'function'
];
const OFFICIAL_TERMS = ['官方', '官网', 'official', 'docs.', 'developer.'];
const TECHNICAL_DOCS_TERMS = [
  'server-sent events', 'sse', 'websocket', 'nginx', 'http', 'eventsource',
  'api', 'sdk', 'node.js', 'spring', 'heartbeat', 'reconnection', 'buffering',
  'compression', 'concurrency', 'authentication', '浏览器', '反向代理'
];
const CHINA_DOMESTIC = [
  '中国', '国内', '国务院', '国家部委', '监管', 'a股', '港股', '人民币',
  '工信部', '财政部', '证监会', '人民银行', 'gov.cn', '境内'
];
const POLICY_OR_NEWS = ['政策', '公告', '新闻', '通知', '监管', '行情', '战报'];
const DYNAMIC_PAGE = [
  '动态页面', 'js 渲染', 'javascript 渲染', '浏览器渲染', '登录后',
  'cloudflare', '截图', 'ocr', 'js-heavy', 'dynamic page'
];
const VERIFICATION = [
  '核验', '验证', '真假', '是否属实', '交叉验证', '其他来源', '多个来源',
  'verify', 'fact check', 'cross-check', 'cross check', 'other sources'
];
const PDF_TERMS = ['pdf', 'arxiv', '论文全文', '报告原文', '白皮书原文'];

const VERTICAL_RULES: Array<{ domain: VerticalDomain; identifiers: RegExp[]; terms: string[] }> = [
  {
    domain: 'security',
    identifiers: [/\bcve-\d{4}-\d{4,}\b/i, /\bcwe-\d+\b/i],
    terms: ['漏洞', 'cvss', '漏洞库', 'exploit', 'vulnerability']
  },
  {
    domain: 'academic',
    identifiers: [/\b10\.\d{4,9}\/[-._;()/:a-z0-9]+\b/i, /\barxiv:\s*\d{4}\.\d{4,5}\b/i],
    terms: ['论文引用', '期刊', 'doi', 'arxiv', 'citation', '学术论文']
  },
  {
    domain: 'finance',
    identifiers: [/\b(?:sh|sz|hk)\d{5,6}\b/i, /\bsec\s+(?:10-k|10-q|8-k)\b/i],
    terms: ['财报', '股票代码', '基金代码', '年报', '季报', '招股书']
  },
  {
    domain: 'legal',
    identifiers: [/〔\d{4}〕\d+号/, /\(\d{4}\)\s*\w+\s*\d+号/],
    terms: ['法条', '判例', '裁判文书', '法规文号', '司法解释', '法律数据库']
  },
  {
    domain: 'code',
    identifiers: [/https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/[\w.-]+\/[\w.-]+/i],
    terms: ['代码仓库', '仓库搜索', '代码搜索', 'github repo', 'gitlab repo', 'codebase search']
  }
];

export function detectRetrievalIntent(question: string): RetrievalIntent {
  const text = question.trim();
  const lower = text.toLowerCase();
  const urls = extractUrls(text);
  const chineseRatio = calculateChineseRatio(text);
  const highFreshness = matchedIntentTerms(lower, FRESHNESS_HIGH);
  const mediumFreshness = matchedIntentTerms(lower, FRESHNESS_MEDIUM);
  const officialHigh = matches(lower, OFFICIAL_DOCS_HIGH);
  const officialContext = matches(lower, OFFICIAL_DOCS_CONTEXT);
  const officialMarker = matches(lower, OFFICIAL_TERMS);
  const technicalDocsMatches = matchedIntentTerms(lower, TECHNICAL_DOCS_TERMS);
  const chinaMatches = matchedTerms(lower, CHINA_DOMESTIC);
  const policyMatches = matchedTerms(lower, POLICY_OR_NEWS);
  const dynamicMatches = matchedTerms(lower, DYNAMIC_PAGE);
  const verificationMatches = matchedTerms(lower, VERIFICATION);
  const pdfUrls = urls.filter(isPdfUrl);
  const pdfMatches = matchedTerms(lower, PDF_TERMS);
  const vertical = detectVertical(text);

  const freshness = highFreshness.length
    ? signal(true, 0.95, [`matched strong freshness terms: ${highFreshness.join(', ')}`])
    : mediumFreshness.length
      ? signal(true, 0.76, [`matched freshness terms: ${mediumFreshness.join(', ')}`])
      : signal(false);
  const chineseLanguage = chineseRatio >= 0.3
    ? signal(true, Math.min(0.95, 0.65 + chineseRatio * 0.3), [`Chinese character ratio ${chineseRatio.toFixed(2)}`])
    : signal(false);
  const chinaDomestic = chinaMatches.length
    ? signal(true, Math.min(0.96, 0.74 + chinaMatches.length * 0.07), [`matched China scope terms: ${chinaMatches.join(', ')}`])
    : chineseLanguage.matched && freshness.matched && policyMatches.length
      ? signal(true, 0.7, ['Chinese time-sensitive policy/news query'])
      : signal(false);
  const officialDocs = officialHigh.length
    ? signal(true, 0.94, [`explicit official documentation terms: ${officialHigh.join(', ')}`])
    : officialMarker.length && officialContext.length
      ? signal(true, 0.8, [`official marker plus technical terms: ${officialMarker.join(', ')} / ${officialContext.join(', ')}`])
      : technicalDocsMatches.length >= 2
        ? signal(true, 0.78, [`technical standards query: ${technicalDocsMatches.join(', ')}`])
      : signal(false);
  const pdf = pdfUrls.length
    ? signal(true, 1, [`PDF URL detected: ${pdfUrls[0]}`])
    : pdfMatches.length
      ? signal(true, 0.8, [`matched PDF/document terms: ${pdfMatches.join(', ')}`])
      : signal(false);

  const capabilities = new Set<RetrievalCapability>();
  // Every evidence path eventually needs readable page content, whether the
  // URL came from the user or from a search provider.
  capabilities.add('web_fetch');
  if (!urls.length || verificationMatches.length) capabilities.add('web_search');
  if (officialDocs.matched) capabilities.add('docs_search');
  if (vertical.matched && vertical.confidence >= 0.8) capabilities.add('vertical_search');

  return {
    routerVersion: 'intent-rules-v1',
    urls,
    requiredCapabilities: orderedCapabilities(capabilities),
    knownUrl: urls.length ? signal(true, 1, [`detected ${urls.length} explicit URL(s)`]) : signal(false),
    pdf,
    officialDocs,
    freshness,
    chineseLanguage,
    chinaDomestic,
    dynamicPage: dynamicMatches.length
      ? signal(true, 0.82, [`matched dynamic-page terms: ${dynamicMatches.join(', ')}`])
      : signal(false),
    verification: verificationMatches.length
      ? signal(true, 0.9, [`matched verification terms: ${verificationMatches.join(', ')}`])
      : signal(false),
    vertical
  };
}

function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;，。；]+$/, '')))];
}

function isPdfUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.pathname.toLowerCase().endsWith('.pdf') || /\/pdf(?:\/|$)/i.test(url.pathname) && /arxiv\.org$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function detectVertical(text: string): RetrievalIntent['vertical'] {
  const lower = text.toLowerCase();
  const domains: VerticalDomain[] = [];
  const reasons: string[] = [];
  let confidence = 0;

  for (const rule of VERTICAL_RULES) {
    const identifier = rule.identifiers.find((pattern) => pattern.test(text));
    const terms = matchedTerms(lower, rule.terms);
    if (identifier) {
      domains.push(rule.domain);
      confidence = Math.max(confidence, 0.96);
      reasons.push(`${rule.domain}: matched structured identifier`);
    } else if (terms.length >= 2) {
      domains.push(rule.domain);
      confidence = Math.max(confidence, 0.82);
      reasons.push(`${rule.domain}: matched ${terms.join(', ')}`);
    } else if (terms.length === 1) {
      confidence = Math.max(confidence, 0.55);
      reasons.push(`${rule.domain} hint: matched ${terms[0]}`);
    }
  }

  return {
    matched: domains.length > 0,
    confidence,
    reasons,
    domains: [...new Set(domains)]
  };
}

function calculateChineseRatio(text: string) {
  const meaningful = text.match(/[a-z0-9\u4e00-\u9fff]/gi) ?? [];
  if (!meaningful.length) return 0;
  return meaningful.filter((char) => /[\u4e00-\u9fff]/.test(char)).length / meaningful.length;
}

function signal(matched: boolean, confidence = 0, reasons: string[] = []): IntentSignal {
  return { matched, confidence, reasons };
}

function matches(lower: string, terms: string[]) {
  return matchedTerms(lower, terms);
}

/**
 * Intent words in Latin text must match complete tokens/phrases. A raw
 * substring check turns SSE's "keep-alive" into the freshness term "live".
 */
function matchedIntentTerms(lower: string, terms: string[]) {
  return terms.filter((term) => {
    const normalized = term.toLowerCase();
    if (/^[a-z][a-z\s-]*$/i.test(normalized)) {
      const pattern = normalized
        .split(/([\s-]+)/)
        .map((part) => /^[\s-]+$/.test(part) ? '[\\s-]+' : escapeRegExp(part))
        .join('');
      return new RegExp(`(^|[^a-z0-9])${pattern}($|[^a-z0-9])`, 'i').test(lower);
    }
    return lower.includes(normalized);
  });
}

function matchedTerms(lower: string, terms: string[]) {
  return terms.filter((term) => lower.includes(term.toLowerCase()));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function orderedCapabilities(capabilities: Set<RetrievalCapability>) {
  const order: RetrievalCapability[] = ['web_fetch', 'docs_search', 'vertical_search', 'web_search'];
  return order.filter((capability) => capabilities.has(capability));
}

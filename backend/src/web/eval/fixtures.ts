export type WebEvalCategory = 'official_api' | 'freshness' | 'multi_claim' | 'unanswerable';

export type WebEvalEvidenceNeed = {
  id: string;
  label: string;
  /** Every group must match; values inside a group are alternatives. */
  groups: string[][];
};

export type WebEvalCase = {
  id: string;
  title: string;
  question: string;
  category: WebEvalCategory;
  answerable: boolean;
  includeDomains?: string[];
  timeRange?: 'day' | 'week' | 'month' | 'year';
  expectedDomains: string[];
  expectedEvidence: WebEvalEvidenceNeed[];
};

/**
 * Versioned, deliberately small smoke suite. Running it consumes real web-search
 * credits, so cases favour stable official documentation and explicit claims.
 */
export const webEvalCases: WebEvalCase[] = [
  {
    id: 'tavily-search-depth',
    title: 'Tavily 搜索深度',
    question: 'Tavily Search API 的 search_depth 有哪些可选值？basic 和 advanced 的作用与 API credits 成本有什么区别？请只引用 Tavily 官方文档。',
    category: 'multi_claim',
    answerable: true,
    includeDomains: ['docs.tavily.com'],
    expectedDomains: ['docs.tavily.com'],
    expectedEvidence: [
      { id: 'values', label: '可选值 basic / advanced', groups: [['search_depth'], ['basic'], ['advanced']] },
      { id: 'role', label: '两种模式的检索定位', groups: [['basic'], ['advanced'], ['snippet', 'content', 'relevant', '片段', '相关']] },
      { id: 'cost', label: 'advanced 每次请求 2 credits', groups: [['advanced'], ['2 credits', '2 api credits', '2 个', '2个']] }
    ]
  },
  {
    id: 'tavily-domain-filter',
    title: 'Tavily 域名过滤',
    question: 'Tavily Search API 如何通过 include_domains 和 exclude_domains 限定检索域名？请给出官方参数名和用途。',
    category: 'official_api',
    answerable: true,
    includeDomains: ['docs.tavily.com'],
    expectedDomains: ['docs.tavily.com'],
    expectedEvidence: [
      { id: 'include', label: 'include_domains 白名单', groups: [['include_domains'], ['include', 'only', '白名单', '包含']] },
      { id: 'exclude', label: 'exclude_domains 排除列表', groups: [['exclude_domains'], ['exclude', '排除']] }
    ]
  },
  {
    id: 'tavily-time-range',
    title: 'Tavily 时间范围',
    question: 'Tavily Search API 的 time_range 参数支持哪些时间范围值？请只查询 Tavily 官方文档。',
    category: 'official_api',
    answerable: true,
    includeDomains: ['docs.tavily.com'],
    expectedDomains: ['docs.tavily.com'],
    expectedEvidence: [
      { id: 'parameter', label: 'time_range 参数', groups: [['time_range']] },
      { id: 'values', label: 'day / week / month / year', groups: [['day'], ['week'], ['month'], ['year']] }
    ]
  },
  {
    id: 'node-release',
    title: 'Node.js 当前 LTS',
    question: '截至 2026 年 8 月，Node.js 官方列出的 Active LTS 发布线是什么？说明其版本和代号，并引用 nodejs.org。',
    category: 'freshness',
    answerable: true,
    includeDomains: ['nodejs.org'],
    expectedDomains: ['nodejs.org'],
    expectedEvidence: [
      { id: 'lts', label: 'Active LTS 发布信息', groups: [['active lts', 'active'], ['v24', '24.x', 'version 24'], ['krypton']] }
    ]
  },
  {
    id: 'unanswerable-product',
    title: '不存在的官方参数',
    question: 'Tavily Search API 的 quantum_oracle_depth 参数有哪些可选值？请只引用 Tavily 官方文档。',
    category: 'unanswerable',
    answerable: false,
    includeDomains: ['docs.tavily.com'],
    expectedDomains: ['docs.tavily.com'],
    expectedEvidence: []
  }
];

export const webEvalSuiteVersion = 1;

export function getWebEvalCases(ids?: string[]) {
  if (!ids?.length) return webEvalCases;
  const selected = new Set(ids);
  return webEvalCases.filter((item) => selected.has(item.id));
}

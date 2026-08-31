import { z } from 'zod';

import { createConfiguredLlm } from '../llm/config.js';
import type { LlmProvider } from '../llm/contracts.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { normalizeQuery } from './quality.js';

export type PlannedWebClaim = {
  id: string;
  text: string;
  searchQueries: string[];
  preferredDomains: string[];
  sourceTypes: string[];
  subjectTerms: string[];
  /** Whether this verification question came directly from the user or from an open-ended scope expansion. */
  origin?: 'user' | 'inferred_scope';
  basis?: string;
  requiredAuthority?: 'official';
  priority?: 'core' | 'supporting' | 'optional';
  blocking?: boolean;
};

export type WebEvidencePlan = {
  subject: string;
  claims: PlannedWebClaim[];
  preferredDomains: string[];
  planningMethod: 'llm' | 'deterministic-fallback' | 'caller-required-evidence';
  scopeExpansions?: Array<{ entity: string; reason: string }>;
  planningFailure?: {
    reason: 'no-llm' | 'empty-response' | 'invalid-response';
    message: string;
  };
};

export type EvidencePlannerOptions = {
  signal?: AbortSignal;
  llm?: LlmProvider;
  currentDate?: string;
};

type FallbackCompany = {
  name: string;
  aliases: RegExp[];
  domains: string[];
};

const fallbackCompanies: FallbackCompany[] = [
  { name: 'OpenAI', aliases: [/\bopenai\b/i], domains: ['openai.com'] },
  { name: 'Anthropic', aliases: [/\banthropic\b/i, /\bclaude\b/i], domains: ['anthropic.com'] },
  { name: 'Google DeepMind', aliases: [/\bgoogle(?: deepmind)?\b/i, /\bdeepmind\b/i, /\bgemini\b/i], domains: ['deepmind.google', 'blog.google', 'ai.google.dev'] },
  { name: 'Meta', aliases: [/\bmeta(?: ai)?\b/i, /\bllama\b/i], domains: ['ai.meta.com', 'about.fb.com', 'meta.com'] },
  { name: 'xAI', aliases: [/\bxai\b/i, /\bx\.ai\b/i, /\bgrok\b/i], domains: ['x.ai'] },
  { name: 'Mistral AI', aliases: [/\bmistral(?: ai)?\b/i], domains: ['mistral.ai'] },
  { name: 'DeepSeek', aliases: [/\bdeepseek\b/i, /深度求索/u], domains: ['deepseek.com'] }
];

const planSchema = z.object({
  subject: z.string().trim().min(1).max(160),
  claims: z.array(z.object({
    id: z.string().trim().min(1).max(80).optional(),
    text: z.string().trim().min(2).max(240),
    searchQueries: z.array(z.string().trim().min(2).max(500)).min(1).max(3),
    preferredDomains: z.array(z.string().trim().min(1).max(253)).max(8).default([]),
    sourceTypes: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
    subjectTerms: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
    origin: z.enum(['user', 'inferred_scope']).default('user'),
    basis: z.string().trim().max(240).default('Derived from the user question'),
    priority: z.enum(['core', 'supporting', 'optional']).optional(),
    blocking: z.boolean().optional()
  })).min(1).max(12),
  preferredDomains: z.array(z.string().trim().min(1).max(253)).max(12).default([]),
  scopeExpansions: z.array(z.object({
    entity: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(240)
  })).max(12).default([])
});

const plannerPrompt = `You create an evidence plan for web research.
Return JSON only with this shape:
{
  "subject": "primary entity or topic",
  "claims": [{
    "id": "short stable id",
    "text": "one atomic, independently verifiable question in the user's language",
    "searchQueries": ["one or two focused web searches"],
    "preferredDomains": ["authoritative.example"],
    "sourceTypes": ["standard", "official_docs", "research_paper", "regulator", "vendor_docs"],
    "subjectTerms": ["terms that must occur in evidence to bind it to the subject"],
    "priority": "core|supporting|optional",
    "blocking": true
  }],
  "preferredDomains": ["authoritative domains useful across claims"],
  "scopeExpansions": [{"entity":"an entity added only because the user explicitly requested an open-ended category","reason":"why it belongs in scope"}]
}
Rules:
- Derive the plan only from the user's question; never answer the question.
- Only claims explicitly needed to answer the user's question may be blocking. Extra API identifiers, pricing, benchmarks, implementation details, or adjacent product facts are optional unless the user asked for them.
- For ordinary "latest X" or "which X" questions, use at most two blocking claims: the current authoritative list and recent authoritative release records. Mark discovery enrichments priority="optional", blocking=false.
- The user's question is the immutable source of factual candidates. Never introduce a model name, product, version, date, rumor, leak, or example that is absent from the question.
- You may translate terms and add neutral discovery phrases such as "official announcement", "roadmap", or "release notes".
- When the user explicitly asks for an open-ended category (for example "other major companies"), you may add category members. Mark their claims origin="inferred_scope", explain the basis, and list them in scopeExpansions. Do not guess products or versions for those entities.
- Claims must be verification questions, not assumptions that a candidate exists. A search query must not contain a factual candidate absent from the user question or its claim.
- Do not add rumor/leak intent unless the user explicitly requested rumors or leaks.
- For company roadmaps, upcoming products, or release announcements, set sourceTypes=["official_announcement"] and provide the company's real official domains. Third-party aggregators and social posts are discovery leads, not confirmation evidence.
- Split broad categories into concrete, testable claims. Avoid vague claims such as "performance" or "connection management" when the question implies concrete subtopics.
- Preserve every named entity, version, date, jurisdiction, and requested comparison.
- Generate multilingual queries when the best authoritative material may use another language. Reuse one query across claims when one authoritative page can efficiently cover them.
- Prefer standards, regulators, official documentation, and primary research. Domains are hints, not fabricated citations.
- Do not turn citation/style instructions into claims.
- Use at most 8 claims for ordinary questions and at most 12 for genuinely broad questions.`;

export async function planWebEvidence(
  question: string,
  options: EvidencePlannerOptions = {}
): Promise<WebEvidencePlan> {
  const configured = createConfiguredLlm();
  const llm = options.llm ?? configured.llm;
  const currentDate = normalizeCurrentDate(options.currentDate);
  if (!llm) {
    return fallbackEvidencePlan(question, {
      reason: 'no-llm',
      message: 'No evidence-planning LLM is configured.',
      currentDate
    });
  }

  try {
    const response = await resolveLlmProvider({ llm }).complete({
      model: configured.model,
      temperature: 0,
      maxRetries: 1,
      signal: options.signal,
      messages: [
        { role: 'system', content: `${plannerPrompt}\nCurrent date: ${currentDate}. Treat relative freshness words using this date.` },
        { role: 'user', content: question }
      ]
    });
    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return fallbackEvidencePlan(question, {
        reason: 'empty-response',
        message: 'The evidence-planning LLM returned no content.',
        currentDate
      });
    }
    const parsed = planSchema.parse(JSON.parse(stripCodeFence(content)));
    const claims = deduplicateClaims(parsed.claims)
      .filter((claim) => !introducesUnsupportedCandidate(claim.text, question))
      .map((claim, index) => ({
      id: sanitizeId(claim.id) || `C${index + 1}`,
      text: claim.text,
      searchQueries: safeSearchQueries(claim.searchQueries, claim.text, parsed.subject, question, currentDate),
      preferredDomains: normalizeDomains(claim.preferredDomains),
      sourceTypes: uniqueStrings(claim.sourceTypes),
      subjectTerms: uniqueStrings(claim.subjectTerms.length ? claim.subjectTerms : [parsed.subject]),
      origin: claim.origin,
      basis: claim.basis,
      ...claimPriority(claim, question, parsed.subject)
    }));
    if (!claims.length) {
      return fallbackEvidencePlan(question, {
        reason: 'invalid-response',
        message: 'The evidence-planning LLM produced no safe claims.',
        currentDate
      });
    }
    return {
      subject: parsed.subject,
      claims,
      preferredDomains: normalizeDomains([
        ...parsed.preferredDomains,
        ...claims.flatMap((claim) => claim.preferredDomains)
      ]),
      planningMethod: 'llm',
      scopeExpansions: parsed.scopeExpansions
    };
  } catch (error) {
    return fallbackEvidencePlan(question, {
      reason: 'invalid-response',
      message: compactError(error),
      currentDate
    });
  }
}

export function fallbackEvidencePlan(
  question: string,
  failure?: WebEvidencePlan['planningFailure'] & { currentDate?: string }
): WebEvidencePlan {
  const companyPlan = fallbackCompanyEvidencePlan(question, failure);
  if (companyPlan) return companyPlan;
  const cleaned = question
    .replace(/^(请|麻烦|帮我)\s*/i, '')
    .replace(/^(联网)?(查询|查找|搜索|查清|核对|确认|研究)\s*/i, '')
    .replace(/^(please\s+)?(search|find|verify|look up)\s+/i, '')
    .trim();
  const fragments = cleaned
    .split(/[；;。！？!?：:\n]+/)
    .flatMap((fragment) => fragment.split(/[，,、]+/))
    .flatMap((fragment) => fragment.split(/\s*(?:以及|并且|同时)\s*/))
    .map((fragment) => fragment.replace(/^(?:包括|包含|涵盖|涉及|以及|并且|同时|及|和)\s*/i, '').trim())
    .filter((fragment) => fragment.length >= 2)
    .filter((fragment) => !/^(只查询|仅查询|限定在|限制在|只使用|仅使用|只根据|仅根据|引用|给出来源|列出来源|并给出来源|不要猜|不要编造)/.test(fragment));
  const unique = uniqueStrings(fragments);
  const values = unique.length ? unique.slice(0, 12) : [cleaned || question.trim()];
  const subject = inferGenericSubject(question);
  return {
    subject,
    claims: values.map((text, index) => ({
      id: `C${index + 1}`,
      text: text.replace(/[？?。！!]$/, '').trim(),
      searchQueries: [`${subject} ${text}`.replace(/\s+/g, ' ').trim().slice(0, 500)],
      preferredDomains: [],
      sourceTypes: [],
      subjectTerms: subject ? [subject] : [],
      origin: 'user',
      basis: 'Deterministic decomposition of the original user question.',
      priority: 'core',
      blocking: true
    })),
    preferredDomains: [],
    planningMethod: 'deterministic-fallback',
    ...(failure ? { planningFailure: { reason: failure.reason, message: failure.message } } : {})
  };
}

function fallbackCompanyEvidencePlan(
  question: string,
  failure?: WebEvidencePlan['planningFailure'] & { currentDate?: string }
): WebEvidencePlan | undefined {
  const asksForModelReleases = /(?:models?|模型).{0,60}(?:announce|release|launch|upcoming|latest|recent|宣布|发布|上线|即将|最新|最近)|(?:announce|release|launch|upcoming|latest|recent|宣布|发布|上线|即将|最新|最近).{0,60}(?:models?|模型)/iu.test(question);
  if (!asksForModelReleases) return undefined;

  const explicitlyNamed = fallbackCompanies.filter((company) => company.aliases.some((alias) => alias.test(question)));
  if (!explicitlyNamed.length) return undefined;
  const openEnded = /主流|其他|其它|那些|等公司|such as|including|major\s+AI\s+compan/iu.test(question);
  const selected = openEnded ? fallbackCompanies : explicitlyNamed;
  const explicitNames = new Set(explicitlyNamed.map((company) => company.name));
  const currentDate = normalizeCurrentDate(failure?.currentDate);
  const year = currentDate.slice(0, 4);
  const claims = selected.map((company, index): PlannedWebClaim => ({
    id: `${company.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-model-releases` || `company-${index + 1}`,
    text: `${company.name} 最近正式宣布但尚未发布、或最近已经发布的新模型有哪些？`,
    searchQueries: [
      `${company.name} ${year} official new model announcement release`,
      `${company.name} latest model official release notes`
    ],
    preferredDomains: company.domains,
    sourceTypes: ['official_announcement'],
    subjectTerms: [company.name],
    origin: explicitNames.has(company.name) ? 'user' : 'inferred_scope',
    basis: explicitNames.has(company.name)
      ? `${company.name} was named by the user.`
      : 'The user requested other mainstream AI companies.',
    priority: explicitNames.has(company.name) ? 'core' : 'supporting',
    blocking: explicitNames.has(company.name)
  }));
  return {
    subject: '主流 AI 公司近期模型发布',
    claims,
    preferredDomains: [...new Set(claims.flatMap((claim) => claim.preferredDomains))],
    planningMethod: 'deterministic-fallback',
    scopeExpansions: claims
      .filter((claim) => claim.origin === 'inferred_scope')
      .map((claim) => ({ entity: claim.subjectTerms[0]!, reason: claim.basis! })),
    ...(failure ? { planningFailure: { reason: failure.reason, message: failure.message } } : {})
  };
}

function normalizeCurrentDate(value?: string) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function compactError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Evidence planning failed.';
}

function inferGenericSubject(question: string) {
  const acronym = question.match(/\b[A-Z][A-Z0-9.-]{1,15}\b/)?.[0];
  const namedApi = question.match(/[A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+){0,3}\s+(?:API|SDK|protocol|framework)/i)?.[0];
  return (namedApi ?? acronym ?? question.split(/[，,。；;：:?？]/)[0] ?? question).trim().slice(0, 120);
}

function deduplicateClaims(claims: z.infer<typeof planSchema>['claims']) {
  return [...new Map(claims.map((claim) => [normalizeQuery(claim.text), claim])).values()];
}

function uniqueStrings(values: string[]) {
  return [...new Map(values.map((value) => [normalizeQuery(value), value.trim()])).values()].filter(Boolean);
}

function normalizeDomains(values: string[]) {
  return [...new Set(values.flatMap((value) => {
    try {
      const hostname = new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
      return hostname && !hostname.includes(' ') ? [hostname] : [];
    } catch {
      return [];
    }
  }))];
}

function sanitizeId(value: string | undefined) {
  return value?.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) ?? '';
}

function safeSearchQueries(
  queries: string[],
  claim: string,
  subject: string,
  originalQuestion: string,
  currentDate: string
) {
  const safe = uniqueStrings(queries)
    .map((query) => alignFreshnessYear(query, originalQuestion, currentDate))
    .filter((query) => !introducesUnsupportedCandidate(query, originalQuestion));
  return safe.length ? safe : [`${subject} ${claim}`.replace(/\s+/g, ' ').trim().slice(0, 500)];
}

function alignFreshnessYear(query: string, originalQuestion: string, currentDate: string) {
  const asksForCurrent = /\b(?:latest|recent|current|today|upcoming)\b|最新|最近|当前|今天|近期|即将/iu.test(originalQuestion);
  const userSpecifiedYear = /\b(?:19|20|21)\d{2}\b/.test(originalQuestion);
  if (!asksForCurrent || userSpecifiedYear) return query;
  const currentYear = currentDate.slice(0, 4);
  return query
    .replace(/\b(?:19|20|21)\d{2}\b/g, currentYear)
    .replace(new RegExp(`\\b${currentYear}\\b(?:\\s+${currentYear}\\b)+`, 'g'), currentYear);
}

function introducesUnsupportedCandidate(value: string, originalQuestion: string) {
  if (introducesUnrequestedRumorIntent(value, originalQuestion)) return true;
  if (!isOpenEndedDiscoveryQuestion(originalQuestion)) return false;
  const original = normalizeQuery(originalQuestion);
  return extractVersionedCandidates(value).some((candidate) => !original.includes(normalizeQuery(candidate)));
}

function introducesUnrequestedRumorIntent(value: string, originalQuestion: string) {
  const rumorPattern = /\b(?:rumou?rs?|rumou?red|leaks?|leaked)\b|传闻|爆料|泄露/iu;
  return rumorPattern.test(value) && !rumorPattern.test(originalQuestion);
}

function extractVersionedCandidates(value: string) {
  const candidates = [
    ...(value.match(/\b[A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*){0,2}\s+\d+(?:\.\d+)*(?:\.x)?\b/g) ?? []),
    ...(value.match(/\b[A-Z]{1,6}[- ]?\d+(?:\.\d+)*(?:\.x)?\b/g) ?? [])
  ];
  return uniqueStrings(candidates).filter((candidate) => {
    const number = candidate.match(/\d{4}/)?.[0];
    return !number || Number(number) < 1900 || Number(number) > 2100;
  });
}

function isOpenEndedDiscoveryQuestion(value: string) {
  return /(?:what|which|upcoming|next|roadmap|准备|即将|将要|哪些|什么).{0,40}(?:models?|products?|versions?|releases?|模型|产品|版本|发布)/iu.test(value)
    || /(?:models?|products?|versions?|releases?|模型|产品|版本).{0,40}(?:what|which|upcoming|next|roadmap|准备|即将|将要|哪些|什么)/iu.test(value);
}

function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function claimPriority(
  claim: z.infer<typeof planSchema>['claims'][number],
  question: string,
  subject: string
) {
  const inferredScope = claim.origin === 'inferred_scope';
  const unrequestedFacet = !sharesRequestedFacet(claim.text, question)
    && introducesUnrequestedFacet(claim.text, question, subject);
  const priority = inferredScope || unrequestedFacet
    ? 'optional' as const
    // A planner may accidentally label an explicitly requested fact as optional.
    // Runtime stopping semantics must be derived from user scope, not trusted to
    // a model-provided priority flag.
    : claim.priority === 'supporting' ? 'supporting' as const : 'core' as const;
  return {
    priority,
    blocking: priority !== 'optional'
  };
}

function sharesRequestedFacet(claim: string, question: string) {
  const facets = [
    /价格|价钱|定价|费用|成本|收费|多少钱|\bpric(?:e|ing)\b|\bcosts?\b/iu,
    /基准|性能测试|跑分|\bbenchmarks?\b|\bperformance\b/iu,
    /上下文窗口|参数规模|\bcontext window\b|\bparameters?\b/iu,
    /标识符|调用标识|接口参数|\bidentifiers?\b|\bapi (?:ids?|parameters?)\b/iu
  ];
  return facets.some((pattern) => pattern.test(claim) && pattern.test(question));
}

const neutralDiscoveryTerms = new Set([
  'announce', 'announcement', 'current', 'latest', 'list', 'model', 'models',
  'official', 'release', 'released', 'releases', 'timeline', 'vendor'
]);

function introducesUnrequestedFacet(claim: string, question: string, subject: string) {
  const original = normalizeQuery(`${question} ${subject}`);
  const extraLatinTerms = (claim.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])
    .filter((term) => !neutralDiscoveryTerms.has(term))
    .filter((term) => !original.includes(term));
  if (extraLatinTerms.length) return true;

  const optionalFacets = [
    /价格|价钱|定价|费用|成本|收费|多少钱/u,
    /基准|性能测试|跑分/u,
    /上下文窗口|参数规模/u,
    /标识符|调用标识|接口参数/u
  ];
  return optionalFacets.some((pattern) => pattern.test(claim) && !pattern.test(question));
}

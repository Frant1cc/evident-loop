import { lexicalRelevance, normalizeQuery } from './quality.js';

export type WebClaim = { id: string; text: string; evidenceGroups: string[][] };
export type ClaimEvidence = { content: string; url: string };
export type ClaimAssessment = WebClaim & {
  score: number;
  supported: boolean;
  matchedGroups: number;
  totalGroups: number;
  sourceUrls: string[];
};
export type ClaimCoverage = {
  claims: ClaimAssessment[];
  coverageScore: number;
  supportedClaimRatio: number;
  uncoveredClaims: string[];
};

const SUPPORT_THRESHOLD = 0.55;
const SHORT_TECHNICAL_CLAIMS = new Set([
  '鉴权', '认证', '授权', '压缩', '缓冲', '心跳', '并发', '重连', '背压'
]);

/** Deterministic extraction keeps retrieval quality independent of an extra LLM call. */
export function extractWebClaims(question: string): WebClaim[] {
  const cleaned = question
    .replace(/^(请|麻烦|帮我)\s*/i, '')
    .replace(/^(联网)?(查询|查找|搜索|查清|核对|确认|研究)\s*/i, '')
    .replace(/^(please\s+)?(search|find|verify|look up)\s+/i, '')
    .trim();

  const fragments = cleaned
    .split(/[；;。！？!?：:\n]+/)
    .flatMap((fragment) => fragment.split(/[，,、]+/))
    .flatMap((fragment) => fragment.split(/\s*(?:以及|并且|同时)\s*/))
    .map(normalizeClaimFragment)
    .filter((fragment) => fragment.length >= 4 || SHORT_TECHNICAL_CLAIMS.has(fragment.toLowerCase()))
    .filter((fragment) => !/^(只查询|仅查询|限定在|限制在|只使用|仅使用|只根据|仅根据|依据[^，,]*(官方文档|官方资料)|根据|引用|给出来源|列出来源|并给出|不要猜|不要编造|第一次搜索|如果.*不够|继续.*检索|并列出来源)/.test(fragment));

  const unique = [...new Map(fragments.map((text) => [normalizeQuery(text), text])).values()];
  const claims = unique.length ? unique : [cleaned || question.trim()];
  const hasBasicAndAdvanced = /\bbasic\b/i.test(question) && /\badvanced\b/i.test(question);
  return claims.map((rawText, index) => {
    const text = rawText
      .replace(/^依据[^，,]+[，,]\s*/, '')
      .replace(/(二者|两者)/g, hasBasicAndAdvanced ? 'basic 和 advanced ' : '$1')
      .replace(/[？?。！!]$/, '')
      .trim();
    return { id: `C${index + 1}`, text, evidenceGroups: buildEvidenceGroups(text) };
  });
}

export function assessClaimCoverage(claims: WebClaim[], evidence: ClaimEvidence[]): ClaimCoverage {
  const assessments = claims.map((claim) => {
    const matches = evidence
      .map((item) => scoreClaimEvidence(claim, item))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score);
    const score = matches[0]?.score ?? 0;
    const best = matches[0];
    return {
      ...claim,
      score,
      matchedGroups: best?.matchedGroups ?? 0,
      totalGroups: claim.evidenceGroups.length,
      supported: Boolean(best?.supported),
      sourceUrls: matches.filter((match) => match.supported).map((match) => match.item.url)
    };
  });

  const supported = assessments.filter((claim) => claim.supported).length;
  return {
    claims: assessments,
    coverageScore: assessments.length
      ? assessments.reduce((total, claim) => total + claim.score, 0) / assessments.length
      : 0,
    supportedClaimRatio: assessments.length ? supported / assessments.length : 0,
    uncoveredClaims: assessments.filter((claim) => !claim.supported).map((claim) => claim.text)
  };
}

function buildEvidenceGroups(text: string): string[][] {
  const lower = text.toLowerCase();
  const groups: string[][] = [];
  if (/心跳|heartbeat|keep-?alive/.test(lower)) {
    groups.push(['心跳机制', '心跳', 'heartbeat', 'keep-alive', 'keepalive', ': ping', 'event: heartbeat']);
  }
  if (/断线重连|自动重连|reconnect|last-event-id|\bretry\b/.test(lower)) {
    groups.push([
      '断线重连', '自动重连', 'reconnection', 'reconnect', 'last-event-id',
      'last event id', 'retry field', 'automatic retry', 'resumable stream'
    ]);
  }
  if (/消息压缩|gzip|compression/.test(lower)) {
    groups.push(['消息压缩', 'gzip', 'compression', 'compress', 'content-encoding']);
  }
  if (/缓冲|buffering|proxy_buffering/.test(lower)) {
    groups.push(['缓冲设置', '关闭缓冲', '代理缓冲', 'buffering', 'proxy_buffering', 'x-accel-buffering']);
  }
  if (/并发控制|连接数|backpressure|背压/.test(lower)) {
    groups.push([
      '服务端并发控制', '并发控制', '连接数', '连接上限', 'connection limit',
      'max connections', 'worker_connections', 'backpressure', '背压'
    ]);
  }
  if (/多路复用|multiplex|http\/2|http2/.test(lower)) {
    groups.push(['多路复用', 'multiplexing', 'multiplex', 'http/2', 'http2', 'named events', 'event types']);
  }
  if (/客户端优化|eventsource|client-side|client optimization/.test(lower)) {
    groups.push([
      '客户端优化', 'eventsource', 'client-side', 'client optimization',
      'onmessage', 'onerror', 'close()', 'retry', 'last-event-id'
    ]);
  }
  if (/鉴权|认证|授权|authentication|authorization/.test(lower)) {
    groups.push(['鉴权', '认证', '授权', 'authentication', 'authorization', 'access token', 'cookie']);
  }
  if (/超时|timeout|超时控制/.test(lower)) {
    groups.push([
      '超时', 'timeout', 'idle timeout', 'read timeout', 'proxy_read_timeout',
      'connection timeout', 'keepalive timeout'
    ]);
  }
  if (/性能|并发优化|吞吐|performance|throughput|scalability/.test(lower)) {
    groups.push([
      '性能优化', '并发优化', '高并发', '吞吐', 'performance', 'throughput',
      'scalability', 'event loop', 'non-blocking', 'worker_connections', 'connection limit'
    ]);
  }
  if (/search_depth|搜索深度/.test(lower)) groups.push(['search_depth', '搜索深度']);
  if (/可选值|取值|枚举|allowed|enum/.test(lower)) groups.push(['basic', 'advanced']);
  if (/作用|定位|用途|purpose|role|snippet|相关性/.test(lower)) {
    if (/basic/.test(lower)) groups.push(['basic']);
    if (/advanced/.test(lower)) groups.push(['advanced']);
    groups.push(['作用', '定位', '用途', 'purpose', 'role', 'snippet', 'relevant']);
  }
  if (/计费|定价|价格|成本|积分|credits?|pricing|cost/.test(lower)) {
    if (/basic/.test(lower)) groups.push(['basic']);
    if (/advanced/.test(lower)) groups.push(['advanced']);
    groups.push(['计费', '定价', '价格', '成本', '积分', 'credit', 'pricing', 'cost']);
  }
  return groups.length ? groups : [extractAnchorTerms(text)];
}

function normalizeClaimFragment(fragment: string) {
  return fragment
    .trim()
    .replace(/^(?:包括|包含|涵盖|涉及|以及|并且|同时|及|和)\s*/i, '')
    .trim();
}

function scoreClaimEvidence(claim: WebClaim, item: ClaimEvidence) {
  const content = item.content.toLowerCase();
  const matchedGroups = claim.evidenceGroups.filter((group) =>
    group.some((term) => content.includes(term.toLowerCase()))
  ).length;
  const groupCoverage = matchedGroups / Math.max(claim.evidenceGroups.length, 1);
  const lexicalScore = lexicalRelevance(claim.text, item.content);
  const score = claim.evidenceGroups.length > 1
    ? groupCoverage * 0.75 + lexicalScore * 0.25
    : matchedGroups
      ? Math.max(lexicalScore, 0.75)
      : lexicalScore;
  return {
    item,
    score,
    matchedGroups,
    supported: matchedGroups === claim.evidenceGroups.length && score >= SUPPORT_THRESHOLD
  };
}

function extractAnchorTerms(text: string) {
  const terms = text.toLowerCase().match(/[a-z0-9_.-]{2,}|[一-鿿]{2,}/g) ?? [];
  return [...new Set(terms)].slice(0, 6);
}

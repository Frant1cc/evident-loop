import type { ToolTrace } from './types.js';

type JsonRecord = Record<string, unknown>;

export type WebCitationAuditIssue = {
  type: 'unsupported_fact' | 'missing_citation' | 'invalid_citation' | 'conflict_hidden' | 'missing_claim' | 'insufficient_detail';
  statement: string;
  claimIds: string[];
  message: string;
};

export type WebCitationAuditResult = {
  applicable: boolean;
  passed: boolean;
  issues: WebCitationAuditIssue[];
  auditedStatements: number;
};

type AuditClaim = {
  id: string;
  text: string;
  supported: boolean;
  contradicted: boolean;
  blocking: boolean;
  subjectTerms: string[];
  sourceUrls: string[];
  supportingEvidence: AuditEvidence[];
  contradictingEvidence: AuditEvidence[];
  conflict?: {
    status: 'resolved_supports' | 'resolved_contradicts' | 'unresolved';
    requiresHumanReview: boolean;
  };
};

type AuditEvidence = {
  url: string;
  evidenceQuote: string;
  authority?: string;
  publishedAt?: string;
};

export function auditWebAnswer(answer: string, toolTraces: ToolTrace[]): WebCitationAuditResult {
  const claims = collectAuditClaims(toolTraces);
  if (!claims.length) return { applicable: false, passed: true, issues: [], auditedStatements: 0 };

  const statements = extractAuditableStatements(answer);
  const issues: WebCitationAuditIssue[] = [];
  for (const statement of statements) {
    const mapped = mapStatementToClaims(statement, claims);
    const citations = extractUrls(statement);
    if (!mapped.length) {
      issues.push({
        type: 'unsupported_fact',
        statement,
        claimIds: [],
        message: 'The factual statement does not map to any retrieved Claim.'
      });
      continue;
    }

    const conflicted = mapped.filter((claim) => claim.conflict);
    if (conflicted.length) {
      const requiredUrls = conflicted.flatMap((claim) => [
        claim.supportingEvidence[0]?.url,
        claim.contradictingEvidence[0]?.url
      ]).filter((value): value is string => Boolean(value)).map(normalizeUrl);
      if (!containsConflictDisclosure(statement) || !requiredUrls.every((url) => citations.includes(url))) {
        issues.push({
          type: 'conflict_hidden',
          statement,
          claimIds: conflicted.map((claim) => claim.id),
          message: 'Every detected conflict must be disclosed and cite both the strongest supporting and contradicting sources.'
        });
      }
      if (conflicted.length === mapped.length) continue;
    }

    const ordinaryClaims = mapped.filter((claim) => !claim.conflict);
    const rejectedClaims = ordinaryClaims.filter((claim) => !claim.supported);
    if (rejectedClaims.length) {
      issues.push({
        type: 'unsupported_fact',
        statement,
        claimIds: rejectedClaims.map((claim) => claim.id),
        message: 'The statement presents an unsupported or contradicted Claim as established fact.'
      });
    }
    const positivelyAsserted = ordinaryClaims.filter((claim) => claim.supported);
    const uncitedClaims = positivelyAsserted.filter((claim) => {
      const allowed = new Set(claim.sourceUrls.map(normalizeUrl));
      return !citations.some((url) => allowed.has(url));
    });
    if (uncitedClaims.length && !citations.length) {
      issues.push({
        type: 'missing_citation',
        statement,
        claimIds: uncitedClaims.map((claim) => claim.id),
        message: 'Every factual statement must contain a citation to supporting web evidence.'
      });
      continue;
    }
    if (uncitedClaims.length) {
      issues.push({
        type: 'invalid_citation',
        statement,
        claimIds: uncitedClaims.map((claim) => claim.id),
        message: 'Each mapped Claim needs its own citation to one of its supporting URLs.'
      });
    }
  }

  for (const claim of claims.filter((item) => item.blocking)) {
    if (claimIsRepresented(answer, claim)) continue;
    issues.push({
      type: 'missing_claim',
      statement: '',
      claimIds: [claim.id],
      message: claim.supported || claim.conflict
        ? 'A user-requested Claim is absent from the final answer.'
        : 'A user-requested but uncovered Claim must be reported as unresolved instead of silently omitted.'
    });
  }

  const detailIssue = assessAnswerDetail(answer, claims, statements);
  if (detailIssue) issues.push(detailIssue);

  return {
    applicable: true,
    passed: issues.length === 0,
    issues,
    auditedStatements: statements.length
  };
}

export function buildWebAuditRevisionPrompt(
  originalAnswer: string,
  audit: WebCitationAuditResult,
  toolTraces: ToolTrace[],
  userMessage: string
) {
  const claims = collectAuditClaims(toolTraces);
  return `Revise the answer so it passes a strict Claim-Citation audit.

Rules:
- Use the same language as the user.
- Lead with a direct conclusion, then explain the key evidence in enough detail to answer the question completely. Do not merely repeat the single strongest quote.
- Every factual sentence or bullet must cite, in that same sentence, a full supporting URL from the matching Claim.
- Do not add facts that are absent from the supplied Claims and evidence quotes.
- Do not state unsupported or resolved-contradicted Claims as facts.
- For every unresolved conflict, explicitly say the evidence conflicts, avoid a definitive conclusion, and cite both the strongest supporting and contradicting URLs.
- Cover every user-requested blocking Claim. If a Claim is unsupported, explicitly say that reliable evidence was not found; never omit one side of a comparison.
- For lists, comparisons, catalogs and pricing questions, preserve every distinct entity/value pair available in the evidence quotes. Prefer a detailed Markdown table, translate explanatory labels into the user's language, and keep product names, currency and units exact.
- When supported by the evidence, include the applicable date/version/geography/unit, important differences, practical interpretation, and evidence limitations. Keep simple questions concise, but make multi-part questions report-like rather than skeletal.
- Return only the revised answer in Markdown. Do not discuss the audit.

User request:
${userMessage}

Audit issues:
${JSON.stringify(audit.issues)}

Allowed Claim-Evidence data:
${JSON.stringify(claims)}

Original answer:
${originalAnswer}`;
}

/** Safe final fallback used when the model's single revision still fails audit. */
export function buildAuditedWebFallback(toolTraces: ToolTrace[], userMessage: string) {
  const claims = collectAuditClaims(toolTraces);
  const chinese = /[\u4e00-\u9fff]/u.test(userMessage);
  const rows: string[] = [];
  for (const claim of claims) {
    if (claim.conflict) {
      const support = claim.supportingEvidence[0];
      const contradict = claim.contradictingEvidence[0];
      if (support && contradict) {
        const resolution = claim.conflict.status === 'resolved_supports'
          ? (chinese ? '系统按证据等级暂采信支持侧，但仍保留分歧' : 'the support side currently wins by evidence rank, but the disagreement remains visible')
          : claim.conflict.status === 'resolved_contradicts'
            ? (chinese ? '系统按证据等级暂采信反向证据，不作肯定结论' : 'the contradicting side currently wins by evidence rank, so no positive conclusion is made')
            : (chinese ? '暂不能下确定结论' : 'no definitive conclusion is available');
        rows.push(chinese
          ? `- 关于“${claim.text}”，现有证据相互冲突，${resolution}：支持证据“${shorten(support.evidenceQuote)}”[来源](${support.url})；反向证据“${shorten(contradict.evidenceQuote)}”[来源](${contradict.url})。`
          : `- Evidence for “${claim.text}” conflicts; ${resolution}: supporting evidence “${shorten(support.evidenceQuote)}” [source](${support.url}); contradicting evidence “${shorten(contradict.evidenceQuote)}” [source](${contradict.url}).`);
      }
      continue;
    }
    if (!claim.supported) {
      if (claim.blocking) rows.push(chinese
        ? `- 关于“${claim.text}”，本轮检索未形成可通过引用校验的可靠证据，暂不猜测。`
        : `- For “${claim.text}”, this search did not produce reliable evidence that passed citation validation, so no value is guessed.`);
      continue;
    }
    const evidenceRows = claim.supportingEvidence
      .filter((evidence) => evidence.url)
      .slice(0, 8)
      .map((evidence) => chinese
        ? `  - ${localizeEvidenceQuote(evidence.evidenceQuote)}。[来源](${evidence.url})`
        : `  - ${trimTerminalPunctuation(shorten(evidence.evidenceQuote)) || 'Retrieved supporting evidence'}. [source](${evidence.url})`);
    if (!evidenceRows.length && claim.sourceUrls[0]) {
      evidenceRows.push(chinese
        ? `  - 已检索到支持性材料。[来源](${claim.sourceUrls[0]})`
        : `  - Retrieved supporting evidence. [source](${claim.sourceUrls[0]})`);
    }
    if (!evidenceRows.length) continue;
    rows.push(chinese
      ? `- 关于“${claim.text}”\n${evidenceRows.join('\n')}`
      : `- For “${claim.text}”\n${evidenceRows.join('\n')}`);
  }
  if (rows.length) {
    return chinese
      ? `以下仅保留通过引用校验的结果：\n\n${rows.join('\n')}`
      : `Only citation-verified results are retained below:\n\n${rows.join('\n')}`;
  }
  return chinese
    ? '联网检索未形成能够通过 Claim–Citation 校验的结论，因此不输出未经证据支持的事实。'
    : 'The web search produced no conclusion that passed Claim-Citation validation, so no unsupported factual answer is shown.';
}

function collectAuditClaims(toolTraces: ToolTrace[]): AuditClaim[] {
  const byId = new Map<string, AuditClaim>();
  for (const trace of toolTraces) {
    if (trace.name !== 'retrieve_web_evidence' || !isRecord(trace.result)) continue;
    for (const raw of arrayRecords(trace.result.claims)) {
      const id = typeof raw.id === 'string' ? raw.id : '';
      const text = typeof raw.text === 'string' ? raw.text : '';
      if (!id || !text) continue;
      const rawConflict = isRecord(raw.conflict) ? raw.conflict : undefined;
      byId.set(id, {
        id,
        text,
        supported: raw.supported === true,
        contradicted: raw.contradicted === true,
        blocking: raw.blocking !== false,
        subjectTerms: stringArray(raw.subjectTerms),
        sourceUrls: stringArray(raw.sourceUrls),
        supportingEvidence: evidenceArray(raw.supportingEvidence),
        contradictingEvidence: evidenceArray(raw.contradictingEvidence),
        ...(rawConflict && isConflictStatus(rawConflict.status) ? {
          conflict: {
            status: rawConflict.status,
            requiresHumanReview: rawConflict.requiresHumanReview === true
          }
        } : {})
      });
    }
  }
  return [...byId.values()];
}

function extractAuditableStatements(answer: string) {
  const withoutCode = answer.replace(/```[\s\S]*?```/g, '');
  return withoutCode
    .split(/(?<=[。！？；!?])\s*|(?<=\.)\s+(?=[A-Z\u4e00-\u9fff])|\n+/u)
    .map((value) => value.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, '').trim())
    .filter((value) => value.length >= 8)
    .filter((value) => !/^#{1,6}\s/.test(value))
    .filter((value) => !isOnlySourcesOrLimitation(value))
    .filter(looksFactual);
}

function assessAnswerDetail(
  answer: string,
  claims: AuditClaim[],
  statements: string[]
): WebCitationAuditIssue | undefined {
  const blocking = claims.filter((claim) => claim.blocking);
  const supported = blocking.filter((claim) => claim.supported || claim.conflict);
  const evidenceCount = new Set(supported.flatMap((claim) => claim.supportingEvidence
    .filter((evidence) => evidence.evidenceQuote.trim())
    .map((evidence) => evidence.evidenceQuote.replace(/\s+/g, ' ').trim().toLowerCase()))).size;
  const richRequest = blocking.length > 1
    || evidenceCount >= 3
    || blocking.some((claim) => /比较|对比|分别|清单|列表|哪些|区别|差异|优缺点|推荐|价格|价钱|定价|费用|收费|compare|comparison|versus|\bvs\.?\b|list|catalog|pricing|price/iu.test(claim.text));
  if (!richRequest || !supported.length) return undefined;

  const prose = answer
    .replace(/https?:\/\/[^\s)\]]+/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[#*_>`|:\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const structuredRows = answer.split('\n').filter((line) => {
    const value = line.trim();
    if (/^\|?\s*:?-{3,}/.test(value)) return false;
    return (/^[-*+]\s+/.test(value) || /^\|.*\|$/.test(value))
      && value.replace(/https?:\/\/[^\s)\]]+/g, '').length >= 12;
  }).length;
  const detailUnits = Math.max(statements.length, structuredRows);
  const minimumUnits = evidenceCount >= 3 || supported.length >= 2 ? 3 : 2;
  const minimumChars = /[\u4e00-\u9fff]/u.test(prose) ? 80 : 140;
  if (detailUnits >= minimumUnits && prose.length >= minimumChars) return undefined;

  return {
    type: 'insufficient_detail',
    statement: '',
    claimIds: supported.map((claim) => claim.id),
    message: 'The answer is citation-valid but too skeletal for the available multi-part evidence. Expand it with a direct conclusion, the supported details, comparison/context, and limitations without adding unsupported facts.'
  };
}

function looksFactual(value: string) {
  const prose = value.replace(/https?:\/\/[^\s)\]]+/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').trim();
  if (prose.length < 5) return false;
  return /\d|(?:\b(?:is|are|was|were|has|have|supports?|requires?|released?|announced?|includes?|uses?|provides?)\b)|(?:是|为|有|支持|要求|发布|宣布|包括|采用|提供|达到|增长|下降|位于|成立)/iu.test(prose);
}

function isOnlySourcesOrLimitation(value: string) {
  return /^(?:参考来源|来源|sources?|references?)\s*[:：]?/iu.test(value)
    || /^(?:未找到|无法确认|证据不足|暂无可靠证据|no reliable evidence|insufficient evidence)/iu.test(value);
}

function mapStatementToClaims(statement: string, claims: AuditClaim[]) {
  const statementTokens = tokens(statement);
  return claims
    .map((claim) => ({
      claim,
      score: Math.max(
        overlapScore(statementTokens, tokens(claim.text)),
        ...claim.supportingEvidence.map((evidence) => overlapScore(statementTokens, tokens(evidence.evidenceQuote))),
        ...claim.contradictingEvidence.map((evidence) => overlapScore(statementTokens, tokens(evidence.evidenceQuote)))
      )
    }))
    .filter((item) => item.score >= 0.18)
    .sort((left, right) => right.score - left.score)
    .filter((item, index, values) => index === 0 || item.score >= values[0]!.score * 0.8)
    .map((item) => item.claim);
}

function claimIsRepresented(answer: string, claim: AuditClaim) {
  const normalizedAnswer = answer.normalize('NFKC').toLowerCase();
  if (claim.subjectTerms.length && !claim.subjectTerms.some((term) =>
    normalizedAnswer.includes(term.normalize('NFKC').toLowerCase())
  )) return false;
  const answerTokens = tokens(answer);
  const claimScore = overlapScore(answerTokens, tokens(claim.text));
  const evidenceScore = Math.max(
    0,
    ...claim.supportingEvidence.map((evidence) => overlapScore(answerTokens, tokens(evidence.evidenceQuote))),
    ...claim.contradictingEvidence.map((evidence) => overlapScore(answerTokens, tokens(evidence.evidenceQuote)))
  );
  return Math.max(claimScore, evidenceScore) >= 0.18;
}

function tokens(value: string) {
  const normalized = value.normalize('NFKC').toLowerCase().replace(/https?:\/\/[^\s)\]]+/g, ' ');
  const latin = normalized.match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  const chinese = (normalized.match(/[\u4e00-\u9fff]+/gu) ?? [])
    .flatMap((run) => run.length === 1 ? [run] : [...Array(run.length - 1)].map((_, index) => run.slice(index, index + 2)));
  return new Set([...latin, ...chinese].filter((token) => token.length > 1));
}

function overlapScore(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of right) if (left.has(token)) overlap += 1;
  return overlap / right.size;
}

function extractUrls(value: string) {
  return [...new Set((value.match(/https?:\/\/[^\s)\]>,，。；]+/g) ?? []).map(normalizeUrl))];
}

function normalizeUrl(value: string) {
  try { return new URL(value).toString(); } catch { return value; }
}

function containsConflictDisclosure(value: string) {
  return /(?:冲突|矛盾|说法不一|无法确定|不能下确定结论|conflict|contradict|disagree|inconclusive)/iu.test(value);
}

function evidenceArray(value: unknown): AuditEvidence[] {
  return arrayRecords(value).flatMap((item) => typeof item.url === 'string' ? [{
    url: item.url,
    evidenceQuote: typeof item.evidenceQuote === 'string' ? item.evidenceQuote : '',
    ...(typeof item.authority === 'string' ? { authority: item.authority } : {}),
    ...(typeof item.publishedAt === 'string' ? { publishedAt: item.publishedAt } : {})
  }] : []);
}

function isConflictStatus(value: unknown): value is NonNullable<AuditClaim['conflict']>['status'] {
  return value === 'resolved_supports' || value === 'resolved_contradicts' || value === 'unresolved';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function shorten(value: string, maxChars = 240) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function localizeEvidenceQuote(value: string) {
  const normalized = shorten(value, 600)
    .replace(/\bCached Input\b/giu, '缓存输入')
    .replace(/\bCached input\b/giu, '缓存输入')
    .replace(/\bInput\b/giu, '输入')
    .replace(/\bOutput\b/giu, '输出')
    .replace(/\bPricing\b/giu, '定价')
    .replace(/\bPrice\b/giu, '价格')
    .replace(/\bPer 1M tokens\b/giu, '每百万 Token')
    .replace(/\b1M tokens\b/giu, '百万 Token')
    .replace(/\s+/g, ' ')
    .trim();
  return trimTerminalPunctuation(normalized) || '已检索到支持性材料';
}

function trimTerminalPunctuation(value: string) {
  return value.replace(/[.。!?！？；;]+$/u, '').trim();
}

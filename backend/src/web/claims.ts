import type { EvidenceJudgment } from './evidenceJudge.js';
import { fallbackEvidencePlan, type PlannedWebClaim } from './evidencePlanner.js';
import { lexicalRelevance } from './quality.js';
import { sourceCanSupportClaim } from './sourcePolicy.js';

export type WebClaim = PlannedWebClaim & {
  /** Present only for evaluator-supplied, exact evidence requirements. */
  evidenceGroups?: string[][];
};

export type ClaimEvidence = {
  content: string;
  url: string;
  chunkIndex?: number;
  judgments?: EvidenceJudgment[];
  authority?: 'official' | 'third_party' | 'unverified';
  publishedAt?: string;
  freshnessStatus?: 'matched' | 'outside_window' | 'unknown' | 'future_date' | 'not_required';
};

export type ClaimEvidenceReference = {
  url: string;
  relation: 'supports' | 'contradicts';
  confidence: number;
  evidenceQuote: string;
  authority: 'official' | 'third_party' | 'unverified';
  publishedAt?: string;
  freshnessStatus?: ClaimEvidence['freshnessStatus'];
};

export type ClaimConflict = {
  claimId: string;
  claimText: string;
  status: 'resolved_supports' | 'resolved_contradicts' | 'unresolved';
  reason: string;
  supportingEvidence: ClaimEvidenceReference[];
  contradictingEvidence: ClaimEvidenceReference[];
  highRisk: boolean;
  requiresHumanReview: boolean;
};

export type ClaimAssessment = WebClaim & {
  score: number;
  supported: boolean;
  contradicted: boolean;
  matchedGroups: number;
  totalGroups: number;
  sourceUrls: string[];
  subjectMatched: boolean;
  subjectMismatchUrls: string[];
  supportingEvidence: ClaimEvidenceReference[];
  contradictingEvidence: ClaimEvidenceReference[];
  conflict?: ClaimConflict;
};

export type ClaimCoverage = {
  claims: ClaimAssessment[];
  coverageScore: number;
  supportedClaimRatio: number;
  uncoveredClaims: string[];
  uncoveredBlockingClaims: string[];
  supportedBlockingClaimRatio: number;
  blockingClaimCount: number;
  blockingCoverageScore: number;
  subjectConsistencyRate: number;
  subjectMismatchUrls: string[];
  conflicts: ClaimConflict[];
};

const SUPPORT_THRESHOLD = 0.65;

/** Generic no-LLM fallback retained for offline operation and deterministic tests. */
export function extractWebClaims(question: string): WebClaim[] {
  return fallbackEvidencePlan(question).claims;
}

export function assessClaimCoverage(claims: WebClaim[], evidence: ClaimEvidence[]): ClaimCoverage {
  const assessments = claims.map((claim): ClaimAssessment => {
    const matches = evidence
      .map((item) => scoreClaimEvidence(claim, item))
      .filter((match) => match.score > 0 || match.contradicted)
      .sort((left, right) => right.score - left.score);
    const best = matches[0];
    const supportingEvidence = uniqueEvidenceReferences(matches
      .filter((match) => match.supported)
      .map((match) => match.reference));
    const contradictingEvidence = uniqueEvidenceReferences(matches
      .filter((match) => match.contradicted)
      .map((match) => match.reference));
    const conflict = supportingEvidence.length && contradictingEvidence.length
      ? resolveClaimConflict(claim, supportingEvidence, contradictingEvidence)
      : undefined;
    const highRiskNeedsCorroboration = isHighRiskClaim(claim.text)
      && independentDomains(supportingEvidence) < 2;
    const supported = supportingEvidence.length > 0
      && !highRiskNeedsCorroboration
      && conflict?.status !== 'unresolved'
      && conflict?.status !== 'resolved_contradicts';
    return {
      ...claim,
      score: best?.score ?? 0,
      matchedGroups: best?.matchedGroups ?? 0,
      totalGroups: claim.evidenceGroups?.length ?? 1,
      supported,
      contradicted: contradictingEvidence.length > 0,
      sourceUrls: supported ? supportingEvidence.map((item) => item.url) : [],
      subjectMatched: Boolean(best?.subjectMatched),
      subjectMismatchUrls: [...new Set(matches
        .filter((match) => match.hasRelevantSignal && !match.subjectMatched)
        .map((match) => match.item.url))],
      supportingEvidence,
      contradictingEvidence,
      ...(conflict ? { conflict } : {})
    };
  });

  const supported = assessments.filter((claim) => claim.supported).length;
  const blocking = assessments.filter((claim) => claim.blocking !== false);
  const supportedBlocking = blocking.filter((claim) => claim.supported).length;
  const judgedEvidence = evidence.filter((item) => item.judgments?.length);
  const consistentEvidence = judgedEvidence.filter((item) => item.judgments?.some((judgment) => judgment.subjectMatched));
  return {
    claims: assessments,
    coverageScore: assessments.length
      ? assessments.reduce((total, claim) => total + claim.score, 0) / assessments.length
      : 0,
    supportedClaimRatio: assessments.length ? supported / assessments.length : 0,
    uncoveredClaims: assessments.filter((claim) => !claim.supported).map((claim) => claim.text),
    uncoveredBlockingClaims: blocking.filter((claim) => !claim.supported).map((claim) => claim.text),
    supportedBlockingClaimRatio: blocking.length ? supportedBlocking / blocking.length : 1,
    blockingClaimCount: blocking.length,
    blockingCoverageScore: blocking.length
      ? blocking.reduce((total, claim) => total + claim.score, 0) / blocking.length
      : 1,
    subjectConsistencyRate: judgedEvidence.length ? consistentEvidence.length / judgedEvidence.length : 1,
    subjectMismatchUrls: [...new Set(assessments.flatMap((claim) => claim.subjectMismatchUrls))],
    conflicts: assessments.flatMap((claim) => claim.conflict ? [claim.conflict] : [])
  };
}

export function contentMatchesClaimSubject(claim: WebClaim, content: string) {
  const normalized = content.toLowerCase();
  return !claim.subjectTerms.length || claim.subjectTerms.some((term) => normalized.includes(term.toLowerCase()));
}

function scoreClaimEvidence(claim: WebClaim, item: ClaimEvidence) {
  const authorityMatched = sourceCanSupportClaim(claim, item.url);
  const judgments = item.judgments?.filter((judgment) => judgment.claimId === claim.id) ?? [];
  const strongestJudgment = [...judgments].sort((left, right) => right.confidence - left.confidence)[0];
  if (strongestJudgment) {
    const supported = strongestJudgment.relation === 'supports'
      && strongestJudgment.subjectMatched
      && authorityMatched
      && strongestJudgment.confidence >= SUPPORT_THRESHOLD;
    return {
      item,
      score: supported ? strongestJudgment.confidence : 0,
      matchedGroups: supported ? 1 : 0,
      subjectMatched: strongestJudgment.subjectMatched && authorityMatched,
      supported,
      contradicted: strongestJudgment.relation === 'contradicts' && strongestJudgment.confidence >= SUPPORT_THRESHOLD,
      hasRelevantSignal: strongestJudgment.relation !== 'irrelevant',
      reference: toEvidenceReference(item, strongestJudgment)
    };
  }
  if (item.judgments?.length) {
    return {
      item,
      score: 0,
      matchedGroups: 0,
      subjectMatched: false,
      supported: false,
      contradicted: false,
      hasRelevantSignal: false,
      reference: emptyEvidenceReference(item)
    };
  }

  const content = item.content.toLowerCase();
  const subjectMatched = contentMatchesClaimSubject(claim, item.content) && authorityMatched;
  if (claim.evidenceGroups?.length) {
    const matchedGroups = claim.evidenceGroups.filter((group) =>
      group.some((term) => content.includes(term.toLowerCase()))
    ).length;
    const groupCoverage = matchedGroups / claim.evidenceGroups.length;
    const score = subjectMatched ? groupCoverage : groupCoverage * 0.25;
    return {
      item,
      score,
      matchedGroups,
      subjectMatched,
      supported: subjectMatched && matchedGroups === claim.evidenceGroups.length && score >= SUPPORT_THRESHOLD,
      contradicted: false,
      hasRelevantSignal: matchedGroups > 0,
      reference: emptyEvidenceReference(item)
    };
  }

  const score = lexicalRelevance(`${claim.text} ${claim.searchQueries.join(' ')}`, item.content);
  return {
    item,
    score: subjectMatched ? score : score * 0.25,
    matchedGroups: score >= SUPPORT_THRESHOLD ? 1 : 0,
    subjectMatched,
    supported: subjectMatched && score >= 0.72,
    contradicted: false,
    hasRelevantSignal: score > 0,
    reference: emptyEvidenceReference(item)
  };
}

function toEvidenceReference(item: ClaimEvidence, judgment: EvidenceJudgment): ClaimEvidenceReference {
  return {
    url: item.url,
    relation: judgment.relation === 'contradicts' ? 'contradicts' : 'supports',
    confidence: judgment.confidence,
    evidenceQuote: judgment.evidenceQuote,
    authority: item.authority ?? 'unverified',
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.freshnessStatus ? { freshnessStatus: item.freshnessStatus } : {})
  };
}

function emptyEvidenceReference(item: ClaimEvidence): ClaimEvidenceReference {
  return {
    url: item.url,
    relation: 'supports',
    confidence: 0,
    evidenceQuote: '',
    authority: item.authority ?? 'unverified',
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.freshnessStatus ? { freshnessStatus: item.freshnessStatus } : {})
  };
}

function uniqueEvidenceReferences(values: ClaimEvidenceReference[]) {
  const byKey = new Map<string, ClaimEvidenceReference>();
  for (const value of values) {
    const key = `${value.relation}:${value.url}:${value.evidenceQuote}`;
    const current = byKey.get(key);
    if (!current || value.confidence > current.confidence) byKey.set(key, value);
  }
  return [...byKey.values()].sort(compareEvidenceStrength);
}

function resolveClaimConflict(
  claim: WebClaim,
  supportingEvidence: ClaimEvidenceReference[],
  contradictingEvidence: ClaimEvidenceReference[]
): ClaimConflict {
  const support = supportingEvidence[0]!;
  const contradict = contradictingEvidence[0]!;
  const highRisk = isHighRiskClaim(claim.text);
  const comparison = compareEvidenceStrength(support, contradict);
  let status: ClaimConflict['status'] = comparison < 0 ? 'resolved_supports'
    : comparison > 0 ? 'resolved_contradicts'
      : 'unresolved';
  let reason = status === 'unresolved'
    ? 'The strongest supporting and contradicting evidence have equal authority, freshness and confidence.'
    : status === 'resolved_supports'
      ? 'Supporting evidence outranks contradicting evidence by authority, publication time or confidence.'
      : 'Contradicting evidence outranks supporting evidence by authority, publication time or confidence.';

  if (highRisk) {
    const winningEvidence = status === 'resolved_supports' ? supportingEvidence
      : status === 'resolved_contradicts' ? contradictingEvidence
        : [];
    if (independentDomains(winningEvidence) < 2) {
      status = 'unresolved';
      reason = 'High-risk claims require corroboration from at least two independent domains before a conflict can be resolved automatically.';
    }
  }

  return {
    claimId: claim.id,
    claimText: claim.text,
    status,
    reason,
    supportingEvidence,
    contradictingEvidence,
    highRisk,
    requiresHumanReview: status === 'unresolved'
  };
}

/** Negative means left is stronger, positive means right is stronger. */
function compareEvidenceStrength(left: ClaimEvidenceReference, right: ClaimEvidenceReference) {
  const authority = authorityRank(right.authority) - authorityRank(left.authority);
  if (authority) return authority;
  const leftDate = parsedDate(left.publishedAt);
  const rightDate = parsedDate(right.publishedAt);
  if (leftDate !== rightDate && leftDate !== 0 && rightDate !== 0) return rightDate - leftDate;
  const confidence = right.confidence - left.confidence;
  return Math.abs(confidence) >= 0.15 ? confidence : 0;
}

function authorityRank(value: ClaimEvidenceReference['authority']) {
  return value === 'official' ? 3 : value === 'third_party' ? 2 : 1;
}

function parsedDate(value?: string) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function independentDomains(values: ClaimEvidenceReference[]) {
  return new Set(values.map((item) => {
    try { return new URL(item.url).hostname.toLowerCase(); } catch { return item.url; }
  })).size;
}

function isHighRiskClaim(text: string) {
  return /(?:medical|clinical|diagnos|treatment|medicine|legal|law|regulation|compliance|financial|investment|trading|医疗|临床|诊断|治疗|药物|法律|法规|合规|金融|投资|证券|交易)/iu.test(text);
}

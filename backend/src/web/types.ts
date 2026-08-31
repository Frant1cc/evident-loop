import type { RagSource } from '../rag/types.js';
import type { WebSearchResult } from '../tools/webSearchTool.js';
import type { ClaimAssessment, ClaimConflict } from './claims.js';
import type { WebEvidencePlan } from './evidencePlanner.js';
import type { EvidenceEntity } from './evidenceEntities.js';

export type WebRetrievalVerdict = 'sufficient' | 'weak' | 'empty' | 'exhausted';
export type SearchQualityVerdict = 'sufficient' | 'weak' | 'empty';
export type PageQualityVerdict = 'sufficient' | 'weak' | 'irrelevant' | 'unreadable';
export type RetrievalCapability = 'web_search' | 'web_fetch' | 'docs_search' | 'vertical_search';
export type VerticalDomain = 'academic' | 'security' | 'finance' | 'legal' | 'code';

export type IntentSignal = {
  matched: boolean;
  confidence: number;
  reasons: string[];
};

export type RetrievalIntent = {
  routerVersion: string;
  urls: string[];
  requiredCapabilities: RetrievalCapability[];
  knownUrl: IntentSignal;
  pdf: IntentSignal;
  officialDocs: IntentSignal;
  freshness: IntentSignal;
  chineseLanguage: IntentSignal;
  chinaDomestic: IntentSignal;
  dynamicPage: IntentSignal;
  verification: IntentSignal;
  vertical: IntentSignal & { domains: VerticalDomain[] };
};

export type ProviderCandidate = {
  provider: string;
  score: number;
  configured: boolean;
  reasons: string[];
};

export type ProviderRoute = {
  capability: RetrievalCapability;
  candidates: ProviderCandidate[];
};

export type ProviderAttemptStatus =
  | 'success'
  | 'empty'
  | 'low_quality'
  | 'timeout'
  | 'rate_limited'
  | 'auth_error'
  | 'provider_error'
  | 'skipped';

export type ProviderAttempt = {
  capability: RetrievalCapability;
  provider: string;
  status: ProviderAttemptStatus;
  durationMs: number;
  resultCount: number;
  reason?: string;
};

export type RetrievalQueryRoute = {
  policyVersion: string;
  strategy: 'direct_fetch' | 'fetch_then_verify' | 'official_docs_first' | 'vertical_first' | 'china_current_first' | 'current_web_first' | 'general_web';
  searchRequired: boolean;
  directFetchUrls: string[];
  initialQueries: string[];
  /** Authoritative domains to constrain the first search without restricting later fallback searches. */
  preferredDomains?: string[];
  inferredTimeRange?: 'day' | 'week' | 'month' | 'year';
  providerRoutes: ProviderRoute[];
  reasons: string[];
};

export type ScoredWebSearchResult = WebSearchResult & {
  canonicalUrl: string;
  domain: string;
  providerScore: number;
  lexicalScore: number;
  completenessScore: number;
  finalScore: number;
  releaseTier?: 0 | 1 | 2 | 3 | 4;
  titleExactMatch?: boolean;
  urlEntityMatch?: boolean;
  directReleaseMatch?: boolean;
};

export type ScoredPageChunk = {
  index: number;
  content: string;
  lexicalScore: number;
  finalScore: number;
  pageTitle?: string;
  canonicalUrl?: string;
  domain?: string;
  publishedAt?: string;
  pageEntityCandidates?: string[];
};

export type QueryAttempt = {
  query: string;
  searchDepth: 'basic' | 'advanced';
  verdict: SearchQualityVerdict;
  topScore?: number;
  resultCount: number;
  selectedUrls: string[];
  provider?: string;
};

export type PageAttempt = {
  url: string;
  title: string;
  domain: string;
  verdict: PageQualityVerdict;
  score: number;
  selectedChunkCount: number;
  error?: string;
  provider?: string;
  subjectConsistencyScore?: number;
  subjectMismatch?: boolean;
  authority?: 'official' | 'third_party' | 'unverified';
  publishedAt?: string;
  freshnessStatus?: 'matched' | 'outside_window' | 'unknown' | 'future_date' | 'not_required';
  exactEntityMatch?: boolean;
  evidenceStrength?: 'direct' | 'indirect';
  entityCandidates?: string[];
};

export type WebRetrievalDiagnostics = {
  queriesUsed: number;
  pagesFetched: number;
  queryBudget: number;
  pageBudget: number;
  fetchAttemptBudget?: number;
  acceptedPages?: number;
  rejectedPages?: number;
  recoveryTriggered?: boolean;
  recoveryQueriesUsed?: number;
  planningFailure?: WebEvidencePlan['planningFailure'];
  budgetExhaustedBy?: 'queries' | 'pages' | 'page-attempts' | 'queries-and-pages' | 'queries-and-page-attempts';
  independentDomains: number;
  durationMs: number;
  stopReason: string;
  providerAttempts: ProviderAttempt[];
  providersUsed: string[];
  fallbackUsed: boolean;
  subjectConsistencyRate?: number;
  subjectMismatchUrls?: string[];
  authorityRejectedUrls?: string[];
  freshnessRejectedUrls?: string[];
  undatedThirdPartyUrls?: string[];
};

export type WebRetrievalResult = {
  question: string;
  evidencePlan: WebEvidencePlan;
  intent: RetrievalIntent;
  queryRoute: RetrievalQueryRoute;
  verdict: WebRetrievalVerdict;
  score: number;
  retrievalQueries: string[];
  queryAttempts: QueryAttempt[];
  pageAttempts: PageAttempt[];
  sources: RagSource[];
  claims: ClaimAssessment[];
  /** Automatically governed support/contradiction conflicts. Present on current retrieval results. */
  conflicts?: ClaimConflict[];
  coverageScore: number;
  coveredClaimCount: number;
  totalClaimCount: number;
  uncoveredClaims: string[];
  uncoveredBlockingClaims: string[];
  evidenceEntities: EvidenceEntity[];
  requiredMentions: EvidenceEntity[];
  diagnostics: WebRetrievalDiagnostics;
};

/** Optional, caller-supplied facts that define what “enough evidence” means. */
export type RequiredEvidenceNeed = {
  id: string;
  label: string;
  groups: string[][];
};

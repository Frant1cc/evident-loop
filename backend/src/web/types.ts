import type { RagSource } from '../rag/types.js';
import type { WebSearchResult } from '../tools/webSearchTool.js';
import type { ClaimAssessment } from './claims.js';

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
};

export type ScoredPageChunk = {
  index: number;
  content: string;
  lexicalScore: number;
  finalScore: number;
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
};

export type WebRetrievalDiagnostics = {
  queriesUsed: number;
  pagesFetched: number;
  queryBudget: number;
  pageBudget: number;
  budgetExhaustedBy?: 'queries' | 'pages' | 'queries-and-pages';
  independentDomains: number;
  durationMs: number;
  stopReason: string;
  providerAttempts: ProviderAttempt[];
  providersUsed: string[];
  fallbackUsed: boolean;
  subjectConsistencyRate?: number;
  subjectMismatchUrls?: string[];
};

export type WebRetrievalResult = {
  question: string;
  intent: RetrievalIntent;
  queryRoute: RetrievalQueryRoute;
  verdict: WebRetrievalVerdict;
  score: number;
  retrievalQueries: string[];
  queryAttempts: QueryAttempt[];
  pageAttempts: PageAttempt[];
  sources: RagSource[];
  claims: ClaimAssessment[];
  coverageScore: number;
  coveredClaimCount: number;
  totalClaimCount: number;
  uncoveredClaims: string[];
  diagnostics: WebRetrievalDiagnostics;
};

/** Optional, caller-supplied facts that define what “enough evidence” means. */
export type RequiredEvidenceNeed = {
  id: string;
  label: string;
  groups: string[][];
};

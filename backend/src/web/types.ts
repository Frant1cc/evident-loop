import type { RagSource } from '../rag/types.js';
import type { WebSearchResult } from '../tools/webSearchTool.js';
import type { ClaimAssessment } from './claims.js';

export type WebRetrievalVerdict = 'sufficient' | 'weak' | 'empty' | 'exhausted';
export type SearchQualityVerdict = 'sufficient' | 'weak' | 'empty';
export type PageQualityVerdict = 'sufficient' | 'weak' | 'irrelevant' | 'unreadable';

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
};

export type PageAttempt = {
  url: string;
  title: string;
  domain: string;
  verdict: PageQualityVerdict;
  score: number;
  selectedChunkCount: number;
  error?: string;
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
};

export type WebRetrievalResult = {
  question: string;
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

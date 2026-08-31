import type {
  ProviderCandidate,
  ProviderRoute,
  RetrievalCapability,
  RetrievalIntent,
  RetrievalQueryRoute
} from './types.js';

type RouteInput = {
  question: string;
  explicitTimeRange?: 'day' | 'week' | 'month' | 'year';
  includeDomains?: string[];
  plannedPreferredDomains?: string[];
};

type ProviderProfile = {
  id: string;
  capability: RetrievalCapability;
  baseScore: number;
  configured: () => boolean;
};

const profiles: ProviderProfile[] = [
  { id: 'native-fetch', capability: 'web_fetch', baseScore: 80, configured: () => true },
  { id: 'jina', capability: 'web_fetch', baseScore: 60, configured: () => Boolean(process.env.JINA_API_KEY) },
  { id: 'firecrawl-fetch', capability: 'web_fetch', baseScore: 40, configured: () => Boolean(process.env.FIRECRAWL_API_KEY) },
  { id: 'tavily', capability: 'web_search', baseScore: 60, configured: () => Boolean(process.env.TAVILY_API_KEY) },
  { id: 'zhipu', capability: 'web_search', baseScore: 50, configured: () => Boolean(process.env.ZHIPU_API_KEY) },
  { id: 'firecrawl-search', capability: 'web_search', baseScore: 30, configured: () => Boolean(process.env.FIRECRAWL_API_KEY) },
  { id: 'context7', capability: 'docs_search', baseScore: 70, configured: () => Boolean(process.env.CONTEXT7_API_KEY) },
  { id: 'exa', capability: 'docs_search', baseScore: 55, configured: () => Boolean(process.env.EXA_API_KEY) }
];

const capabilityPreference: Record<RetrievalCapability, string[]> = {
  web_search: ['zhipu', 'tavily', 'firecrawl-search'],
  docs_search: ['context7', 'exa'],
  web_fetch: ['native-fetch', 'jina', 'firecrawl-fetch'],
  vertical_search: []
};

export function buildRetrievalQueryRoute(intent: RetrievalIntent, input: RouteInput): RetrievalQueryRoute {
  const searchRequired = !intent.knownUrl.matched || intent.verification.matched;
  const inferredTimeRange = input.explicitTimeRange ?? inferTimeRange(intent);
  const initialQuery = searchRequired ? buildInitialQuery(intent, input.question) : undefined;
  const providerRoutes = intent.requiredCapabilities.map((capability) => routeCapability(capability, intent));
  const preferredDomains = input.plannedPreferredDomains ?? [];

  return {
    policyVersion: 'provider-routing-v1',
    strategy: intent.knownUrl.matched
      ? intent.verification.matched ? 'fetch_then_verify' : 'direct_fetch'
      : intent.officialDocs.matched ? 'official_docs_first'
      : intent.vertical.matched && intent.vertical.confidence >= 0.8 ? 'vertical_first'
      : intent.chinaDomestic.matched && intent.freshness.matched ? 'china_current_first'
      : inferredTimeRange ? 'current_web_first'
      : 'general_web',
    searchRequired,
    directFetchUrls: intent.urls,
    initialQueries: initialQuery ? [initialQuery] : [],
    ...(preferredDomains.length ? { preferredDomains } : {}),
    ...(inferredTimeRange ? { inferredTimeRange } : {}),
    providerRoutes,
    reasons: buildRouteReasons(intent, input)
  };
}

function routeCapability(capability: RetrievalCapability, intent: RetrievalIntent): ProviderRoute {
  const preference = capabilityPreference[capability];
  const candidates = profiles
    .filter((profile) => profile.capability === capability)
    .map((profile) => scoreProvider(profile, intent))
    .sort((left, right) => right.score - left.score
      || preference.indexOf(left.provider) - preference.indexOf(right.provider));
  return { capability, candidates };
}

function scoreProvider(profile: ProviderProfile, intent: RetrievalIntent): ProviderCandidate {
  let score = profile.baseScore;
  const reasons = [`base priority ${profile.baseScore}`];

  if (profile.id === 'native-fetch') {
    if (intent.pdf.matched || intent.dynamicPage.matched) score -= 70;
    else reasons.push('preferred for ordinary public HTML');
  }
  if (profile.id === 'jina' && intent.pdf.matched) {
    score += 55;
    reasons.push('PDF/arXiv extraction signal');
  }
  if (profile.id === 'firecrawl-fetch' && intent.dynamicPage.matched) {
    score += 70;
    reasons.push('dynamic/browser-rendered page signal');
  }
  if (profile.id === 'zhipu' && intent.chinaDomestic.matched && intent.freshness.matched) {
    score += 50;
    reasons.push('China-domestic and freshness signals');
  } else if (profile.id === 'zhipu' && intent.chineseLanguage.matched) {
    score += 5;
    reasons.push('Chinese-language query');
  }
  if (profile.id === 'context7' && intent.officialDocs.matched) {
    score += 45;
    reasons.push('official API/SDK documentation signal');
  }
  if (profile.id === 'exa' && intent.officialDocs.matched) {
    score += 30;
    reasons.push('official low-noise source discovery');
  }
  if (profile.id === 'tavily' && intent.freshness.matched) {
    score += 15;
    reasons.push('time-sensitive general web search');
  }

  return { provider: profile.id, score, configured: profile.configured(), reasons };
}

function buildInitialQuery(intent: RetrievalIntent, question: string) {
  let query = question.replace(/https?:\/\/[^\s<>\])}"']+/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!query) return question;
  if (intent.officialDocs.matched && !/(官方|official|docs|documentation|reference)/i.test(query)) {
    query += /[\u4e00-\u9fff]/.test(query) ? ' 官方文档' : ' official documentation';
  }
  return query.slice(0, 500);
}

function inferTimeRange(intent: RetrievalIntent): RetrievalQueryRoute['inferredTimeRange'] {
  if (!intent.freshness.matched) return undefined;
  return intent.freshness.confidence >= 0.9 ? 'day' : 'month';
}

function buildRouteReasons(intent: RetrievalIntent, input: RouteInput) {
  const reasons: string[] = [];
  if (intent.knownUrl.matched) reasons.push('Explicit URLs are fetched before source discovery');
  if (intent.verification.matched) reasons.push('Verification request keeps web search enabled after direct fetch');
  if (intent.officialDocs.matched) reasons.push('Official-document signal prioritizes documentation providers');
  if (intent.chinaDomestic.matched && intent.freshness.matched) reasons.push('China/current signals prioritize domestic search');
  if (intent.vertical.matched) reasons.push(`Vertical hints: ${intent.vertical.domains.join(', ') || 'below activation threshold'}`);
  if (input.includeDomains?.length) reasons.push(`Caller constrained search to ${input.includeDomains.length} domain(s)`);
  if (input.explicitTimeRange) reasons.push(`Caller supplied explicit freshness window: ${input.explicitTimeRange}`);
  return reasons.length ? reasons : ['No specialized signal matched; use general web retrieval'];
}

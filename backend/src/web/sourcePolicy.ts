import type { PlannedWebClaim, WebEvidencePlan } from './evidencePlanner.js';

type OfficialPublisher = {
  aliases: RegExp[];
  domains: string[];
};

// This registry is source identity configuration, not question-specific Claim logic.
// Subdomains of every listed domain are accepted.
const officialPublishers: OfficialPublisher[] = [
  { aliases: [/\bopenai\b/i], domains: ['openai.com'] },
  { aliases: [/\banthropic\b/i, /\bclaude\b/i], domains: ['anthropic.com'] },
  { aliases: [/\bdeepseek\b/i], domains: ['deepseek.com'] },
  { aliases: [/\bgoogle(?: deepmind)?\b/i, /\bdeepmind\b/i, /\bgemini\b/i], domains: ['deepmind.google', 'blog.google', 'ai.google.dev'] },
  { aliases: [/\bmeta(?: ai)?\b/i, /\bllama\b/i], domains: ['ai.meta.com', 'about.fb.com', 'meta.com'] },
  { aliases: [/\bxai\b/i, /\bx\.ai\b/i, /\bgrok\b/i], domains: ['x.ai'] },
  { aliases: [/\bmistral(?: ai)?\b/i], domains: ['mistral.ai'] },
  { aliases: [/\bcohere\b/i], domains: ['cohere.com'] }
];

const announcementIntent = /(?:upcoming|next|roadmap|announce|announcement|preparing|planning|release plan|准备|即将|将要|路线图|发布计划).{0,50}(?:models?|products?|versions?|releases?|模型|产品|版本|发布)|(?:models?|products?|versions?|releases?|模型|产品|版本).{0,50}(?:upcoming|next|roadmap|announce|announcement|preparing|planning|准备|即将|将要|路线图|发布计划)/iu;

export function enforceOfficialSourcePolicy(plan: WebEvidencePlan, question: string): WebEvidencePlan {
  const questionDomains = trustedOfficialDomains(question);
  const questionNeedsOfficialAnnouncements = announcementIntent.test(question);
  const claims = plan.claims.map((claim) => {
    const claimDomains = trustedOfficialDomains([
      claim.text,
      ...claim.subjectTerms
    ].join(' '));
    const explicitlyRequiresOfficial = claim.sourceTypes.some((type) =>
      /^(?:official_announcement|official_docs|vendor_docs|release_notes)$/i.test(type)
    );
    const requiresOfficial = explicitlyRequiresOfficial
      || (questionNeedsOfficialAnnouncements && (claimDomains.length > 0 || questionDomains.length > 0));
    if (!requiresOfficial) return claim;
    // A planner-supplied domain is not automatically trusted. Unknown inferred
    // companies stay unverified instead of borrowing another company's domains.
    const preferredDomains = claimDomains.length
      ? claimDomains
      : claim.preferredDomains.length
        ? claim.preferredDomains
        : explicitlyRequiresOfficial
          ? []
          : questionDomains;
    return {
      ...claim,
      preferredDomains,
      sourceTypes: [...new Set([...claim.sourceTypes, 'official_announcement'])],
      requiredAuthority: 'official' as const
    };
  });
  const strictDomains = claims
    .filter((claim) => claim.requiredAuthority === 'official')
    .flatMap((claim) => claim.preferredDomains);
  return {
    ...plan,
    claims,
    preferredDomains: [...new Set([...plan.preferredDomains, ...strictDomains])]
  };
}

export function sourceAuthorityForClaim(claim: PlannedWebClaim, rawUrl: string) {
  if (isKnownOfficialUrl(rawUrl)) return 'official' as const;
  if (claim.requiredAuthority !== 'official') return 'unverified' as const;
  if (!claim.preferredDomains.length) return 'unverified' as const;
  return claim.preferredDomains.some((domain) => urlMatchesDomain(rawUrl, domain))
    ? 'official' as const
    : 'third_party' as const;
}

export function sourceCanSupportClaim(claim: PlannedWebClaim, rawUrl: string) {
  return claim.requiredAuthority !== 'official' || sourceAuthorityForClaim(claim, rawUrl) === 'official';
}

export function sourceAuthorityForClaims(claims: PlannedWebClaim[], rawUrl: string) {
  if (isKnownOfficialUrl(rawUrl)) return 'official' as const;
  const strict = claims.filter((claim) => claim.requiredAuthority === 'official');
  if (!strict.length) return 'unverified' as const;
  return strict.some((claim) => sourceAuthorityForClaim(claim, rawUrl) === 'official')
    ? 'official' as const
    : 'third_party' as const;
}

export function isKnownOfficialUrl(rawUrl: string) {
  return officialPublishers.some((publisher) =>
    publisher.domains.some((domain) => urlMatchesDomain(rawUrl, domain))
  );
}

export function trustedOfficialDomains(text: string) {
  return [...new Set(officialPublishers
    .filter((publisher) => publisher.aliases.some((alias) => alias.test(text)))
    .flatMap((publisher) => publisher.domains))];
}

function urlMatchesDomain(rawUrl: string, expectedDomain: string) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const domain = expectedDomain.toLowerCase().replace(/^www\./, '');
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

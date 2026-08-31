import { z } from 'zod';

import { createConfiguredLlm } from '../llm/config.js';
import type { LlmProvider } from '../llm/contracts.js';
import { resolveLlmProvider } from '../llm/provider.js';
import { lexicalRelevance } from './quality.js';
import type { WebClaim } from './claims.js';
import { extractPageEntityEvidence } from './evidenceEntities.js';

export type EvidenceRelation = 'supports' | 'contradicts' | 'irrelevant';

export type EvidenceJudgment = {
  claimId: string;
  relation: EvidenceRelation;
  confidence: number;
  chunkIndex: number;
  evidenceQuote: string;
  reason: string;
  subjectMatched: boolean;
  method: 'llm' | 'deterministic-fallback';
};

export type EvidenceJudgeOptions = {
  question: string;
  url: string;
  title: string;
  claims: WebClaim[];
  chunks: Array<{
    index: number;
    content: string;
    pageTitle?: string;
    canonicalUrl?: string;
    domain?: string;
    publishedAt?: string;
    pageEntityCandidates?: string[];
  }>;
  signal?: AbortSignal;
  llm?: LlmProvider;
};

const judgmentSchema = z.object({
  judgments: z.array(z.object({
    claimId: z.string().trim().min(1).max(80),
    relation: z.enum(['supports', 'contradicts', 'irrelevant']),
    confidence: z.number().min(0).max(1),
    chunkIndex: z.number().int().min(0),
    evidenceQuote: z.string().max(1_000).default(''),
    reason: z.string().max(500).default(''),
    subjectMatched: z.boolean()
  })).max(48)
});

const judgePrompt = `You judge whether supplied web-page chunks support atomic research claims.
Return JSON only: {"judgments":[{"claimId":"...","relation":"supports|contradicts|irrelevant","confidence":0.0,"chunkIndex":0,"evidenceQuote":"exact quote from that chunk","reason":"brief explanation","subjectMatched":true}]}.
Rules:
- Evaluate each claim independently and only against the supplied chunks.
- "supports" requires direct evidence for the claim, not merely topical similarity.
- The quote must be copied exactly from one supplied chunk. Never invent or paraphrase the quote.
- When a Claim asks for a list, comparison, catalog, pricing table, or multiple named items, return multiple supporting judgments when needed to preserve every relevant item found across the supplied chunks. Use one judgment per independently useful quote, up to eight judgments per Claim.
- For tables and repeated product cards, include the entity/model name together with its values in each quote. A bare price or number without its entity is not useful evidence.
- subjectMatched is false when the fact concerns a neighboring technology/entity rather than the claim's subject.
- General background, navigation text, and search-result boilerplate are irrelevant.
- If no chunk supports or contradicts a claim, return one irrelevant judgment for it.
- Do not use outside knowledge.`;

export async function judgeWebEvidence(options: EvidenceJudgeOptions): Promise<EvidenceJudgment[]> {
  const configured = createConfiguredLlm();
  const llm = options.llm ?? configured.llm;
  if (!llm) return fallbackJudgments(options);

  try {
    const response = await resolveLlmProvider({ llm }).complete({
      model: configured.model,
      temperature: 0,
      maxRetries: 1,
      signal: options.signal,
      messages: [
        { role: 'system', content: judgePrompt },
        {
          role: 'user',
          content: JSON.stringify({
            question: options.question,
            url: options.url,
            title: options.title,
            claims: options.claims.map(({ id, text, subjectTerms }) => ({ id, text, subjectTerms })),
            chunks: options.chunks.map(({ index, content }) => ({ index, content: content.slice(0, 8_000) }))
          })
        }
      ]
    });
    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) return fallbackJudgments(options);
    const parsed = judgmentSchema.parse(JSON.parse(stripCodeFence(content)));
    const claimIds = new Set(options.claims.map((claim) => claim.id));
    const chunks = new Map(options.chunks.map((chunk) => [chunk.index, chunk.content]));
    const exactEntityMatch = extractPageEntityEvidence({
      url: options.url,
      title: options.title,
      content: options.chunks.map((chunk) => chunk.content).join('\n'),
      claims: options.claims
    }).some((entity) => entity.exactEntityMatch);
    return parsed.judgments
      .filter((item) => claimIds.has(item.claimId) && chunks.has(item.chunkIndex))
      .map((item): EvidenceJudgment => {
        const chunk = chunks.get(item.chunkIndex) ?? '';
        const quoteIsReal = Boolean(item.evidenceQuote) && chunk.includes(item.evidenceQuote);
        const relation = item.relation !== 'irrelevant' && !quoteIsReal ? 'irrelevant' : item.relation;
        return {
          ...item,
          relation,
          confidence: relation === 'irrelevant' && item.relation !== 'irrelevant' ? 0 : item.confidence,
          evidenceQuote: quoteIsReal ? item.evidenceQuote : '',
          subjectMatched: exactEntityMatch ? true : item.subjectMatched,
          reason: exactEntityMatch
            ? `${item.reason || 'Evidence judged from page content'} Exact official release entity matched the page title and canonical URL.`
            : item.reason,
          method: 'llm'
        };
      });
  } catch {
    return fallbackJudgments(options);
  }
}

function fallbackJudgments(options: EvidenceJudgeOptions): EvidenceJudgment[] {
  const exactEntityMatch = extractPageEntityEvidence({
    url: options.url,
    title: options.title,
    content: options.chunks.map((chunk) => chunk.content).join('\n'),
    claims: options.claims
  }).some((entity) => entity.exactEntityMatch);
  return options.claims.map((claim) => {
    const ranked = options.chunks
      .map((chunk) => ({ chunk, score: lexicalRelevance(`${claim.text} ${claim.searchQueries.join(' ')}`, chunk.content) }))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const subjectMatched = exactEntityMatch || !claim.subjectTerms.length || claim.subjectTerms.some((term) =>
      best?.chunk.content.toLowerCase().includes(term.toLowerCase())
    );
    const supports = Boolean(best && best.score >= 0.68 && subjectMatched);
    return {
      claimId: claim.id,
      relation: supports ? 'supports' : 'irrelevant',
      confidence: best?.score ?? 0,
      chunkIndex: best?.chunk.index ?? options.chunks[0]?.index ?? 0,
      evidenceQuote: '',
      reason: supports ? 'Generic lexical fallback matched the claim and subject.' : 'No direct support was established without an LLM judge.',
      subjectMatched,
      method: 'deterministic-fallback'
    };
  });
}

function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

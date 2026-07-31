import type { DocumentChunk } from './types.js';

export function scoreChunk(query: string, chunk: DocumentChunk): number {
  const terms = getSearchTerms(query);
  if (!terms.length) return 0;

  const titleText = `${chunk.title} ${chunk.heading ?? ''}`.toLowerCase();
  const bodyText = chunk.content.toLowerCase();

  return terms.reduce((score, term) => {
    const titleHit = titleText.includes(term);
    const bodyHit = bodyText.includes(term);

    if (!titleHit && !bodyHit) return score;
    return score + (titleHit ? 2 : 0) + (bodyHit ? 1 : 0);
  }, 0);
}

function getSearchTerms(query: string) {
  const normalized = query.toLowerCase().trim();
  const terms = normalized.split(/\s+/).filter(Boolean);

  if (!normalized || terms.includes(normalized)) return terms;
  return [...terms, normalized];
}

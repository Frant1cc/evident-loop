/** Detects native tool-call markup leaking into plain assistant content. */
export function containsLeakedToolMarkup(text: string): boolean {
  if (text.includes('<｜')) return true;
  return /<\|{1,2}[^>]{0,60}(dsml|tool[▁_\- ]?call|invoke)/i.test(text);
}

/** Keeps prose before the first leaked markup tag and removes the protocol payload. */
export function stripLeakedToolMarkup(text: string): string {
  const fullWidthIndex = text.indexOf('<｜');
  const asciiMatch = text.match(/<\|{1,2}[^>]{0,60}(dsml|tool[▁_\- ]?call|invoke)/i);
  const candidates = [fullWidthIndex, asciiMatch?.index ?? -1].filter((index) => index >= 0);

  if (!candidates.length) return text.trim();
  return text.slice(0, Math.min(...candidates)).trim();
}

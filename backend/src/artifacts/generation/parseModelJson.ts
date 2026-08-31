import { jsonrepair } from 'jsonrepair';

/**
 * Parse a model-produced JSON object. Planning prompts ask for JSON only, but
 * long PPT/PDF outlines still arrive with fences, trailing commas, or missing
 * commas between array elements.
 */
export function parseModelJsonObject(content: string): unknown {
  const extracted = extractJsonObject(content);
  try {
    return JSON.parse(extracted) as unknown;
  } catch (firstError) {
    try {
      return JSON.parse(jsonrepair(extracted)) as unknown;
    } catch {
      throw firstError instanceof Error ? firstError : new Error('JSON object not found');
    }
  }
}

function extractJsonObject(content: string) {
  const trimmed = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('JSON object not found');
  return trimmed.slice(start, end + 1);
}

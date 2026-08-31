import { createHash } from 'node:crypto';

/**
 * The hash identifies the model-visible contract, not transport metadata. MCP
 * annotations are deliberately excluded so a read-only hint change does not
 * invalidate an approval for an otherwise identical function schema.
 */
export function mcpToolDefinitionHash(
  modelName: string,
  description: string,
  inputSchema: Record<string, unknown>
): string {
  const definition = {
    name: modelName,
    description,
    inputSchema
  };
  return createHash('sha256').update(stableStringify(definition)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`;
}

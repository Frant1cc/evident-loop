import type { ToolPolicy } from './contracts.js';

export const legacyToolAliases: Readonly<Record<string, string>> = {
  search_docs: 'search_knowledge'
};

export function normalizeToolPolicy(value: unknown, fallback: ToolPolicy = { mode: 'all' }): ToolPolicy {
  if (value === undefined) return fallback;

  // Compatibility with tasks and clients created before explicit policies existed.
  if (Array.isArray(value)) {
    const names = normalizeNames(value);
    return names.length ? { mode: 'selected', names } : { mode: 'all' };
  }

  if (!value || typeof value !== 'object') throw new Error('toolPolicy must be an object');
  const policy = value as { mode?: unknown; names?: unknown };
  if (policy.mode === 'all') return { mode: 'all' };
  if (policy.mode === 'none') return { mode: 'none' };
  if (policy.mode === 'selected') {
    const names = normalizeNames(policy.names);
    if (!names.length) throw new Error('selected toolPolicy must contain at least one tool name');
    return { mode: 'selected', names };
  }
  throw new Error('toolPolicy.mode must be all, selected, or none');
}

export function restrictToolPolicyToRegistered(policy: ToolPolicy, registeredNames: Set<string>): ToolPolicy {
  if (policy.mode !== 'selected') return policy;
  return { mode: 'selected', names: policy.names.filter((name) => registeredNames.has(name)) };
}

export function describeToolPolicy(policy: ToolPolicy) {
  if (policy.mode === 'all') return 'all registered tools';
  if (policy.mode === 'none') return 'no tools';
  return policy.names.join(', ');
}

function normalizeNames(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('tool names must be an array of strings');
  }
  return [...new Set(value
    .map((item) => item.trim())
    .filter(Boolean)
    .map((name) => legacyToolAliases[name] ?? name))];
}

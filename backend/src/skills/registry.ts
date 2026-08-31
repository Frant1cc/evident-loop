import { createHash } from 'node:crypto';

import type { OfficialResearchSkill, ResearchSkillSnapshot } from './contracts.js';

const MAX_INSTRUCTIONS_LENGTH = 4_000;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ResearchSkillRegistry = {
  /** Every registered definition, in registration order. */
  list: () => OfficialResearchSkill[];
  /** Current (latest registered) version for an id, or undefined. */
  getLatest: (id: string) => OfficialResearchSkill | undefined;
  /** Exact historical version for an id, or undefined. */
  getVersion: (id: string, version: string) => OfficialResearchSkill | undefined;
  /** Stable SHA-256 digest of a definition. */
  digest: (definition: OfficialResearchSkill) => string;
};

export type CreateRegistryOptions = {
  /** Model-visible tool names a skill is allowed to reference. */
  knownToolNames: Set<string>;
};

export function createResearchSkillRegistry(
  definitions: OfficialResearchSkill[],
  options: CreateRegistryOptions
): ResearchSkillRegistry {
  const byKey = new Map<string, OfficialResearchSkill>();
  const latest = new Map<string, OfficialResearchSkill>();

  for (const definition of definitions) {
    validateDefinition(definition, options.knownToolNames);
    const key = skillKey(definition.id, definition.version);
    if (byKey.has(key)) throw new Error(`Duplicate research skill registration: ${key}`);
    byKey.set(key, definition);
    latest.set(definition.id, definition);
  }

  return {
    list: () => [...byKey.values()],
    getLatest: (id) => latest.get(id),
    getVersion: (id, version) => byKey.get(skillKey(id, version)),
    digest: (definition) => computeDigest(definition)
  };
}

export function skillKey(id: string, version: string) {
  return `${id}@${version}`;
}

/** Deterministic digest over the fields that define a published skill. */
function computeDigest(definition: OfficialResearchSkill): string {
  const canonical = JSON.stringify({
    id: definition.id,
    version: definition.version,
    label: definition.label,
    description: definition.description,
    instructions: definition.instructions,
    tools: {
      recommended: [...definition.tools.recommended].sort(),
      required: [...definition.tools.required].sort()
    }
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function snapshotMatches(definition: OfficialResearchSkill, snapshot: ResearchSkillSnapshot) {
  return (
    definition.id === snapshot.id &&
    definition.version === snapshot.version &&
    computeDigest(definition) === snapshot.digest
  );
}

function validateDefinition(definition: OfficialResearchSkill, knownToolNames: Set<string>) {
  if (!ID_PATTERN.test(definition.id)) {
    throw new Error(`Invalid research skill id: ${definition.id}`);
  }
  if (!definition.version.trim()) throw new Error(`Research skill ${definition.id} is missing a version`);
  if (!definition.label.trim()) throw new Error(`Research skill ${definition.id} is missing a label`);
  if (!definition.description.trim()) throw new Error(`Research skill ${definition.id} is missing a description`);
  if (!definition.instructions.trim()) throw new Error(`Research skill ${definition.id} is missing instructions`);
  if (definition.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new Error(`Research skill ${definition.id} instructions exceed ${MAX_INSTRUCTIONS_LENGTH} characters`);
  }

  const recommended = new Set(definition.tools.recommended);
  for (const name of definition.tools.recommended) {
    if (!knownToolNames.has(name)) {
      throw new Error(`Research skill ${definition.id} references unknown tool: ${name}`);
    }
  }
  for (const name of definition.tools.required) {
    if (!knownToolNames.has(name)) {
      throw new Error(`Research skill ${definition.id} references unknown tool: ${name}`);
    }
    // required must be a subset of recommended (§5.1).
    if (!recommended.has(name)) {
      throw new Error(`Research skill ${definition.id} required tool must also be recommended: ${name}`);
    }
  }
}

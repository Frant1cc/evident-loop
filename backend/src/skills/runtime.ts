import type {
  OfficialResearchSkill,
  ResearchSkillInfo,
  ResearchSkillSnapshot,
  ResolvedResearchSkill
} from './contracts.js';
import { officialResearchSkills } from './catalog/index.js';
import {
  createResearchSkillRegistry,
  snapshotMatches,
  skillKey,
  type CreateRegistryOptions,
  type ResearchSkillRegistry
} from './registry.js';

export type ResearchSkillRuntime = {
  list: () => ResearchSkillInfo[];
  resolveLatest: (id: string) => ResolvedResearchSkill;
  resolveSnapshot: (snapshot: ResearchSkillSnapshot) => ResolvedResearchSkill;
  createSnapshot: (id: string) => ResearchSkillSnapshot;
};

export function createResearchSkillRuntime(registry: ResearchSkillRegistry): ResearchSkillRuntime {
  const resolve = (definition: OfficialResearchSkill): ResolvedResearchSkill => ({
    definition,
    snapshot: {
      id: definition.id,
      version: definition.version,
      digest: registry.digest(definition)
    }
  });

  return {
    list: () => registry.list().map(toInfo),
    resolveLatest: (id) => {
      const definition = registry.getLatest(id);
      if (!definition) throw new Error(`Unknown research skill: ${id}`);
      return resolve(definition);
    },
    resolveSnapshot: (snapshot) => {
      const definition = registry.getVersion(snapshot.id, snapshot.version);
      if (!definition) throw new Error(`Research skill version not found: ${skillKey(snapshot.id, snapshot.version)}`);
      if (!snapshotMatches(definition, snapshot)) {
        throw new Error(`Research skill digest mismatch for ${skillKey(snapshot.id, snapshot.version)}`);
      }
      return resolve(definition);
    },
    createSnapshot: (id) => resolve(mustGetLatest(registry, id)).snapshot
  };
}

/** Default runtime bound to the shipped catalog and a fixed tool-name set. */
export function createDefaultResearchSkillRuntime(options: CreateRegistryOptions): ResearchSkillRuntime {
  return createResearchSkillRuntime(createResearchSkillRegistry(officialResearchSkills, options));
}

function mustGetLatest(registry: ResearchSkillRegistry, id: string): OfficialResearchSkill {
  const definition = registry.getLatest(id);
  if (!definition) throw new Error(`Unknown research skill: ${id}`);
  return definition;
}

function toInfo(definition: OfficialResearchSkill): ResearchSkillInfo {
  return {
    id: definition.id,
    version: definition.version,
    label: definition.label,
    description: definition.description,
    recommendedTools: [...definition.tools.recommended],
    requiredTools: [...definition.tools.required]
  };
}

/** Official research skill declared in code and shipped with the app. */
export type OfficialResearchSkill = {
  id: string;
  version: string;
  label: string;
  description: string;
  instructions: string;
  tools: {
    /** Tools this skill benefits from. Superset that must contain `required`. */
    recommended: string[];
    /** Tools that must be authorized by the user's ToolPolicy for the skill to run. */
    required: string[];
  };
};

/** Persisted with a Research Run so an exact version can be restored later. */
export type ResearchSkillSnapshot = {
  id: string;
  version: string;
  digest: string;
};

/** Public metadata returned to the client. Never carries `instructions`. */
export type ResearchSkillInfo = {
  id: string;
  version: string;
  label: string;
  description: string;
  recommendedTools: string[];
  requiredTools: string[];
};

/** A registered definition paired with its stable digest and snapshot. */
export type ResolvedResearchSkill = {
  definition: OfficialResearchSkill;
  snapshot: ResearchSkillSnapshot;
};

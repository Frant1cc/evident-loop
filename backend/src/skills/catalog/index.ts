import type { OfficialResearchSkill } from '../contracts.js';
import { technologyComparisonV1 } from './technologyComparison.js';

/** All official skill versions shipped with the app. Never mutate a published entry. */
export const officialResearchSkills: OfficialResearchSkill[] = [technologyComparisonV1];

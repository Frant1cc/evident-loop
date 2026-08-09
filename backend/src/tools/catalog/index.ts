import type { ToolModule } from '../contracts.js';
import { documentToolModules } from './documents.js';
import { knowledgeToolModules } from './knowledge.js';
import { webToolModules } from './web.js';

export const builtInToolModules: ToolModule[] = [
  ...knowledgeToolModules,
  ...documentToolModules,
  ...webToolModules
];

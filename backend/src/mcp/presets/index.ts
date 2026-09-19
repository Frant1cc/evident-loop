export type {
  McpManagedMetadata,
  ManagedMcpApprovalPolicy,
  ManagedMcpPreset,
  McpPresetPublic
} from './contracts.js';

export {
  detectNpxMajorVersion,
  resolveNpxCommand,
  validateCommandSafety
} from './platform.js';

export {
  context7Preset,
  MANAGED_PRESETS,
  getPresetById,
  describeApprovalPolicy
} from './catalog.js';

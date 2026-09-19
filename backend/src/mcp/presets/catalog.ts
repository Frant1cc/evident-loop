import type { ManagedMcpPreset } from './contracts.js';
import { resolveNpxCommand, validateCommandSafety } from './platform.js';

const CONTEXT7_VERSION = '4.0.3';

export const context7Preset: ManagedMcpPreset = {
  id: 'context7',
  version: 2,
  consentVersion: 1,
  name: 'Context7 文档查询',
  description: '查询最新的库与框架文档，适合研究和代码实现阶段。',
  publisher: 'Upstash',
  package: {
    name: '@upstash/context7-mcp',
    version: CONTEXT7_VERSION
  },
  resolveDraft: (platform, runtime) => {
    const { command, args } = resolveNpxCommand(
      platform,
      '@upstash/context7-mcp',
      CONTEXT7_VERSION,
      runtime.npxMajorVersion
    );
    validateCommandSafety(command, args);
    return {
      name: 'Context7 文档',
      transport: 'stdio',
      enabled: false,
      command,
      args,
      authMode: 'none'
    };
  },
  approvalPolicy: {
    default: 'allow_readonly',
    tools: {
      'query-docs': 'allow',
      'resolve-library-id': 'allow'
    }
  }
};

export const MANAGED_PRESETS: ManagedMcpPreset[] = [context7Preset];

export function getPresetById(id: string): ManagedMcpPreset | undefined {
  return MANAGED_PRESETS.find((preset) => preset.id === id);
}

export function describeApprovalPolicy(preset: ManagedMcpPreset): string {
  if (preset.approvalPolicy.default === 'allow_readonly') {
    return '只读工具自动允许，写操作需要审批';
  }
  return '默认需要审批';
}

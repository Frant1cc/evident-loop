import type { ManagedMcpPreset } from './contracts.js';
import { resolveNpxCommand, validateCommandSafety } from './platform.js';

const CONTEXT7_VERSION = '0.1.5';
const MEMORY_VERSION = '0.1.0';

export const context7Preset: ManagedMcpPreset = {
  id: 'context7',
  version: 1,
  consentVersion: 1,
  name: 'Context7 文档查询',
  description: '查询最新的库与框架文档，适合研究和代码实现阶段。',
  publisher: 'Upstash',
  package: {
    name: '@upstash/context7-mcp',
    version: CONTEXT7_VERSION
  },
  resolveDraft: (platform) => {
    const { command, args } = resolveNpxCommand(
      platform,
      '@upstash/context7-mcp',
      CONTEXT7_VERSION
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

export const memoryPreset: ManagedMcpPreset = {
  id: 'memory',
  version: 1,
  consentVersion: 1,
  name: 'Memory 本地记忆',
  description: '为 MCP 客户端提供可持久化的本地知识图谱记忆工具。',
  publisher: 'Model Context Protocol',
  package: {
    name: '@modelcontextprotocol/server-memory',
    version: MEMORY_VERSION
  },
  resolveDraft: (platform) => {
    const { command, args } = resolveNpxCommand(
      platform,
      '@modelcontextprotocol/server-memory',
      MEMORY_VERSION
    );
    validateCommandSafety(command, args);
    return {
      name: 'Memory 本地记忆',
      transport: 'stdio',
      enabled: false,
      command,
      args,
      authMode: 'none'
    };
  },
  approvalPolicy: {
    default: 'require_approval',
    tools: {
      'query_memory': 'allow',
      'store_memory': 'require_approval'
    }
  }
};

export const MANAGED_PRESETS: ManagedMcpPreset[] = [context7Preset, memoryPreset];

export function getPresetById(id: string): ManagedMcpPreset | undefined {
  return MANAGED_PRESETS.find((preset) => preset.id === id);
}

export function describeApprovalPolicy(preset: ManagedMcpPreset): string {
  if (preset.approvalPolicy.default === 'allow_readonly') {
    return '只读工具自动允许，写操作需要审批';
  }
  return '默认需要审批';
}

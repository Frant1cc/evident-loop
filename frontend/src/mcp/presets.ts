import type { McpServerDraft } from '../types/mcp';

/**
 * @deprecated This file is deprecated. MCP presets are now managed by the backend.
 * Use the API endpoints `/api/mcp/presets` instead.
 *
 * This file is kept for backward compatibility but will be removed in a future version.
 */

export type McpPreset = {
  id: string;
  name: string;
  description: string;
  draft: McpServerDraft;
};

/**
 * Built-in presets are deliberately drafts: a local process never starts until
 * the user saves, tests, and explicitly enables the connection.
 *
 * @deprecated Use the backend-managed presets API instead.
 */
export const builtInMcpPresets: McpPreset[] = [
  {
    id: 'context7',
    name: 'Context7',
    description: '查询最新的库与框架文档，适合研究和代码实现阶段。',
    draft: {
      name: 'Context7 文档',
      transport: 'stdio',
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@upstash/context7-mcp'],
      authMode: 'none'
    }
  },
  {
    id: 'memory',
    name: 'Memory',
    description: '为 MCP 客户端提供可持久化的本地知识图谱记忆工具。',
    draft: {
      name: 'Memory 本地记忆',
      transport: 'stdio',
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@modelcontextprotocol/server-memory'],
      authMode: 'none'
    }
  }
];

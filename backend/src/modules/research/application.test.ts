import assert from 'node:assert/strict';
import test from 'node:test';

import { createResearchSkillRegistry } from '../../skills/registry.js';
import { createResearchSkillRuntime } from '../../skills/runtime.js';
import type { ToolModule } from '../../tools/contracts.js';
import { createToolRuntime } from '../../tools/runtime.js';
import { createResearchApplication, mergeAutomaticMcpTools } from './application.js';

function tool(name: string, source: 'builtin' | 'mcp', status: 'available' | 'unavailable' = 'available'): ToolModule {
  return {
    label: name,
    source,
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } }
    },
    availability: { status },
    execute: async () => ({ ok: true })
  };
}

const modules = [
  tool('builtin_search', 'builtin'),
  tool('mcp_context7_query', 'mcp'),
  tool('mcp_offline_tool', 'mcp', 'unavailable')
];

test('automatically adds only available MCP tools to an explicit tool policy', () => {
  assert.deepEqual(mergeAutomaticMcpTools({ mode: 'none' }, modules), {
    mode: 'selected',
    names: ['mcp_context7_query']
  });
  assert.deepEqual(mergeAutomaticMcpTools({ mode: 'selected', names: ['builtin_search'] }, modules), {
    mode: 'selected',
    names: ['builtin_search', 'mcp_context7_query']
  });
  assert.deepEqual(mergeAutomaticMcpTools({ mode: 'all' }, modules), { mode: 'all' });
});

test('research tool picker excludes MCP implementation tools', () => {
  const runtime = createToolRuntime(new Map(
    modules.map((module) => [module.definition.function.name, module])
  ));
  const skillRuntime = createResearchSkillRuntime(createResearchSkillRegistry([], {
    knownToolNames: new Set(runtime.getDefinitions().map((definition) => definition.function.name))
  }));
  const application = createResearchApplication({
    model: 'test-model',
    toolRuntime: runtime,
    skillRuntime,
    toolGroups: []
  });

  assert.deepEqual(application.listTools().map((item) => item.name), ['builtin_search']);
});

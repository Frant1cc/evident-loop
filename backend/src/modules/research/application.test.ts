import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../../db.js';
import type { LlmProvider } from '../../llm/contracts.js';
import {
  createResearchConversation,
  deleteResearchConversation,
  getResearchRunInput
} from '../../research/store.js';
import { createResearchSkillRegistry } from '../../skills/registry.js';
import { createResearchSkillRuntime } from '../../skills/runtime.js';
import type { ToolModule } from '../../tools/contracts.js';
import { createToolRuntime } from '../../tools/runtime.js';
import { createResearchApplication, mergeAutomaticResearchTools } from './application.js';

initDb();

const llm: LlmProvider = {
  complete: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  stream: async () => undefined
};

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
  tool('read_evidence', 'builtin'),
  tool('mcp_context7_query', 'mcp'),
  tool('mcp_offline_tool', 'mcp', 'unavailable')
];

test('automatically adds available MCP and evidence tools to an explicit tool policy', () => {
  assert.deepEqual(mergeAutomaticResearchTools({ mode: 'none' }, modules), {
    mode: 'selected',
    names: ['mcp_context7_query', 'read_evidence']
  });
  assert.deepEqual(mergeAutomaticResearchTools(
    { mode: 'selected', names: ['builtin_search'] },
    modules
  ), {
    mode: 'selected',
    names: ['builtin_search', 'mcp_context7_query', 'read_evidence']
  });
  assert.deepEqual(
    mergeAutomaticResearchTools({ mode: 'all' }, modules),
    { mode: 'all' }
  );
});

test('evidence lookup remains automatic even when no selectable or MCP tools are enabled', () => {
  const modulesWithoutMcp = modules.filter((module) => module.source !== 'mcp');
  assert.deepEqual(
    mergeAutomaticResearchTools({ mode: 'none' }, modulesWithoutMcp),
    { mode: 'selected', names: ['read_evidence'] }
  );
});

test('research tool picker excludes automatic evidence and MCP implementation tools', () => {
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

test('starting a research message persists read_evidence in the effective run policy', () => {
  const evidenceModule = tool('read_evidence', 'builtin');
  const runtime = createToolRuntime(new Map([
    [evidenceModule.definition.function.name, evidenceModule]
  ]));
  const skillRuntime = createResearchSkillRuntime(createResearchSkillRegistry([], {
    knownToolNames: new Set(runtime.getDefinitions().map((definition) => definition.function.name))
  }));
  const application = createResearchApplication({
    llm,
    model: 'test-model',
    toolRuntime: runtime,
    skillRuntime,
    toolGroups: []
  });
  const conversation = createResearchConversation();

  try {
    const started = application.startMessage(conversation.id, '你好', { mode: 'none' });
    const runInput = getResearchRunInput(started.run.id);
    assert.deepEqual(runInput?.toolPolicy, { mode: 'selected', names: ['read_evidence'] });
    assert.equal(runInput?.executionMode, 'research');
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

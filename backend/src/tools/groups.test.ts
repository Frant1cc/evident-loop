import assert from 'node:assert/strict';
import test from 'node:test';

import type { ToolModule } from './contracts.js';
import { builtInToolGroups, validateToolGroups } from './groups.js';

function tool(name: string, exposedToModel = true): ToolModule {
  return {
    label: name,
    exposedToModel,
    definition: {
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {}, required: [] } }
    },
    execute: () => undefined
  };
}

const modules = [tool('search_knowledge'), tool('read_document'), tool('internal_audit', false)];

test('validates the knowledge group and returns an isolated copy', () => {
  const groups = validateToolGroups(builtInToolGroups, modules);
  assert.deepEqual(groups[0]?.toolNames, ['search_knowledge', 'read_document']);
  assert.ok(!modules.some((module) => module.definition.function.name === 'knowledge'));
});

test('rejects invalid, duplicate and overlapping tool groups', () => {
  assert.throws(() => validateToolGroups([
    { id: 'Knowledge', label: 'x', description: 'x', toolNames: ['search_knowledge'] }
  ], modules), /Invalid tool group id/);
  assert.throws(() => validateToolGroups([
    ...builtInToolGroups,
    { ...builtInToolGroups[0]! }
  ], modules), /Duplicate tool group id/);
  assert.throws(() => validateToolGroups([
    ...builtInToolGroups,
    { id: 'other', label: 'x', description: 'x', toolNames: ['read_document'] }
  ], modules), /more than one/);
});

test('rejects unknown, repeated and internal tools', () => {
  assert.throws(() => validateToolGroups([
    { id: 'unknown', label: 'x', description: 'x', toolNames: ['missing'] }
  ], modules), /Unknown tool/);
  assert.throws(() => validateToolGroups([
    { id: 'repeat', label: 'x', description: 'x', toolNames: ['read_document', 'read_document'] }
  ], modules), /Duplicate tool/);
  assert.throws(() => validateToolGroups([
    { id: 'internal', label: 'x', description: 'x', toolNames: ['internal_audit'] }
  ], modules), /Internal tool/);
});

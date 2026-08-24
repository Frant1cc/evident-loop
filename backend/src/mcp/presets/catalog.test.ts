import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { context7Preset, memoryPreset, MANAGED_PRESETS, getPresetById, describeApprovalPolicy } from './catalog.js';

test('MANAGED_PRESETS contains context7 and memory', () => {
  assert.equal(MANAGED_PRESETS.length, 2);
  assert.ok(MANAGED_PRESETS.find((p) => p.id === 'context7'));
  assert.ok(MANAGED_PRESETS.find((p) => p.id === 'memory'));
});

test('context7 preset has correct structure', () => {
  assert.equal(context7Preset.id, 'context7');
  assert.equal(context7Preset.version, 2);
  assert.equal(context7Preset.consentVersion, 1);
  assert.equal(context7Preset.name, 'Context7 文档查询');
  assert.equal(context7Preset.publisher, 'Upstash');
  assert.equal(context7Preset.package.name, '@upstash/context7-mcp');
  assert.equal(context7Preset.package.version, '4.0.3');
  assert.equal(context7Preset.approvalPolicy.default, 'allow_readonly');
  assert.equal(context7Preset.approvalPolicy.tools?.['query-docs'], 'allow');
  assert.equal(context7Preset.approvalPolicy.tools?.['resolve-library-id'], 'allow');
});

test('memory preset has correct structure', () => {
  assert.equal(memoryPreset.id, 'memory');
  assert.equal(memoryPreset.version, 2);
  assert.equal(memoryPreset.consentVersion, 1);
  assert.equal(memoryPreset.name, 'Memory 本地记忆');
  assert.equal(memoryPreset.publisher, 'Model Context Protocol');
  assert.equal(memoryPreset.package.name, '@modelcontextprotocol/server-memory');
  assert.equal(memoryPreset.package.version, '2026.7.4');
  assert.equal(memoryPreset.approvalPolicy.default, 'require_approval');
  assert.equal(memoryPreset.approvalPolicy.tools?.read_graph, 'allow');
  assert.equal(memoryPreset.approvalPolicy.tools?.search_nodes, 'allow');
  assert.equal(memoryPreset.approvalPolicy.tools?.open_nodes, 'allow');
  assert.equal(memoryPreset.approvalPolicy.tools?.create_entities, 'require_approval');
  assert.equal(memoryPreset.approvalPolicy.tools?.delete_entities, 'require_approval');
});

test('resolveDraft generates correct config for Windows', () => {
  const draft = context7Preset.resolveDraft('win32', { npxMajorVersion: 10 });
  assert.equal(draft.name, 'Context7 文档');
  assert.equal(draft.transport, 'stdio');
  assert.equal(draft.command, 'npx.cmd');
  assert.deepEqual(draft.args, ['--yes', '@upstash/context7-mcp@4.0.3']);
  assert.equal(draft.authMode, 'none');
  assert.equal(draft.enabled, false);
});

test('resolveDraft generates correct config for macOS', () => {
  const draft = memoryPreset.resolveDraft('darwin', { npxMajorVersion: 10 });
  assert.equal(draft.name, 'Memory 本地记忆');
  assert.equal(draft.transport, 'stdio');
  assert.equal(draft.command, 'npx');
  assert.deepEqual(draft.args, ['--yes', '@modelcontextprotocol/server-memory@2026.7.4']);
  assert.equal(draft.authMode, 'none');
  assert.equal(draft.enabled, false);
});

test('getPresetById returns preset', () => {
  const preset = getPresetById('context7');
  assert.ok(preset);
  assert.equal(preset.id, 'context7');
});

test('getPresetById returns undefined for unknown preset', () => {
  const preset = getPresetById('unknown');
  assert.equal(preset, undefined);
});

test('describeApprovalPolicy returns correct description', () => {
  const context7Desc = describeApprovalPolicy(context7Preset);
  assert.equal(context7Desc, '只读工具自动允许，写操作需要审批');

  const memoryDesc = describeApprovalPolicy(memoryPreset);
  assert.equal(memoryDesc, '默认需要审批');
});

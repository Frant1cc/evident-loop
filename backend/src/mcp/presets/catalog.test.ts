import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { context7Preset, MANAGED_PRESETS, getPresetById, describeApprovalPolicy } from './catalog.js';

test('MANAGED_PRESETS contains context7', () => {
  assert.deepEqual(MANAGED_PRESETS.map((preset) => preset.id), ['context7']);
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
  const draft = context7Preset.resolveDraft('darwin', { npxMajorVersion: 10 });
  assert.equal(draft.name, 'Context7 文档');
  assert.equal(draft.transport, 'stdio');
  assert.equal(draft.command, 'npx');
  assert.deepEqual(draft.args, ['--yes', '@upstash/context7-mcp@4.0.3']);
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
});

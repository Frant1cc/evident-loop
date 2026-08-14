import assert from 'node:assert/strict';
import test from 'node:test';

import type { OfficialResearchSkill } from './contracts.js';
import { createResearchSkillRegistry } from './registry.js';
import { createResearchSkillRuntime } from './runtime.js';

const knownToolNames = new Set(['search_knowledge', 'read_document', 'retrieve_web_evidence']);

function baseSkill(overrides: Partial<OfficialResearchSkill> = {}): OfficialResearchSkill {
  return {
    id: 'technology-comparison',
    version: '1.0.0',
    label: '技术方案对比',
    description: '统一维度比较技术方案。',
    instructions: '按相同维度比较所有候选方案并区分事实与推断。',
    tools: {
      recommended: ['search_knowledge', 'read_document'],
      required: ['search_knowledge']
    },
    ...overrides
  };
}

function makeRegistry(definitions: OfficialResearchSkill[]) {
  return createResearchSkillRegistry(definitions, { knownToolNames });
}

test('rejects duplicate id + version registrations', () => {
  assert.throws(() => makeRegistry([baseSkill(), baseSkill()]), /Duplicate research skill/);
});

test('accepts multiple versions of the same skill', () => {
  const registry = makeRegistry([baseSkill(), baseSkill({ version: '2.0.0' })]);
  assert.equal(registry.list().length, 2);
  assert.equal(registry.getLatest('technology-comparison')?.version, '2.0.0');
});

test('rejects an invalid id', () => {
  assert.throws(() => makeRegistry([baseSkill({ id: 'Tech_Comparison' })]), /Invalid research skill id/);
});

test('rejects empty label, description, and instructions', () => {
  assert.throws(() => makeRegistry([baseSkill({ label: '  ' })]), /missing a label/);
  assert.throws(() => makeRegistry([baseSkill({ description: '' })]), /missing a description/);
  assert.throws(() => makeRegistry([baseSkill({ instructions: '' })]), /missing instructions/);
});

test('rejects instructions over the length limit', () => {
  assert.throws(() => makeRegistry([baseSkill({ instructions: 'x'.repeat(4_001) })]), /exceed 4000/);
});

test('rejects unknown tool names', () => {
  assert.throws(
    () => makeRegistry([baseSkill({ tools: { recommended: ['nope'], required: [] } })]),
    /unknown tool/
  );
});

test('rejects required tools that are not also recommended', () => {
  assert.throws(
    () => makeRegistry([baseSkill({ tools: { recommended: ['read_document'], required: ['search_knowledge'] } })]),
    /required tool must also be recommended/
  );
});

test('digest is stable for identical definitions and changes with content', () => {
  const registry = makeRegistry([baseSkill()]);
  const other = makeRegistry([baseSkill()]);
  assert.equal(registry.digest(baseSkill()), other.digest(baseSkill()));
  assert.notEqual(registry.digest(baseSkill()), registry.digest(baseSkill({ instructions: '不同的指令内容。' })));
});

test('resolves an exact version and verifies its digest on restore', () => {
  const runtime = createResearchSkillRuntime(makeRegistry([baseSkill(), baseSkill({ version: '2.0.0' })]));
  const snapshot = runtime.createSnapshot('technology-comparison');
  assert.equal(snapshot.version, '2.0.0');

  const older = runtime.resolveLatest('technology-comparison');
  const restored = runtime.resolveSnapshot({
    id: 'technology-comparison',
    version: '1.0.0',
    digest: makeRegistry([baseSkill()]).digest(baseSkill())
  });
  assert.equal(restored.definition.version, '1.0.0');
  assert.equal(older.definition.version, '2.0.0');
});

test('rejects restore when the digest does not match', () => {
  const runtime = createResearchSkillRuntime(makeRegistry([baseSkill()]));
  assert.throws(
    () => runtime.resolveSnapshot({ id: 'technology-comparison', version: '1.0.0', digest: 'deadbeef' }),
    /digest mismatch/
  );
});

test('rejects restore when the version is missing', () => {
  const runtime = createResearchSkillRuntime(makeRegistry([baseSkill()]));
  assert.throws(
    () => runtime.resolveSnapshot({ id: 'technology-comparison', version: '9.9.9', digest: 'x' }),
    /version not found/
  );
});

test('list never exposes instructions', () => {
  const runtime = createResearchSkillRuntime(makeRegistry([baseSkill()]));
  const [info] = runtime.list();
  assert.ok(info);
  assert.equal((info as Record<string, unknown>).instructions, undefined);
  assert.deepEqual(info.requiredTools, ['search_knowledge']);
});

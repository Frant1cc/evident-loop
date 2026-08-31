import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSelectedToolPolicy,
  requiredGroupIds,
  standaloneTools
} from './selection.js';

const tools = [
  { name: 'search_knowledge', label: '检索', description: '' },
  { name: 'read_document', label: '阅读', description: '' },
  { name: 'retrieve_web_evidence', label: '联网', description: '' }
];
const groups = [{
  id: 'knowledge', label: '知识库', description: '', toolNames: ['search_knowledge', 'read_document']
}];

test('knowledge is one visible group that expands to two model tools', () => {
  assert.deepEqual(standaloneTools(tools, groups).map((tool) => tool.name), ['retrieve_web_evidence']);
  assert.deepEqual(buildSelectedToolPolicy(groups, { knowledge: true }, { retrieve_web_evidence: false }), {
    mode: 'selected', names: ['search_knowledge', 'read_document']
  });
  assert.deepEqual(buildSelectedToolPolicy(groups, { knowledge: false }, { retrieve_web_evidence: false }), { mode: 'none' });
});

test('required group membership locks the whole knowledge selection', () => {
  assert.deepEqual([...requiredGroupIds(groups, ['search_knowledge'])], ['knowledge']);
  assert.deepEqual([...requiredGroupIds(groups, ['retrieve_web_evidence'])], []);
});

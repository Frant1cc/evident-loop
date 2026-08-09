import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('task and research HTTP adapters depend only on module application APIs', () => {
  for (const route of ['../routes/tasks.ts', '../routes/research.ts']) {
    const source = read(route);
    assert.doesNotMatch(source, /process\.env/, `${route} must not read provider configuration`);
    assert.doesNotMatch(source, /\.\.\/runtime\//, `${route} must not import runtime internals`);
    assert.doesNotMatch(source, /\.\.\/research\/(?:store|service)/, `${route} must not import research internals`);
    assert.doesNotMatch(source, /\.\.\/tools\/registry/, `${route} must not import the concrete tool catalog`);
  }
});

test('business modules depend on the LLM port instead of the DeepSeek adapter', () => {
  for (const modulePath of [
    '../agent/agentLoop.ts',
    '../agent/toolRound.ts',
    '../rag/queryRewrite.ts',
    '../web/queryRewrite.ts',
    '../runtime/planner.ts',
    '../runtime/reviewer.ts',
    '../runtime/evidenceChainBuilder.ts',
    '../runtime/writer.ts'
  ]) {
    assert.doesNotMatch(read(modulePath), /deepseekClient|deepseekProvider/, `${modulePath} must use LlmProvider`);
  }
});

test('tool implementations depend on contracts, never on the registry composition root', () => {
  assert.doesNotMatch(read('../tools/wordDocumentTool.ts'), /from ['"]\.\/registry/);
  assert.match(read('../tools/registry.ts'), /from ['"]\.\/catalog\/index\.js['"]/);
});

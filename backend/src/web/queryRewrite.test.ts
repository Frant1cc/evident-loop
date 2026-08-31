import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmProvider } from '../llm/contracts.js';
import { rewriteWebQuery } from './queryRewrite.js';

test('query rewrites receive the current date and forbid stale latest-model years', async () => {
  let systemPrompt = '';
  let userPrompt = '';
  const llm: LlmProvider = {
    complete: async (request) => {
      systemPrompt = request.messages[0]?.content ?? '';
      userPrompt = request.messages[1]?.content ?? '';
      return { choices: [{ message: { role: 'assistant', content: '{"query":"OpenAI 2026 latest model official announcement"}' } }] };
    },
    stream: async () => undefined
  };

  const query = await rewriteWebQuery({
    question: 'OpenAI 最近发布了哪些模型？',
    previousQueries: [],
    reason: 'Need current official evidence',
    currentDate: '2026-08-18',
    llm
  });

  assert.equal(query, 'OpenAI 2026 latest model official announcement');
  assert.match(systemPrompt, /Current date: 2026-08-18/);
  assert.match(userPrompt, /"currentDate":"2026-08-18"/);
});

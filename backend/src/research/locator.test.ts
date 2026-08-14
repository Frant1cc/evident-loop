import assert from 'node:assert/strict';
import test from 'node:test';

import { initDb } from '../db.js';
import {
  addResearchSource,
  createResearchConversation,
  createResearchMessage,
  deleteResearchConversation,
  listResearchSources
} from './store.js';

initDb();

test('research sources persist PDF page locators across reload', () => {
  const conversation = createResearchConversation();
  const message = createResearchMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: '引用',
    status: 'complete'
  });

  try {
    addResearchSource(message.id, {
      id: 'risk.pdf:chunk-1',
      file: 'risk.pdf',
      title: '风险报告',
      heading: '市场风险',
      content: '久期上升会提高敏感度。',
      startLine: 12,
      endLine: 18,
      score: 0.9,
      format: 'pdf',
      locator: {
        normalizedLineStart: 12,
        normalizedLineEnd: 18,
        pageStart: 3,
        pageEnd: 4
      }
    }, '1');

    const sources = listResearchSources(conversation.id);
    assert.equal(sources[0]?.format, 'pdf');
    assert.equal(sources[0]?.locator?.pageStart, 3);
    assert.equal(sources[0]?.locator?.pageEnd, 4);
  } finally {
    deleteResearchConversation(conversation.id);
  }
});

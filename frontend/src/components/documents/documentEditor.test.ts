import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultLongformBlock,
  generateBlockId,
  moveArrayItem
} from './documentEditor';
import type { LongformBlock } from '../../types/artifacts';

describe('documentEditor', () => {
  describe('generateBlockId', () => {
    it('generates unique IDs', () => {
      const id1 = generateBlockId();
      const id2 = generateBlockId();
      assert.notEqual(id1, id2);
      assert.ok(id1.startsWith('block_'));
      assert.ok(id2.startsWith('block_'));
    });
  });

  describe('createDefaultLongformBlock', () => {
    it('creates heading block', () => {
      const block = createDefaultLongformBlock('heading');
      assert.equal(block.type, 'heading');
      assert.ok('level' in block && block.level === 1);
      assert.ok('text' in block && block.text === '');
      assert.ok('citations' in block && Array.isArray(block.citations));
    });

    it('creates paragraph block', () => {
      const block = createDefaultLongformBlock('paragraph');
      assert.equal(block.type, 'paragraph');
      assert.ok('text' in block && block.text === '');
      assert.ok('citations' in block && Array.isArray(block.citations));
    });

    it('creates bulletList block', () => {
      const block = createDefaultLongformBlock('bulletList');
      assert.equal(block.type, 'bulletList');
      assert.ok('items' in block && Array.isArray(block.items));
      assert.ok('citations' in block && Array.isArray(block.citations));
    });

    it('creates numberedList block', () => {
      const block = createDefaultLongformBlock('numberedList');
      assert.equal(block.type, 'numberedList');
      assert.ok('items' in block && Array.isArray(block.items));
      assert.ok('citations' in block && Array.isArray(block.citations));
    });

    it('creates table block', () => {
      const block = createDefaultLongformBlock('table');
      assert.equal(block.type, 'table');
      assert.ok('headers' in block && Array.isArray(block.headers));
      assert.ok('rows' in block && Array.isArray(block.rows));
      assert.ok('citations' in block && Array.isArray(block.citations));
    });

    it('creates pageBreak block', () => {
      const block = createDefaultLongformBlock('pageBreak');
      assert.equal(block.type, 'pageBreak');
      assert.ok(block.id);
    });
  });

  describe('moveArrayItem', () => {
    it('moves item forward', () => {
      const arr = ['a', 'b', 'c', 'd'];
      const result = moveArrayItem(arr, 1, 2);
      assert.deepEqual(result, ['a', 'c', 'b', 'd']);
    });

    it('moves item backward', () => {
      const arr = ['a', 'b', 'c', 'd'];
      const result = moveArrayItem(arr, 2, 1);
      assert.deepEqual(result, ['a', 'c', 'b', 'd']);
    });

    it('moves to first position', () => {
      const arr = ['a', 'b', 'c'];
      const result = moveArrayItem(arr, 2, 0);
      assert.deepEqual(result, ['c', 'a', 'b']);
    });

    it('moves to last position', () => {
      const arr = ['a', 'b', 'c'];
      const result = moveArrayItem(arr, 0, 2);
      assert.deepEqual(result, ['b', 'c', 'a']);
    });

    it('returns original array for invalid indices', () => {
      const arr = ['a', 'b', 'c'];
      assert.deepEqual(moveArrayItem(arr, -1, 1), arr);
      assert.deepEqual(moveArrayItem(arr, 0, -1), arr);
      assert.deepEqual(moveArrayItem(arr, 10, 1), arr);
      assert.deepEqual(moveArrayItem(arr, 0, 10), arr);
    });

    it('handles same source and target', () => {
      const arr = ['a', 'b', 'c'];
      const result = moveArrayItem(arr, 1, 1);
      assert.deepEqual(result, ['a', 'b', 'c']);
    });
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createEma } from './metrics';

test('first sample seeds the average', () => {
  const ema = createEma(500);
  assert.equal(ema.sample(100, 0), 100);
  assert.equal(ema.value, 100);
});

test('a same-instant sample keeps the previous value (zero elapsed = full retention)', () => {
  const ema = createEma(500);
  ema.sample(100, 0);
  // Zero elapsed time -> previous weight is 1, so the old value is fully retained.
  assert.equal(ema.sample(0, 0), 100);
});

test('after one half-life the old value keeps half its weight', () => {
  const ema = createEma(500);
  ema.sample(100, 0);
  const next = ema.sample(0, 500);
  assert.ok(Math.abs(next - 50) < 1e-6, `expected ~50, got ${next}`);
});

test('a long idle gap makes the average track the newest sample', () => {
  const ema = createEma(500);
  ema.sample(100, 0);
  const next = ema.sample(10, 10_000); // ~20 half-lives later
  assert.ok(Math.abs(next - 10) < 1e-3, `expected ~10, got ${next}`);
});

test('reset forgets history', () => {
  const ema = createEma(500);
  ema.sample(100, 0);
  ema.reset();
  assert.equal(ema.value, 0);
  assert.equal(ema.sample(42, 1_000), 42);
});

test('rejects a non-positive half-life', () => {
  assert.throws(() => createEma(0));
  assert.throws(() => createEma(-1));
});

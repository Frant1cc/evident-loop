import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_THRESHOLDS,
  StreamRenderScheduler,
  type PendingMessageDelta,
  type SchedulerDeps
} from './StreamRenderScheduler';

type Harness = {
  scheduler: StreamRenderScheduler;
  advance(ms: number): void;
  runRaf(): void;
  runDueTimers(): void;
  flushes: PendingMessageDelta[][];
  setHidden(hidden: boolean): void;
  /** Cost (ms) charged to the clock during each onFlush, to drive the render-cost EMA. */
  renderCostMs: number;
  pendingRaf(): boolean;
  pendingTimers(): number;
};

function createHarness(): Harness {
  let clock = 0;
  let hidden = false;
  let nextHandle = 1;
  const rafQueue: Array<{ handle: number; cb: () => void }> = [];
  const timerQueue: Array<{ handle: number; cb: () => void; at: number }> = [];
  const flushes: PendingMessageDelta[][] = [];

  const harness: Partial<Harness> & { renderCostMs: number } = { renderCostMs: 0, flushes };

  const deps: SchedulerDeps = {
    now: () => clock,
    requestAnimationFrame: (cb) => {
      const handle = nextHandle++;
      rafQueue.push({ handle, cb });
      return handle;
    },
    cancelAnimationFrame: (handle) => {
      const index = rafQueue.findIndex((entry) => entry.handle === handle);
      if (index !== -1) rafQueue.splice(index, 1);
    },
    setTimeout: (cb, ms) => {
      const handle = nextHandle++;
      timerQueue.push({ handle, cb, at: clock + ms });
      return handle;
    },
    clearTimeout: (handle) => {
      const index = timerQueue.findIndex((entry) => entry.handle === handle);
      if (index !== -1) timerQueue.splice(index, 1);
    },
    isDocumentHidden: () => hidden,
    onFlush: (batch) => {
      flushes.push(batch);
      // Simulate the commit taking time so reportRenderCost sees a non-zero cost.
      clock += harness.renderCostMs;
    }
  };

  const scheduler = new StreamRenderScheduler(deps);

  return {
    scheduler,
    flushes,
    get renderCostMs() {
      return harness.renderCostMs;
    },
    set renderCostMs(value: number) {
      harness.renderCostMs = value;
    },
    advance(ms) {
      clock += ms;
    },
    runRaf() {
      const entries = rafQueue.splice(0, rafQueue.length);
      for (const entry of entries) entry.cb();
    },
    runDueTimers() {
      const due = timerQueue.filter((entry) => entry.at <= clock);
      for (const entry of due) {
        const index = timerQueue.indexOf(entry);
        if (index !== -1) timerQueue.splice(index, 1);
        entry.cb();
      }
    },
    setHidden(value) {
      hidden = value;
    },
    pendingRaf: () => rafQueue.length > 0,
    pendingTimers: () => timerQueue.length
  };
}

test('slow output (<40 chars/s) schedules on an animation frame', () => {
  const h = createHarness();
  h.scheduler.enqueue('m', 'a'); // first sample seeds rate at 0
  assert.ok(h.pendingRaf(), 'expected a rAF to be scheduled');
  assert.equal(h.pendingTimers(), 0);
  h.runRaf();
  assert.equal(h.flushes.length, 1);
  assert.deepEqual(h.flushes[0]!.map((entry) => entry.chunks.join('')), ['a']);
});

test('steady output (40-200 chars/s) uses the 40ms tier', () => {
  const h = createHarness();
  // Ramp the input-rate EMA with sustained ~100 chars/s input.
  h.scheduler.enqueue('m', 'ab'); // seed at 0
  h.runRaf();
  for (let i = 0; i < 30; i++) {
    h.advance(20);
    h.scheduler.enqueue('m', 'ab'); // 2 chars / 20ms = 100 chars/s
    h.runDueTimers();
    h.runRaf();
  }
  h.advance(20);
  h.scheduler.enqueue('m', 'ab');
  assert.equal(h.pendingTimers(), 1, 'expected a timer, not a rAF');
  assert.ok(!h.pendingRaf());
});

test('burst output (>200 chars/s) uses the 80ms tier', () => {
  const h = createHarness();
  h.scheduler.enqueue('m', 'x'.repeat(10)); // seed
  h.runRaf();
  for (let i = 0; i < 30; i++) {
    h.advance(10);
    h.scheduler.enqueue('m', 'x'.repeat(10)); // 1000 chars/s
    h.runDueTimers();
    h.runRaf();
  }
  h.advance(10);
  h.scheduler.enqueue('m', 'x'.repeat(10));
  assert.equal(h.pendingTimers(), 1);
  // Verify the chosen delay is the burst tier for a high sustained rate.
  const delay = h.scheduler.chooseDelay({
    terminal: false,
    hidden: false,
    inputRateEma: 500,
    renderCostEma: 0,
    pendingChars: 100
  });
  assert.equal(delay, DEFAULT_THRESHOLDS.burstDelayMs);
});

test('backlog over the flush threshold flushes immediately', () => {
  const h = createHarness();
  const big = 'y'.repeat(DEFAULT_THRESHOLDS.backlogFlushChars + 1);
  h.scheduler.enqueue('m', big);
  // Under mergeChunksChars (64KB) so no force-flush path; backlog path flushes now.
  assert.equal(h.flushes.length, 1);
});

test('hidden document uses the 250ms tier', () => {
  const h = createHarness();
  h.setHidden(true);
  const delay = h.scheduler.chooseDelay({
    terminal: false,
    hidden: true,
    inputRateEma: 500,
    renderCostEma: 0,
    pendingChars: 10
  });
  assert.equal(delay, DEFAULT_THRESHOLDS.hiddenDelayMs);
});

test('high render cost drops to the slow tier', () => {
  const h = createHarness();
  const delay = h.scheduler.chooseDelay({
    terminal: false,
    hidden: false,
    inputRateEma: 10,
    renderCostEma: DEFAULT_THRESHOLDS.renderCostCeilingMs + 1,
    pendingChars: 10
  });
  assert.equal(delay, DEFAULT_THRESHOLDS.renderCostFloorDelayMs);
});

test('terminal forces a synchronous flush', () => {
  const h = createHarness();
  h.scheduler.enqueue('m', 'partial');
  h.scheduler.markTerminal();
  assert.equal(h.flushes.length, 1);
  assert.equal(h.pendingRaf(), false);
  assert.equal(h.pendingTimers(), 0);
});

test('each message is flushed with its chunks joined once', () => {
  const h = createHarness();
  h.scheduler.enqueue('a', 'foo');
  h.scheduler.enqueue('a', 'bar');
  h.scheduler.enqueue('b', 'baz');
  h.scheduler.flushAll();
  assert.equal(h.flushes.length, 1);
  const batch = h.flushes[0]!;
  const byId = Object.fromEntries(batch.map((entry) => [entry.messageId, entry.chunks.join('')]));
  assert.deepEqual(byId, { a: 'foobar', b: 'baz' });
  // Buffers cleared after flush.
  h.scheduler.flushAll();
  assert.equal(h.flushes.length, 1);
});

test('a buffer over 256KB forces a flush and stays low-frequency', () => {
  const h = createHarness();
  h.scheduler.enqueue('m', 'z'.repeat(DEFAULT_THRESHOLDS.forceFlushChars + 1));
  assert.equal(h.flushes.length, 1);
  // Subsequent scheduling is pinned to the slow tier regardless of rate.
  const delay = h.scheduler.chooseDelay({
    terminal: false,
    hidden: false,
    inputRateEma: 10,
    renderCostEma: 0,
    pendingChars: 10
  });
  assert.equal(delay, DEFAULT_THRESHOLDS.renderCostFloorDelayMs);
});

test('dispose cancels scheduled work and clears buffers', () => {
  const h = createHarness();
  h.scheduler.enqueue('m', 'a');
  assert.ok(h.pendingRaf());
  h.scheduler.dispose();
  assert.equal(h.pendingRaf(), false);
  assert.equal(h.pendingTimers(), 0);
  h.runRaf();
  assert.equal(h.flushes.length, 0);
});

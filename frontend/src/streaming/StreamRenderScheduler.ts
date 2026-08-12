import { createEma, type Ema } from './metrics';

/** One message's un-committed streaming buffer. */
export type PendingMessageDelta = {
  messageId: string;
  chunks: string[];
  charCount: number;
  firstQueuedAt: number;
};

/**
 * Adaptive render tiers (plan §5.2/§5.3). These thresholds are initial values
 * and MUST be recalibrated against a real streaming benchmark; they are kept
 * here as named constants rather than scattered magic numbers so that tuning
 * happens in one place.
 */
export type SchedulerThresholds = {
  /** Input rate (chars/s) above which we throttle to the burst tier. */
  burstInputRate: number;
  /** Input rate (chars/s) above which we use the steady-typing tier. */
  steadyInputRate: number;
  /** Backlog (chars) above which we flush immediately regardless of rate. */
  backlogFlushChars: number;
  /** Render-cost EMA (ms) above which we drop to the slowest tier to protect the main thread. */
  renderCostCeilingMs: number;
  burstDelayMs: number;
  steadyDelayMs: number;
  hiddenDelayMs: number;
  renderCostFloorDelayMs: number;
  /** Per-message buffer size (chars) at which we eagerly join chunks into one string. */
  mergeChunksChars: number;
  /** Per-message buffer size (chars) at which we force a flush and stay low-frequency. */
  forceFlushChars: number;
};

export const DEFAULT_THRESHOLDS: SchedulerThresholds = {
  burstInputRate: 200,
  steadyInputRate: 40,
  backlogFlushChars: 8_192,
  renderCostCeilingMs: 8,
  burstDelayMs: 80,
  steadyDelayMs: 40,
  hiddenDelayMs: 250,
  renderCostFloorDelayMs: 120,
  mergeChunksChars: 64 * 1_024,
  forceFlushChars: 256 * 1_024
};

export type SchedulerDeps = {
  now: () => number;
  requestAnimationFrame: (cb: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
  setTimeout: (cb: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  isDocumentHidden: () => boolean;
  onFlush: (batch: PendingMessageDelta[]) => void;
};

/** 'animation-frame' schedules on the next frame; a number schedules a timer. */
type Delay = number | 'animation-frame';

type SchedulerState = {
  terminal: boolean;
  hidden: boolean;
  inputRateEma: number;
  renderCostEma: number;
  pendingChars: number;
};

/**
 * Shared, framework-agnostic scheduler that batches streaming deltas for many
 * messages and flushes them on an adaptive cadence driven by input-rate and
 * render-cost EMAs, backlog size, and page visibility (plan §5.1–5.4).
 *
 * A single flush is ever scheduled at a time (either a rAF or a timer, never
 * both). All timing/DOM access is injected so the scheduler is unit-testable
 * without a browser.
 */
export class StreamRenderScheduler {
  private readonly deps: SchedulerDeps;
  private readonly thresholds: SchedulerThresholds;
  private readonly pending = new Map<string, PendingMessageDelta>();
  private readonly inputRate: Ema;
  private readonly renderCost: Ema;

  private rafHandle: number | undefined;
  private timerHandle: number | undefined;
  private lastEnqueueAt: number | undefined;
  /** Latched when a terminal event forces synchronous behavior for the rest of the stream. */
  private terminal = false;
  /** Latched when a single buffer overflowed 256KB; keeps us in the slow tier. */
  private lowFrequency = false;

  constructor(deps: SchedulerDeps, thresholds: SchedulerThresholds = DEFAULT_THRESHOLDS) {
    this.deps = deps;
    this.thresholds = thresholds;
    // Half-lives chosen so both signals react within ~1s but ignore single spikes.
    this.inputRate = createEma(500);
    this.renderCost = createEma(1_000);
  }

  /** Accumulate a chunk for a message and (re)arm the next flush. */
  enqueue(messageId: string, chunk: string): void {
    if (!chunk) return;
    const now = this.deps.now();

    const entry = this.pending.get(messageId) ?? {
      messageId,
      chunks: [],
      charCount: 0,
      firstQueuedAt: now
    };
    entry.chunks.push(chunk);
    entry.charCount += chunk.length;

    // §5.4: collapse many small chunks once a message grows past the merge mark.
    if (entry.charCount > this.thresholds.mergeChunksChars && entry.chunks.length > 1) {
      entry.chunks = [entry.chunks.join('')];
    }
    this.pending.set(messageId, entry);

    // Update the input-rate EMA from the instantaneous chars/second of this chunk.
    if (this.lastEnqueueAt !== undefined) {
      const elapsedMs = Math.max(1, now - this.lastEnqueueAt);
      this.inputRate.sample((chunk.length / elapsedMs) * 1_000, now);
    } else {
      this.inputRate.sample(0, now);
    }
    this.lastEnqueueAt = now;

    // §5.4: a single buffer past the force-flush mark means the main thread is
    // starved — flush now and stay low-frequency thereafter.
    if (entry.charCount > this.thresholds.forceFlushChars) {
      this.lowFrequency = true;
      this.flushAll();
      return;
    }

    this.schedule();
  }

  /** Snapshot the signals the delay decision depends on. */
  private snapshot(): SchedulerState {
    return {
      terminal: this.terminal,
      hidden: this.deps.isDocumentHidden(),
      inputRateEma: this.inputRate.value,
      renderCostEma: this.renderCost.value,
      pendingChars: this.pendingChars()
    };
  }

  private pendingChars(): number {
    let total = 0;
    for (const entry of this.pending.values()) total += entry.charCount;
    return total;
  }

  /** Plan §5.3 delay policy. */
  chooseDelay(state: SchedulerState): Delay {
    if (state.terminal) return 0;
    if (state.hidden) return this.thresholds.hiddenDelayMs;
    if (this.lowFrequency) return this.thresholds.renderCostFloorDelayMs;
    if (state.renderCostEma > this.thresholds.renderCostCeilingMs) return this.thresholds.renderCostFloorDelayMs;
    if (state.pendingChars > this.thresholds.backlogFlushChars) return 0;
    if (state.inputRateEma > this.thresholds.burstInputRate) return this.thresholds.burstDelayMs;
    if (state.inputRateEma > this.thresholds.steadyInputRate) return this.thresholds.steadyDelayMs;
    return 'animation-frame';
  }

  /** Arm exactly one pending flush based on the current tier. */
  private schedule(): void {
    if (this.rafHandle !== undefined || this.timerHandle !== undefined) return;
    const delay = this.chooseDelay(this.snapshot());
    if (delay === 0) {
      this.flushAll();
      return;
    }
    if (delay === 'animation-frame') {
      this.rafHandle = this.deps.requestAnimationFrame(() => {
        this.rafHandle = undefined;
        this.flushAll();
      });
      return;
    }
    this.timerHandle = this.deps.setTimeout(() => {
      this.timerHandle = undefined;
      this.flushAll();
    }, delay);
  }

  private cancelScheduled(): void {
    if (this.rafHandle !== undefined) {
      this.deps.cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    }
    if (this.timerHandle !== undefined) {
      this.deps.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
  }

  /** Terminal event: force a synchronous flush and keep the stream synchronous. */
  markTerminal(): void {
    this.terminal = true;
    this.flushAll();
  }

  /** Flush a single message synchronously (used before an upsert overwrites it). */
  flushMessage(messageId: string): void {
    const entry = this.pending.get(messageId);
    if (!entry) return;
    this.pending.delete(messageId);
    this.deps.onFlush([entry]);
  }

  /** Flush every buffered message in one batch and measure the commit cost. */
  flushAll(): void {
    this.cancelScheduled();
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();

    const start = this.deps.now();
    this.deps.onFlush(batch);
    // §5.3 step 6: approximate render cost by the synchronous commit duration.
    this.reportRenderCost(this.deps.now() - start);
  }

  /** Feed an observed render/commit cost (ms) into the EMA that gates the tier. */
  reportRenderCost(ms: number): void {
    this.renderCost.sample(Math.max(0, ms), this.deps.now());
  }

  /** Drop a message's buffer without flushing (e.g. it was replaced wholesale). */
  clear(messageId: string): void {
    this.pending.delete(messageId);
  }

  /** Tear everything down: cancel timers, drop buffers, reset signals. */
  dispose(): void {
    this.cancelScheduled();
    this.pending.clear();
    this.inputRate.reset();
    this.renderCost.reset();
    this.lastEnqueueAt = undefined;
    this.terminal = false;
    this.lowFrequency = false;
  }
}

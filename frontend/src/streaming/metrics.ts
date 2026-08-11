/**
 * Time-decayed exponential moving average. Unlike a fixed-alpha EMA, the weight
 * of each new sample depends on how much time passed since the previous one, so
 * bursts and idle gaps are both handled correctly. Used for the streaming
 * scheduler's input-rate and render-cost signals.
 */
export type Ema = {
  /** Current smoothed value. */
  readonly value: number;
  /** Fold a new sample taken at `now` (ms) into the average; returns the new value. */
  sample(sample: number, now: number): number;
  /** Forget all history. */
  reset(): void;
};

export function createEma(halfLifeMs: number): Ema {
  if (halfLifeMs <= 0) throw new Error('halfLifeMs must be positive');
  const decayBase = Math.log(2) / halfLifeMs;

  let current = 0;
  let lastAt: number | undefined;

  return {
    get value() {
      return current;
    },
    sample(sample: number, now: number): number {
      if (lastAt === undefined) {
        current = sample;
        lastAt = now;
        return current;
      }
      const elapsed = Math.max(0, now - lastAt);
      // weight of the previous value decays toward 0 as elapsed grows.
      const weight = Math.exp(-decayBase * elapsed);
      current = current * weight + sample * (1 - weight);
      lastAt = now;
      return current;
    },
    reset() {
      current = 0;
      lastAt = undefined;
    }
  };
}

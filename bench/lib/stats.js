/** Small statistics helpers for the benchmark suite. Dependency free. */

export function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1),
    mean: sum / sorted.length,
  };
}

/**
 * Time `fn` repeatedly and return the per-call durations in milliseconds.
 *
 * The first warmup call's result goes to `check`, so a benchmark case that is
 * silently returning nothing (a wrong filter, a broken dataset) fails loudly
 * instead of reporting a very fast, very meaningless number.
 */
export async function sample(fn, { warmup = 2, samples = 15, check } = {}) {
  const first = await fn();
  if (check) check(first);
  for (let i = 1; i < warmup; i++) await fn();

  const timings = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    await fn();
    timings.push(performance.now() - start);
  }
  return timings;
}

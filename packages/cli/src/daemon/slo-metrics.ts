import { cliOperationalPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
// One bounded histogram per method for a whole UTC day. Percentiles are computed from bucket
// counts, so the result never depends on which source lines happened to be retained; exact
// milliseconds are kept below 5s and log-spaced buckets cover the long tail.
const EXACT_LIMIT_MS = cliOperationalPolicy.defaultValue.slo.exactHistogramMs;
const LOG_BASE_MS = 5_000;
const LOG_STEPS_PER_OCTAVE = 64;
const MAX_LOG_BUCKET = EXACT_LIMIT_MS + 1_025;

export interface DurationHistogram {
  count: number;
  maxMs: number;
  readonly buckets: Map<number, number>;
}
export interface DurationPercentile {
  readonly lowerMs: number;
  readonly upperMs: number;
  readonly exact: boolean;
}

export function createDurationHistogram(): DurationHistogram {
  return { count: 0, maxMs: 0, buckets: new Map() };
}

export function addDuration(histogram: DurationHistogram, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const value = Math.round(durationMs),
    bucket = bucketFor(value);
  histogram.count += 1;
  histogram.maxMs = Math.max(histogram.maxMs, value);
  histogram.buckets.set(bucket, (histogram.buckets.get(bucket) ?? 0) + 1);
}

export function durationPercentile(histogram: DurationHistogram, q: number): DurationPercentile | null {
  if (histogram.count === 0) return null;
  const target = Math.max(1, Math.ceil(q * histogram.count));
  let cumulative = 0;
  for (const bucket of [...histogram.buckets.keys()].sort((left, right) => left - right)) {
    cumulative += histogram.buckets.get(bucket)!;
    if (cumulative >= target) {
      const [lowerMs, upperMs] = bucketRange(bucket);
      return { lowerMs, upperMs, exact: lowerMs === upperMs };
    }
  }
  return { lowerMs: histogram.maxMs, upperMs: histogram.maxMs, exact: true };
}

function bucketFor(ms: number): number {
  if (ms <= EXACT_LIMIT_MS) return ms;
  return Math.min(MAX_LOG_BUCKET, EXACT_LIMIT_MS + 1 + Math.floor(Math.log2(ms / LOG_BASE_MS) * LOG_STEPS_PER_OCTAVE));
}

function bucketRange(bucket: number): readonly [number, number] {
  if (bucket <= EXACT_LIMIT_MS) return [bucket, bucket];
  const lower = LOG_BASE_MS * 2 ** ((bucket - EXACT_LIMIT_MS - 1) / LOG_STEPS_PER_OCTAVE),
    upper = LOG_BASE_MS * 2 ** ((bucket - EXACT_LIMIT_MS) / LOG_STEPS_PER_OCTAVE);
  return [Math.floor(lower), Math.ceil(upper)];
}

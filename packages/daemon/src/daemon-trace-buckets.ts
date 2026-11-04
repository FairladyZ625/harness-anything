// Per-second request buckets for the live view. Every map is bounded to the same retention window:
// a daemon that stays up for days must not retain one entry per node per second forever.
export type SecondBuckets = Map<number, number>;
export const TRACE_BUCKET_WINDOW_SECONDS = 120;

export function pruneSecondBuckets(buckets: SecondBuckets, nowSecond: number): void {
  const oldest = nowSecond - TRACE_BUCKET_WINDOW_SECONDS;
  for (const second of buckets.keys()) if (second < oldest) buckets.delete(second);
}

export function countSecondBuckets(buckets: SecondBuckets, sinceMs: number): number {
  let total = 0;
  for (const [second, value] of buckets) if (second * 1_000 >= sinceMs) total += value;
  return total;
}

export function pruneNodeBuckets(nodes: Map<string, SecondBuckets>, nowSecond: number): void {
  for (const [nodeId, buckets] of nodes) {
    pruneSecondBuckets(buckets, nowSecond);
    if (buckets.size === 0) nodes.delete(nodeId);
  }
}

export function retainedNodeSeconds(nodes: ReadonlyMap<string, SecondBuckets>): number {
  let total = 0;
  for (const buckets of nodes.values()) total += buckets.size;
  return total;
}

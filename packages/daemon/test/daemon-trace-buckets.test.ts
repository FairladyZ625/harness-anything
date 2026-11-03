// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  countSecondBuckets,
  pruneNodeBuckets,
  pruneSecondBuckets,
  retainedNodeSeconds,
  TRACE_BUCKET_WINDOW_SECONDS,
  type SecondBuckets,
} from "../src/daemon-trace-buckets.ts";

test("a day of one-per-second node buckets is pruned to the retention window", () => {
  const nodes = new Map<string, SecondBuckets>([
    ["node-a", new Map(Array.from({ length: 86_400 }, (_, second) => [second, 1]))],
  ]);
  pruneNodeBuckets(nodes, 86_400);
  assert.equal(nodes.get("node-a")!.size, TRACE_BUCKET_WINDOW_SECONDS);
  assert.equal(retainedNodeSeconds(nodes), TRACE_BUCKET_WINDOW_SECONDS);
  assert.equal(countSecondBuckets(nodes.get("node-a")!, 86_400_000 - 60_000), 60);
});

test("empty node maps are removed and pruning leaves newer buckets intact", () => {
  const buckets: SecondBuckets = new Map([
    [1, 1],
    [100, 2],
    [200, 3],
  ]);
  pruneSecondBuckets(buckets, 200);
  assert.deepEqual([...buckets.keys()], [100, 200]);
  const nodes = new Map<string, SecondBuckets>([["stale", new Map([[1, 1]])]]);
  pruneNodeBuckets(nodes, 200);
  assert.equal(nodes.size, 0);
});

// Loaded into a fixture daemon through `node --import` (NODE_OPTIONS) by tools/perf/baseline-suite.mjs.
// It never touches product code: it only observes the daemon process it landed in and appends one
// JSONL line per interval. Activation requires an explicit HA_PERF_EVENTLOOP_LOG target AND a
// daemon-shaped argv (`serve`/`--service`), so the same NODE_OPTIONS cannot turn an unrelated
// child (git, CLI) into a probe. The sampling timer is unref'd so it can never delay daemon exit.
import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

export function probeShouldActivate(env = process.env, argv = process.argv) {
  if (!env.HA_PERF_EVENTLOOP_LOG) return false;
  return argv.includes("serve") || argv.includes("--service");
}

export function eventLoopSnapshot(histogram, memory = process.memoryUsage(), now = Date.now()) {
  return {
    atMs: now,
    meanMs: round(histogram.mean / 1e6),
    p50Ms: round(histogram.percentile(50) / 1e6),
    p95Ms: round(histogram.percentile(95) / 1e6),
    maxMs: round(histogram.max / 1e6),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
  };
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

if (probeShouldActivate()) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    try {
      appendFileSync(process.env.HA_PERF_EVENTLOOP_LOG, `${JSON.stringify(eventLoopSnapshot(histogram))}\n`, "utf8");
      histogram.reset();
    } catch {
      // A probe must never take the measured daemon down; a failed append (full disk, removed
      // directory) is reported by the suite through the missing records, not by a daemon crash.
    }
  }, 2_000);
  timer.unref();
}

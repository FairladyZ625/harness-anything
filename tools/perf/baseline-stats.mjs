// Pure helpers shared by the baseline-suite arms. No spawns, no fixture state: everything here is
// unit-testable in the fast tier (tools/perf/baseline-suite.test.mjs).
import os from "node:os";
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function stats(values) {
  if (!Array.isArray(values) || values.length === 0)
    return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  return {
    count: values.length,
    minMs: round3(Math.min(...values)),
    p50Ms: round3(percentile(values, 50)),
    p95Ms: round3(percentile(values, 95)),
    maxMs: round3(Math.max(...values)),
  };
}

export function round3(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

export function bytesToMib(bytes) {
  return Number.isFinite(bytes) ? Math.round((bytes / (1024 * 1024)) * 10) / 10 : null;
}

// Splits probe/ps samples by wall-clock window boundaries. A sample exactly on a boundary belongs
// to the later window (>= start, < end of its window; windows are contiguous half-open ranges).
export function windowSamples(samples, windows) {
  const names = Object.keys(windows);
  const byName = Object.fromEntries(names.map((name) => [name, []]));
  for (const sample of samples) {
    for (const name of names) {
      const { startMs, endMs } = windows[name];
      if (sample.atMs >= startMs && sample.atMs < endMs) byName[name].push(sample);
    }
  }
  return byName;
}

export function summarizeEventLoopLines(lines, windows) {
  const parsed = lines.flatMap((line, index) => {
    try {
      const row = JSON.parse(line);
      return Number.isFinite(row.atMs) ? [row] : [];
    } catch {
      return [{ atMs: null, parseErrorAtLine: index }];
    }
  });
  const parseErrors = parsed.filter((row) => row.atMs === null).length;
  const byName = windowSamples(
    parsed.filter((row) => row.atMs !== null),
    windows,
  );
  const summary = {};
  for (const [name, rows] of Object.entries(byName)) {
    summary[name] = {
      samples: rows.length,
      delayP50Ms: stats(rows.map((row) => row.p50Ms)).p50Ms,
      delayP95Ms: stats(rows.map((row) => row.p95Ms)).p95Ms,
      delayMaxMs: rows.length ? round3(Math.max(...rows.map((row) => row.maxMs))) : null,
      rssMib: stats(rows.map((row) => bytesToMib(row.rssBytes))).p50Ms,
    };
  }
  return { summary, parseErrors, records: parsed.filter((row) => row.atMs !== null) };
}

export function hostSnapshot() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: os.cpus()?.[0]?.model ?? null,
    parallelism: os.availableParallelism?.() ?? null,
    totalMemMib: bytesToMib(os.totalmem?.()),
  };
}

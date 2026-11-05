import path from "node:path";
import { daemonProcessAlive, readDaemonPid } from "@harness-anything/daemon/internal/daemon-singleton";
import type { SummaryOptions } from "./probe-options.ts";
import { readDaemonLogHistory, type AvailabilityEvidence } from "./probe-log-history.ts";
import { readProbeTimeline } from "./probe-timeline.ts";

export interface TimelineSegment {
  readonly fromMs: number;
  readonly toMs: number;
  readonly durationMs: number;
}

export interface TimelineCapture {
  readonly atMs: number;
  readonly reason: string;
  readonly files: readonly string[];
}

export interface TimelineSummary {
  readonly status: "observed" | "unobserved";
  readonly samples: number;
  readonly up: number;
  readonly slow: number;
  readonly down: number;
  readonly availabilityPercent: number | null;
  readonly healthyPercent: number | null;
  readonly latency: { readonly p50Ms: number | null; readonly p95Ms: number | null; readonly maxMs: number | null };
  readonly observedFromMs: number | null;
  readonly observedToMs: number | null;
  readonly observedMs: number;
  readonly unobservedMs: number;
  readonly unobservedSegments: readonly TimelineSegment[];
  readonly downSegments: readonly TimelineSegment[];
  readonly slowSegments: readonly TimelineSegment[];
  readonly captures: readonly TimelineCapture[];
}

export interface ProbeSummaryResult {
  readonly schema: "daemon-probe-summary/v1";
  readonly ok: true;
  readonly command: "daemon-probe-summary";
  readonly daemonId: string;
  readonly window: { readonly label: string; readonly sinceMs: number; readonly untilMs: number };
  readonly probe: TimelineSummary;
  readonly logs: {
    readonly conn: {
      readonly files: number;
      readonly records: number;
      readonly requests: number;
      readonly firstAt: number | null;
      readonly lastAt: number | null;
    };
    readonly lifecycle: { readonly files: number; readonly records: number };
    readonly evidence: AvailabilityEvidence;
    readonly silent: readonly TimelineSegment[];
  };
}

export interface SummaryInput {
  readonly options: SummaryOptions;
  readonly userRoot: string;
  readonly daemonId: string;
}

export interface TimelineAccumulator {
  readonly add: (record: Readonly<Record<string, unknown>>) => void;
  readonly finish: () => TimelineSummary;
}

export async function runProbeSummary(input: SummaryInput): Promise<ProbeSummaryResult> {
  const { options } = input,
    accumulator = createTimelineAccumulator(options.sinceMs, options.untilMs);
  // The timeline is aggregated as it is read: one pass, counter/histogram/segment state only. A day
  // of samples is never retained as an array, which keeps summary memory independent of log size.
  for await (const record of readProbeTimeline({
    dir: path.join(input.userRoot, "logs"),
    daemonId: input.daemonId,
    sinceMs: options.sinceMs,
    untilMs: options.untilMs,
  }))
    accumulator.add(record);
  const currentPid = readDaemonPid(input.userRoot, input.daemonId),
    history = await readDaemonLogHistory({
      userRoot: input.userRoot,
      daemonId: input.daemonId,
      sinceMs: options.sinceMs,
      untilMs: options.untilMs,
      minSilenceMs: options.minSilenceMs,
      currentPid,
      currentPidAlive: currentPid !== null && daemonProcessAlive(currentPid),
    });
  return {
    schema: "daemon-probe-summary/v1",
    ok: true,
    command: "daemon-probe-summary",
    daemonId: input.daemonId,
    window: { label: options.windowLabel, sinceMs: options.sinceMs, untilMs: options.untilMs },
    probe: accumulator.finish(),
    logs: {
      conn: {
        files: history.conn.files,
        records: history.conn.records,
        requests: history.conn.requests,
        firstAt: history.conn.firstAt,
        lastAt: history.conn.lastAt,
      },
      lifecycle: { files: history.lifecycle.files, records: history.lifecycle.records },
      evidence: history.evidence,
      silent: history.silent,
    },
  };
}

interface RunWindow {
  startAt: number;
  stopAt: number | null;
  intervalMs: number;
  lastSampleAt: number | null;
}

interface SampleState {
  state: string;
  startAt: number;
  lastAt: number;
  intervalMs: number;
}

interface AccumulatorState {
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly counts: { up: number; slow: number; down: number };
  readonly histogram: LatencyHistogram;
  readonly runs: RunWindow[];
  readonly gaps: TimelineSegment[];
  readonly fallbackObserved: TimelineSegment[];
  readonly downSegments: TimelineSegment[];
  readonly slowSegments: TimelineSegment[];
  readonly captures: TimelineCapture[];
  samples: number;
  firstAt: number | null;
  lastAt: number | null;
  current: SampleState | null;
  fallbackGroup: SampleState | null;
  fallbackIntervalMs: number;
}

const defaultIntervalMs = 5_000;

export function createTimelineAccumulator(sinceMs: number, untilMs: number): TimelineAccumulator {
  const state: AccumulatorState = {
    sinceMs,
    untilMs,
    counts: { up: 0, slow: 0, down: 0 },
    histogram: createLatencyHistogram(),
    runs: [],
    gaps: [],
    fallbackObserved: [],
    downSegments: [],
    slowSegments: [],
    captures: [],
    samples: 0,
    firstAt: null,
    lastAt: null,
    current: null,
    fallbackGroup: null,
    fallbackIntervalMs: defaultIntervalMs,
  };
  return {
    add: (record) => addTimelineRecord(state, record),
    finish: () => finishTimeline(state),
  };
}

function activeInterval(state: AccumulatorState): number {
  for (let index = state.runs.length - 1; index >= 0; index -= 1) {
    const run = state.runs[index]!;
    if (run.stopAt === null) return run.intervalMs;
  }
  return state.fallbackIntervalMs;
}

function maxGap(intervalMs: number): number {
  return Math.max(intervalMs * 3, 15_000);
}

function closeCurrent(state: AccumulatorState, endAt: number): void {
  if (state.current === null) return;
  if (state.current.state === "down") pushSegment(state.downSegments, state.current.startAt, endAt);
  else if (state.current.state === "slow") pushSegment(state.slowSegments, state.current.startAt, endAt);
  state.current = null;
}

// Close the active run at the last evidence boundary, not at the control record. A new start/stop
// can arrive hours after the last sample (probe killed and restarted); the interval in between was
// not observed and must be reported as a gap, not as the previous state.
function closeActiveRun(state: AccumulatorState, at: number): void {
  const run = lastOpenRun(state.runs);
  if (run === null) {
    if (state.current !== null) closeCurrent(state, Math.min(at, state.current.lastAt + state.current.intervalMs));
    return;
  }
  const end = run.lastSampleAt === null ? run.startAt : Math.min(at, run.lastSampleAt + run.intervalMs);
  if (state.current !== null) closeCurrent(state, Math.min(end, state.current.lastAt + state.current.intervalMs));
  run.stopAt = end;
  if (at > end) pushSegment(state.gaps, end, at);
}

function addTimelineRecord(state: AccumulatorState, record: Readonly<Record<string, unknown>>): void {
  if (record.kind === "probe_start") {
    const at = Date.parse(String(record.at));
    if (!Number.isFinite(at) || at > state.untilMs) return;
    closeActiveRun(state, at);
    state.runs.push({ startAt: at, stopAt: null, intervalMs: startInterval(record), lastSampleAt: null });
    return;
  }
  if (record.kind === "probe_stop") {
    const at = Date.parse(String(record.at));
    if (!Number.isFinite(at) || at > state.untilMs) return;
    closeActiveRun(state, at);
    return;
  }
  if (record.kind === "capture") {
    addCapture(state, record);
    return;
  }
  if (record.kind === "sample") addSample(state, record);
}

function startInterval(record: Readonly<Record<string, unknown>>): number {
  const options = record.options;
  if (typeof options !== "object" || options === null || !("intervalMs" in options)) return defaultIntervalMs;
  const interval = (options as { readonly intervalMs?: unknown }).intervalMs;
  return typeof interval === "number" ? Math.max(250, interval) : defaultIntervalMs;
}

function addCapture(state: AccumulatorState, record: Readonly<Record<string, unknown>>): void {
  const atMs = Date.parse(String(record.at));
  if (!Number.isFinite(atMs) || atMs < state.sinceMs || atMs > state.untilMs) return;
  state.captures.push({
    atMs,
    reason: typeof record.reason === "string" ? record.reason : "unknown",
    files: Array.isArray(record.files) ? record.files.filter((file): file is string => typeof file === "string") : [],
  });
}

function addSample(state: AccumulatorState, record: Readonly<Record<string, unknown>>): void {
  const at = Date.parse(String(record.at)),
    sampleState = record.state;
  if (!Number.isFinite(at) || at < state.sinceMs || at > state.untilMs) return;
  if (sampleState !== "up" && sampleState !== "slow" && sampleState !== "down") return;
  state.samples += 1;
  state.counts[sampleState] += 1;
  if (typeof record.latencyMs === "number") state.histogram.add(record.latencyMs);
  state.firstAt = state.firstAt === null ? at : Math.min(state.firstAt, at);
  state.lastAt = state.lastAt === null ? at : Math.max(state.lastAt, at);
  const interval = sampleInterval(record, state);
  if (state.runs.length === 0) addFallbackSample(state, at, sampleState, interval);
  else addRunSample(state, at, sampleState, interval);
}

function sampleInterval(record: Readonly<Record<string, unknown>>, state: AccumulatorState): number {
  const declared = record.intervalMs;
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
    state.fallbackIntervalMs = Math.max(250, declared);
    return state.fallbackIntervalMs;
  }
  return state.runs.length === 0 ? state.fallbackIntervalMs : activeInterval(state);
}

function addFallbackSample(state: AccumulatorState, at: number, sampleState: string, intervalMs: number): void {
  const group = state.fallbackGroup;
  if (group === null) state.fallbackGroup = { state: sampleState, startAt: at, lastAt: at, intervalMs };
  else {
    const gap = at - group.lastAt;
    // Without run metadata, infer a normal interval from the first gap up to one minute so a
    // legitimate `--interval 60s` window is not split; a one-hour hole stays a hole.
    if (gap > 0 && gap <= 60_000) state.fallbackIntervalMs = Math.max(250, gap);
    const observedInterval = Math.max(intervalMs, state.fallbackIntervalMs);
    if (gap > maxGap(observedInterval)) {
      closeCurrent(state, group.lastAt + observedInterval);
      pushSegment(state.fallbackObserved, group.startAt, group.lastAt + observedInterval);
      pushSegment(state.gaps, group.lastAt + observedInterval, at);
      state.fallbackGroup = { state: sampleState, startAt: at, lastAt: at, intervalMs: observedInterval };
    } else {
      group.lastAt = at;
      group.intervalMs = observedInterval;
    }
  }
  if (state.current === null) state.current = { state: sampleState, startAt: at, lastAt: at, intervalMs };
  else if (state.current.state !== sampleState) {
    closeCurrent(state, at);
    state.current = { state: sampleState, startAt: at, lastAt: at, intervalMs };
  } else {
    state.current.lastAt = at;
    state.current.intervalMs = intervalMs;
  }
}

function addRunSample(state: AccumulatorState, at: number, sampleState: string, intervalMs: number): void {
  const run = runAt(state.runs, at),
    interval = run?.intervalMs ?? intervalMs;
  if (run !== null) run.lastSampleAt = at;
  if (state.current === null) {
    state.current = { state: sampleState, startAt: at, lastAt: at, intervalMs: interval };
    return;
  }
  const gap = at - state.current.lastAt;
  if (gap > maxGap(interval)) {
    const end = state.current.lastAt + interval;
    closeCurrent(state, end);
    pushSegment(state.gaps, end, at);
    state.current = { state: sampleState, startAt: at, lastAt: at, intervalMs: interval };
    return;
  }
  if (state.current.state !== sampleState) {
    closeCurrent(state, at);
    state.current = { state: sampleState, startAt: at, lastAt: at, intervalMs: interval };
  } else {
    state.current.lastAt = at;
    state.current.intervalMs = interval;
  }
}

function finishTimeline(state: AccumulatorState): TimelineSummary {
  if (state.current !== null) {
    const open = lastOpenRun(state.runs),
      end = Math.min(state.current.lastAt + state.current.intervalMs, open?.stopAt ?? state.untilMs);
    closeCurrent(state, Math.max(state.current.startAt, end));
  }
  const observed = state.runs.length === 0 ? finishFallback(state) : finishRuns(state);
  const merged = mergeIntervals(observed),
    observedWithoutGaps = subtractIntervals(merged, mergeIntervals(state.gaps)),
    observedMs = observedWithoutGaps.reduce((total, segment) => total + segment.durationMs, 0),
    unobservedSegments = subtractWindow(state.sinceMs, state.untilMs, observedWithoutGaps),
    unobservedMs = unobservedSegments.reduce((total, segment) => total + segment.durationMs, 0);
  return {
    status: state.samples === 0 ? "unobserved" : "observed",
    samples: state.samples,
    up: state.counts.up,
    slow: state.counts.slow,
    down: state.counts.down,
    availabilityPercent:
      state.samples === 0 ? null : round2(((state.counts.up + state.counts.slow) / state.samples) * 100),
    healthyPercent: state.samples === 0 ? null : round2((state.counts.up / state.samples) * 100),
    latency: {
      p50Ms: state.histogram.percentile(0.5),
      p95Ms: state.histogram.percentile(0.95),
      maxMs: state.histogram.maxMs(),
    },
    observedFromMs: state.firstAt,
    observedToMs: state.lastAt,
    observedMs,
    unobservedMs,
    unobservedSegments,
    downSegments: mergeIntervals(state.downSegments),
    slowSegments: mergeIntervals(state.slowSegments),
    captures: state.captures,
  };
}

function finishFallback(state: AccumulatorState): readonly TimelineSegment[] {
  const group = state.fallbackGroup;
  if (group !== null)
    pushSegment(state.fallbackObserved, group.startAt, Math.min(state.untilMs, group.lastAt + group.intervalMs));
  return state.fallbackObserved;
}

function finishRuns(state: AccumulatorState): readonly TimelineSegment[] {
  const observed: TimelineSegment[] = [];
  for (const run of state.runs) {
    const end = Math.min(
      state.untilMs,
      run.stopAt ?? (run.lastSampleAt === null ? run.startAt : run.lastSampleAt + run.intervalMs),
    );
    if (end > run.startAt)
      observed.push({
        fromMs: Math.max(state.sinceMs, run.startAt),
        toMs: end,
        durationMs: end - Math.max(state.sinceMs, run.startAt),
      });
  }
  return observed;
}

/**
 * Compatibility wrapper for small in-memory fixtures. Production summary uses the streaming
 * accumulator above; this sorts only the caller-supplied array.
 */
export function summarizeProbeTimeline(
  samples: readonly { readonly at: number; readonly state: string; readonly latencyMs: number }[],
  captures: readonly TimelineCapture[],
  sinceMs: number,
  untilMs: number,
): TimelineSummary {
  const accumulator = createTimelineAccumulator(sinceMs, untilMs);
  for (const sample of [...samples].sort((left, right) => left.at - right.at))
    accumulator.add({
      kind: "sample",
      at: new Date(sample.at).toISOString(),
      state: sample.state,
      latencyMs: sample.latencyMs,
    });
  for (const capture of captures)
    accumulator.add({
      kind: "capture",
      at: new Date(capture.atMs).toISOString(),
      reason: capture.reason,
      files: capture.files,
    });
  return accumulator.finish();
}

export function renderProbeSummary(result: ProbeSummaryResult): string {
  const { probe, logs } = result,
    lines = [
      `daemon probe summary daemon=${result.daemonId} window=${result.window.label} [${iso(result.window.sinceMs)}, ${iso(result.window.untilMs)}]`,
      probe.status === "unobserved"
        ? "probe timeline: unobserved (no samples in window; availability is unknown, not 0%)"
        : `probe timeline: samples=${probe.samples} up=${probe.up} slow=${probe.slow} down=${probe.down} availability=${probe.availabilityPercent}% healthy=${probe.healthyPercent}%`,
      probe.status === "observed"
        ? `latency ms p50=${formatNumber(probe.latency.p50Ms)} p95=${formatNumber(probe.latency.p95Ms)} max=${formatNumber(probe.latency.maxMs)}`
        : null,
      probe.status === "observed"
        ? `observed=${formatDuration(probe.observedMs)} unobserved=${formatDuration(probe.unobservedMs)}`
        : null,
      `captures=${probe.captures.length}`,
      ...probe.captures.flatMap((capture) => [
        `  ${iso(capture.atMs)} reason=${capture.reason} files=${capture.files.length === 0 ? "none" : capture.files.join(",")}`,
      ]),
      ...renderTimelineSegments("downtime segments", probe.downSegments),
      ...renderTimelineSegments("slow segments", probe.slowSegments),
      ...renderTimelineSegments("unobserved segments", probe.unobservedSegments),
      "",
      `logs: starts=${logs.evidence.starts} (${renderStartsPerDay(logs.evidence.startsPerDay)})`,
      `attach: completed=${logs.evidence.attach.count} p50=${formatMillis(logs.evidence.attach.p50Ms)} p95=${formatMillis(logs.evidence.attach.p95Ms)} max=${formatMillis(logs.evidence.attach.maxMs)} failed=${logs.evidence.attachFailed} timed-out=${logs.evidence.attachTimedOut}`,
      `unavailable: ${formatDuration(logs.evidence.downtimeMs)}`,
      ...logs.evidence.downtime.map(
        (segment) =>
          `  ${iso(segment.fromMs)} -> ${iso(segment.toMs)} ${formatDuration(segment.durationMs)} cause=${segment.cause} pid=${segment.fromPid}->${segment.toPid}`,
      ),
      `conn: files=${logs.conn.files} records=${logs.conn.records} requests=${logs.conn.requests} observed=${iso(logs.conn.firstAt)}..${iso(logs.conn.lastAt)}`,
      `lifecycle: files=${logs.lifecycle.files} records=${logs.lifecycle.records}`,
      ...logs.silent.map(
        (segment) =>
          `  silence ${iso(segment.fromMs)} -> ${iso(segment.toMs)} ${formatDuration(segment.durationMs)} (no conn activity; not proof of downtime)`,
      ),
      logs.evidence.unobservedFromMs === null
        ? null
        : `unobserved after ${iso(logs.evidence.unobservedFromMs)} (no evidence; not counted as downtime)`,
    ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function renderTimelineSegments(label: string, segments: readonly TimelineSegment[]): readonly string[] {
  if (segments.length === 0) return [];
  return [
    `${label}: ${segments.length}`,
    ...segments.map(
      (segment) => `  ${iso(segment.fromMs)} -> ${iso(segment.toMs)} ${formatDuration(segment.durationMs)}`,
    ),
  ];
}

function renderStartsPerDay(startsPerDay: Readonly<Record<string, number>>): string {
  const days = Object.entries(startsPerDay).sort(([left], [right]) => left.localeCompare(right));
  return days.length === 0 ? "none in window" : days.map(([day, count]) => `${day}: ${String(count)}`).join(", ");
}

function runAt(runs: readonly RunWindow[], at: number): RunWindow | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.startAt <= at && (run.stopAt === null || at <= run.stopAt)) return run;
  }
  return null;
}

function lastOpenRun(runs: readonly RunWindow[]): RunWindow | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (run.stopAt === null) return run;
  }
  return null;
}

function pushSegment(target: TimelineSegment[], fromMs: number, toMs: number): void {
  if (toMs <= fromMs) return;
  target.push({ fromMs, toMs, durationMs: toMs - fromMs });
}

function mergeIntervals(segments: readonly TimelineSegment[]): readonly TimelineSegment[] {
  const sorted = [...segments].sort((left, right) => left.fromMs - right.fromMs),
    merged: TimelineSegment[] = [];
  for (const segment of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && segment.fromMs <= previous.toMs)
      merged[merged.length - 1] = {
        fromMs: previous.fromMs,
        toMs: Math.max(previous.toMs, segment.toMs),
        durationMs: Math.max(previous.toMs, segment.toMs) - previous.fromMs,
      };
    else merged.push(segment);
  }
  return merged;
}

function subtractIntervals(
  source: readonly TimelineSegment[],
  cuts: readonly TimelineSegment[],
): readonly TimelineSegment[] {
  let remaining = [...source];
  for (const cut of cuts) {
    const next: TimelineSegment[] = [];
    for (const segment of remaining) {
      if (cut.toMs <= segment.fromMs || cut.fromMs >= segment.toMs) {
        next.push(segment);
        continue;
      }
      if (cut.fromMs > segment.fromMs)
        next.push({ fromMs: segment.fromMs, toMs: cut.fromMs, durationMs: cut.fromMs - segment.fromMs });
      if (cut.toMs < segment.toMs)
        next.push({ fromMs: cut.toMs, toMs: segment.toMs, durationMs: segment.toMs - cut.toMs });
    }
    remaining = next;
  }
  return remaining;
}

function subtractWindow(
  sinceMs: number,
  untilMs: number,
  observed: readonly TimelineSegment[],
): readonly TimelineSegment[] {
  return subtractIntervals([{ fromMs: sinceMs, toMs: untilMs, durationMs: untilMs - sinceMs }], observed);
}

interface LatencyHistogram {
  readonly add: (ms: number) => void;
  readonly percentile: (percentile: number) => number | null;
  readonly maxMs: () => number | null;
}

// Fixed-memory latency quantiles: 1 ms buckets below 1 s, then 10 ms/100 ms/1 s buckets. The
// approximation is only above 1 s (the console rounds those anyway), and memory stays constant for
// any number of samples.
function createLatencyHistogram(): LatencyHistogram {
  const small = new Uint32Array(1_001),
    medium = new Uint32Array(900),
    large = new Uint32Array(900),
    huge = new Uint32Array(3_501);
  let count = 0,
    max = 0;
  return {
    add: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) return;
      count += 1;
      max = Math.max(max, ms);
      const value = Math.floor(ms);
      if (value < 1_000) small[value] = (small[value] ?? 0) + 1;
      else if (value < 10_000)
        medium[Math.floor((value - 1_000) / 10)] = (medium[Math.floor((value - 1_000) / 10)] ?? 0) + 1;
      else if (value < 100_000)
        large[Math.floor((value - 10_000) / 100)] = (large[Math.floor((value - 10_000) / 100)] ?? 0) + 1;
      else huge[Math.min(huge.length - 1, Math.floor((value - 100_000) / 1_000))] += 1;
    },
    percentile: (percentile) => {
      if (count === 0) return null;
      let rank = Math.max(1, Math.ceil(percentile * count));
      for (let index = 0; index < small.length; index += 1) {
        rank -= small[index] ?? 0;
        if (rank <= 0) return index;
      }
      for (let index = 0; index < medium.length; index += 1) {
        rank -= medium[index] ?? 0;
        if (rank <= 0) return 1_000 + index * 10;
      }
      for (let index = 0; index < large.length; index += 1) {
        rank -= large[index] ?? 0;
        if (rank <= 0) return 10_000 + index * 100;
      }
      for (let index = 0; index < huge.length; index += 1) {
        rank -= huge[index] ?? 0;
        if (rank <= 0) return 100_000 + index * 1_000;
      }
      return max;
    },
    maxMs: () => (count === 0 ? null : max),
  };
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60),
    rest = seconds % 60;
  if (minutes < 120) return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m${String(rest)}s`;
  const hours = Math.floor(minutes / 60),
    remaining = minutes % 60;
  return remaining === 0 ? `${String(hours)}h` : `${String(hours)}h${String(remaining)}m`;
}

function iso(ms: number | null): string {
  return ms === null ? "unknown" : new Date(ms).toISOString();
}

function formatNumber(value: number | null): string {
  return value === null ? "unknown" : String(Math.round(value));
}

function formatMillis(value: number | null): string {
  return value === null ? "unknown" : `${String(Math.round(value))}ms`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

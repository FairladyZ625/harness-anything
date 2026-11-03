import { daemonProcessAlive, readDaemonPid } from "@harness-anything/daemon/internal/daemon-singleton";
import type { SummaryOptions } from "./probe-options.ts";
import {
  readDaemonLogHistory,
  summarizeDurations,
  type AvailabilityEvidence,
  type ConnHistory,
  type LifecycleHistory,
} from "./probe-log-history.ts";
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
    readonly conn: ConnHistory;
    readonly lifecycle: LifecycleHistory;
    readonly evidence: AvailabilityEvidence;
    readonly silent: readonly TimelineSegment[];
  };
}

export interface SummaryInput {
  readonly options: SummaryOptions;
  readonly userRoot: string;
  readonly daemonId: string;
}

export async function runProbeSummary(input: SummaryInput): Promise<ProbeSummaryResult> {
  const { options } = input,
    samples: { at: number; state: string; latencyMs: number }[] = [],
    captures: TimelineCapture[] = [];
  for await (const record of readProbeTimeline({
    dir: `${input.userRoot}/logs`,
    daemonId: input.daemonId,
    sinceMs: options.sinceMs,
    untilMs: options.untilMs,
  })) {
    if (record.kind === "sample") {
      const at = Date.parse(String(record.at)),
        latencyMs = typeof record.latencyMs === "number" ? record.latencyMs : Number.NaN;
      if (Number.isFinite(at) && typeof record.state === "string") samples.push({ at, state: record.state, latencyMs });
    } else if (record.kind === "capture") {
      const atMs = Date.parse(String(record.at));
      if (!Number.isFinite(atMs)) continue;
      captures.push({
        atMs,
        reason: typeof record.reason === "string" ? record.reason : "unknown",
        files: Array.isArray(record.files)
          ? record.files.filter((file): file is string => typeof file === "string")
          : [],
      });
    }
  }
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
    probe: summarizeProbeTimeline(samples, captures, options.sinceMs, options.untilMs),
    logs: history,
  };
}

export function summarizeProbeTimeline(
  samples: readonly { readonly at: number; readonly state: string; readonly latencyMs: number }[],
  captures: readonly TimelineCapture[],
  sinceMs: number,
  untilMs: number,
): TimelineSummary {
  const ordered = [...samples].sort((left, right) => left.at - right.at),
    counts = { up: 0, slow: 0, down: 0 };
  for (const sample of ordered)
    if (sample.state === "up" || sample.state === "slow" || sample.state === "down") counts[sample.state] += 1;
  const total = ordered.length,
    latencies = ordered.map((sample) => sample.latencyMs).filter((value) => Number.isFinite(value)),
    latency = summarizeDurations(latencies),
    interval = medianInterval(ordered, 5_000),
    downSegments: TimelineSegment[] = [],
    slowSegments: TimelineSegment[] = [];
  if (total > 0) {
    let segmentState = ordered[0]!.state,
      segmentStart = ordered[0]!.at;
    for (let index = 1; index < total; index += 1) {
      const sample = ordered[index]!;
      if (sample.state !== segmentState) {
        pushSegment(
          segmentState === "down" ? downSegments : segmentState === "slow" ? slowSegments : null,
          segmentStart,
          sample.at,
        );
        segmentState = sample.state;
        segmentStart = sample.at;
      }
    }
    pushSegment(
      segmentState === "down" ? downSegments : segmentState === "slow" ? slowSegments : null,
      segmentStart,
      ordered.at(-1)!.at + interval,
    );
  }
  return {
    status: total === 0 ? "unobserved" : "observed",
    samples: total,
    up: counts.up,
    slow: counts.slow,
    down: counts.down,
    availabilityPercent: total === 0 ? null : round2(((counts.up + counts.slow) / total) * 100),
    healthyPercent: total === 0 ? null : round2((counts.up / total) * 100),
    latency: { p50Ms: latency.p50Ms, p95Ms: latency.p95Ms, maxMs: latency.maxMs },
    observedFromMs: total === 0 ? null : ordered[0]!.at,
    observedToMs: total === 0 ? null : ordered.at(-1)!.at,
    downSegments,
    slowSegments,
    captures: captures.filter((capture) => capture.atMs >= sinceMs && capture.atMs <= untilMs),
  };
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
      `captures=${probe.captures.length}`,
      ...probe.captures.flatMap((capture) => [
        `  ${iso(capture.atMs)} reason=${capture.reason} files=${capture.files.length === 0 ? "none" : capture.files.join(",")}`,
      ]),
      ...renderTimelineSegments("downtime segments", probe.downSegments),
      ...renderTimelineSegments("slow segments", probe.slowSegments),
      "",
      `logs: starts=${logs.evidence.starts} (${renderStartsPerDay(logs.evidence.startsPerDay)})`,
      `attach: completed=${logs.evidence.attach.count} p50=${formatNumber(logs.evidence.attach.p50Ms)}ms p95=${formatNumber(logs.evidence.attach.p95Ms)}ms max=${formatNumber(logs.evidence.attach.maxMs)}ms failed=${logs.evidence.attachFailed} timed-out=${logs.evidence.attachTimedOut}`,
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

function pushSegment(target: TimelineSegment[] | null, fromMs: number, toMs: number): void {
  if (target === null || toMs <= fromMs) return;
  target.push({ fromMs, toMs, durationMs: toMs - fromMs });
}

function medianInterval(samples: readonly { readonly at: number }[], fallback: number): number {
  if (samples.length < 2) return fallback;
  const deltas = samples
    .slice(1)
    .map((sample, index) => sample.at - samples[index]!.at)
    .sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? fallback;
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

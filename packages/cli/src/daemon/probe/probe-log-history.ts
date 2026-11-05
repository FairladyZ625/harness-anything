import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { daysInRange } from "./probe-timeline.ts";

// Offline evidence is reconstructed from the daemon's own logs, never from the probe timeline. The
// two logs answer different questions: lifecycle says what the daemon intended (start/exit), conn
// says it actually served a request at a time. A generation with a start and no exit is a wedge or a
// hard kill; only conn activity can date when it stopped answering, so that case is labelled
// unrecorded-stop instead of being reported as a clean restart.
export interface ConnHistory {
  readonly files: number;
  readonly records: number;
  readonly requests: number;
  readonly firstAt: number | null;
  readonly lastAt: number | null;
  readonly lastActivityByPid: ReadonlyMap<number, number>;
  /** Last conn activity keyed by the index of the lifecycle start that owned it (PID reuse safe). */
  readonly lastActivityByStartIndex: ReadonlyMap<number, number>;
  readonly activityMinutes: Uint8Array;
}

export interface LifecycleHistory {
  readonly files: number;
  readonly records: number;
  readonly starts: readonly { readonly at: number; readonly pid: number }[];
  readonly exitsByPid: ReadonlyMap<number, readonly number[]>;
  readonly attachDurationsMs: readonly number[];
  readonly attachFailed: number;
  readonly attachTimedOut: number;
}

export interface DowntimeSegment {
  readonly fromMs: number;
  readonly toMs: number;
  readonly durationMs: number;
  readonly cause: "exited" | "unrecorded-stop";
  readonly fromPid: number;
  readonly toPid: number;
}

export interface LiveSegment {
  readonly fromMs: number;
  readonly toMs: number;
  readonly pid: number;
}

export interface AvailabilityEvidence {
  readonly starts: number;
  readonly startsPerDay: Readonly<Record<string, number>>;
  readonly attach: {
    readonly count: number;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly maxMs: number | null;
  };
  readonly attachFailed: number;
  readonly attachTimedOut: number;
  readonly downtimeMs: number;
  readonly downtime: readonly DowntimeSegment[];
  readonly live: readonly LiveSegment[];
  readonly unobservedFromMs: number | null;
  readonly lastEvidenceAt: number | null;
}

export interface LogHistory {
  readonly conn: ConnHistory;
  readonly lifecycle: LifecycleHistory;
  readonly evidence: AvailabilityEvidence;
  readonly silent: readonly { readonly fromMs: number; readonly toMs: number; readonly durationMs: number }[];
}

export interface LogHistoryOptions {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly minSilenceMs: number;
}

export async function readDaemonLogHistory(options: LogHistoryOptions): Promise<LogHistory> {
  const dir = path.join(options.userRoot, "logs"),
    lifecycle = await readLifecycleHistory(dir, options),
    // Future starts are not evidence for this cut: a `--until` snapshot must not change when the
    // live daemon restarts later, and a future start must not close the last known generation.
    startsInCut = lifecycle.starts.filter((start) => start.at <= options.untilMs),
    conn = await readConnHistory(dir, options, startsInCut),
    evidence = deriveAvailability({ ...lifecycle, starts: startsInCut }, conn, options),
    silent = computeSilentSegments(conn.activityMinutes, options.sinceMs, options.minSilenceMs);
  return { conn, lifecycle, evidence, silent };
}

// Minute buckets are the bounded-memory alternative to sorting every conn record: one byte per
// minute for the whole window (about 10 KB for seven days), independent of request volume.
async function readConnHistory(
  dir: string,
  options: LogHistoryOptions,
  starts: readonly { readonly at: number; readonly pid: number }[],
): Promise<ConnHistory> {
  const stem = `daemon-${safeId(options.daemonId)}-conn-`,
    days = daysInRange(options.sinceMs, options.untilMs),
    files = (await listLogFiles(dir)).filter(
      (entry) => connDay(entry, stem) !== null && days.includes(connDay(entry, stem)!),
    ),
    minuteCount = Math.ceil((options.untilMs - options.sinceMs) / 60_000) + 1,
    activity = new Uint8Array(Math.max(1, minuteCount)),
    lastByPid = new Map<number, number>(),
    startIndicesByPid = new Map<number, number[]>(),
    lastByStart = new Map<number, number>();
  for (const [index, start] of starts.entries())
    startIndicesByPid.set(start.pid, [...(startIndicesByPid.get(start.pid) ?? []), index]);
  let records = 0,
    filesWithEvidence = 0,
    requests = 0,
    firstAt: number | null = null,
    lastAt: number | null = null;
  for (const file of files) {
    let hasEvidence = false;
    const completed = await forEachJsonLine(path.join(dir, file), (record) => {
      const at = Date.parse(String(record.at)),
        pid = typeof record.pid === "number" ? record.pid : null;
      if (!Number.isFinite(at) || pid === null || at > options.untilMs) return;
      hasEvidence = true;
      lastByPid.set(pid, Math.max(lastByPid.get(pid) ?? 0, at));
      const generation = latestStartIndex(startIndicesByPid.get(pid) ?? [], starts, at);
      if (generation !== null) lastByStart.set(generation, Math.max(lastByStart.get(generation) ?? 0, at));
      if (at >= options.sinceMs && at <= options.untilMs) {
        records += 1;
        if (record.event === "request") requests += 1;
        firstAt = firstAt === null ? at : Math.min(firstAt, at);
        lastAt = lastAt === null ? at : Math.max(lastAt, at);
        const bucket = Math.floor((at - options.sinceMs) / 60_000);
        if (bucket >= 0 && bucket < activity.length) activity[bucket] = 1;
      }
    });
    if (completed && hasEvidence) filesWithEvidence += 1;
  }
  return {
    files: filesWithEvidence,
    records,
    requests,
    firstAt,
    lastAt,
    lastActivityByPid: lastByPid,
    lastActivityByStartIndex: lastByStart,
    activityMinutes: activity,
  };
}

async function readLifecycleHistory(dir: string, options: LogHistoryOptions): Promise<LifecycleHistory> {
  const base = `daemon-${safeId(options.daemonId)}-lifecycle.jsonl`,
    files = (await listLogFiles(dir)).filter((entry) => entry === base || entry.startsWith(`${base}.`)),
    starts: { at: number; pid: number }[] = [],
    exits = new Map<number, number[]>(),
    attachDurationsMs: number[] = [];
  let records = 0,
    filesWithEvidence = 0,
    attachFailed = 0,
    attachTimedOut = 0;
  for (const file of files) {
    let hasEvidence = false;
    const completed = await forEachJsonLine(path.join(dir, file), (record) => {
      const at = Date.parse(String(record.at)),
        pid = typeof record.pid === "number" ? record.pid : null;
      if (!Number.isFinite(at) || pid === null || at > options.untilMs) return;
      hasEvidence = true;
      records += 1;
      if (record.event === "process_start") starts.push({ at, pid });
      else if (record.event === "process_exit") exits.set(pid, [...(exits.get(pid) ?? []), at]);
      else if (record.event === "repo_attach_completed" && typeof record.durationMs === "number") {
        if (at >= options.sinceMs && at <= options.untilMs) attachDurationsMs.push(record.durationMs);
      } else if (record.event === "repo_attach_failed" && at >= options.sinceMs && at <= options.untilMs)
        attachFailed += 1;
      else if (record.event === "repo_attach_timed_out" && at >= options.sinceMs && at <= options.untilMs)
        attachTimedOut += 1;
    });
    if (completed && hasEvidence) filesWithEvidence += 1;
  }
  starts.sort((left, right) => left.at - right.at);
  for (const exitsForPid of exits.values()) exitsForPid.sort((left, right) => left - right);
  return {
    files: filesWithEvidence,
    records,
    starts,
    exitsByPid: exits,
    attachDurationsMs,
    attachFailed,
    attachTimedOut,
  };
}

export function deriveAvailability(
  lifecycle: LifecycleHistory,
  conn: ConnHistory,
  options: Pick<LogHistoryOptions, "sinceMs" | "untilMs">,
): AvailabilityEvidence {
  const starts = lifecycle.starts.filter((start) => start.at <= options.untilMs),
    live: LiveSegment[] = [],
    downtime: DowntimeSegment[] = [],
    startsPerDay: Record<string, number> = {};
  let lastEvidenceAt: number | null = conn.lastAt;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!,
      nextStart = starts[index + 1]?.at ?? null,
      exitAt = firstExitBetween(lifecycle.exitsByPid.get(start.pid) ?? [], start.at, nextStart, options.untilMs);
    let end: number;
    if (exitAt !== null) end = exitAt;
    else {
      const lastActivity = conn.lastActivityByStartIndex.get(index) ?? null;
      end = Math.max(start.at, lastActivity ?? start.at);
    }
    if (end > start.at) live.push({ fromMs: start.at, toMs: end, pid: start.pid });
    lastEvidenceAt = Math.max(lastEvidenceAt ?? 0, end, start.at);
    if (nextStart !== null && nextStart > end)
      downtime.push({
        fromMs: end,
        toMs: nextStart,
        durationMs: nextStart - end,
        cause: exitAt === null ? "unrecorded-stop" : "exited",
        fromPid: start.pid,
        toPid: starts[index + 1]!.pid,
      });
  }
  const startsInWindow = starts.filter((start) => start.at >= options.sinceMs && start.at <= options.untilMs);
  for (const start of startsInWindow)
    startsPerDay[new Date(start.at).toISOString().slice(0, 10)] =
      (startsPerDay[new Date(start.at).toISOString().slice(0, 10)] ?? 0) + 1;
  const clippedDowntime = mergeSegments(
    downtime.flatMap((segment) => {
      const fromMs = Math.max(segment.fromMs, options.sinceMs),
        toMs = Math.min(segment.toMs, options.untilMs);
      return toMs > fromMs ? [{ ...segment, fromMs, toMs, durationMs: toMs - fromMs }] : [];
    }),
  );
  const clippedLive = live.flatMap((segment) => {
    const fromMs = Math.max(segment.fromMs, options.sinceMs),
      toMs = Math.min(segment.toMs, options.untilMs);
    return toMs > fromMs ? [{ ...segment, fromMs, toMs }] : [];
  });
  const coveredTo = Math.max(
    clippedLive.reduce((max, segment) => Math.max(max, segment.toMs), Number.NEGATIVE_INFINITY),
    lastEvidenceAt ?? Number.NEGATIVE_INFINITY,
  );
  return {
    starts: startsInWindow.length,
    startsPerDay,
    attach: summarizeDurations(lifecycle.attachDurationsMs),
    attachFailed: lifecycle.attachFailed,
    attachTimedOut: lifecycle.attachTimedOut,
    downtimeMs: clippedDowntime.reduce((total, segment) => total + segment.durationMs, 0),
    downtime: clippedDowntime,
    live: clippedLive,
    unobservedFromMs: options.untilMs > coveredTo && Number.isFinite(coveredTo) ? coveredTo : null,
    lastEvidenceAt,
  };
}

export function computeSilentSegments(
  activityMinutes: Uint8Array,
  sinceMs: number,
  minSilenceMs: number,
): readonly { readonly fromMs: number; readonly toMs: number; readonly durationMs: number }[] {
  const first = activityMinutes.indexOf(1);
  if (first < 0) return [];
  let last = activityMinutes.length - 1;
  while (last >= 0 && activityMinutes[last] !== 1) last -= 1;
  const segments: { fromMs: number; toMs: number; durationMs: number }[] = [];
  let runStart: number | null = null;
  for (let index = first; index <= last; index += 1) {
    if (activityMinutes[index] === 1) {
      if (runStart !== null) {
        const fromMs = sinceMs + runStart * 60_000,
          toMs = sinceMs + index * 60_000,
          durationMs = toMs - fromMs;
        if (durationMs >= minSilenceMs) segments.push({ fromMs, toMs, durationMs });
        runStart = null;
      }
    } else if (runStart === null) runStart = index;
  }
  return segments.sort((left, right) => right.durationMs - left.durationMs).slice(0, 5);
}

export function summarizeDurations(values: readonly number[]): {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
} {
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((left, right) => left - right),
    at = (percentile: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))]!;
  return { count: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1)! };
}

// An exit only belongs to this generation when it lands before the next start of any PID; a later
// exit with the same PID belongs to the reused PID and must not close the earlier generation.
function firstExitBetween(
  exits: readonly number[],
  startAt: number,
  nextStart: number | null,
  untilMs: number,
): number | null {
  for (const exit of exits) {
    if (exit < startAt) continue;
    if (exit > untilMs) return null;
    if (nextStart !== null && exit >= nextStart) return null;
    return exit;
  }
  return null;
}

function latestStartIndex(
  indices: readonly number[],
  starts: readonly { readonly at: number }[],
  at: number,
): number | null {
  let low = 0,
    high = indices.length - 1,
    found: number | null = null;
  while (low <= high) {
    const middle = (low + high) >>> 1,
      index = indices[middle]!;
    if (starts[index]!.at <= at) {
      found = index;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

function mergeSegments(segments: readonly DowntimeSegment[]): readonly DowntimeSegment[] {
  const sorted = [...segments].sort((left, right) => left.fromMs - right.fromMs),
    merged: DowntimeSegment[] = [];
  for (const segment of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && segment.fromMs <= previous.toMs)
      merged[merged.length - 1] = {
        ...previous,
        toMs: Math.max(previous.toMs, segment.toMs),
        durationMs: Math.max(previous.toMs, segment.toMs) - previous.fromMs,
      };
    else merged.push(segment);
  }
  return merged;
}

async function listLogFiles(dir: string): Promise<readonly string[]> {
  const names = await readdir(dir).catch(() => null);
  return names ?? [];
}

async function forEachJsonLine(
  file: string,
  visit: (record: Readonly<Record<string, unknown>>) => void,
): Promise<boolean> {
  const input = createReadStream(file),
    lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const parsed = parseJsonRecord(line);
      if (parsed.ok) visit(parsed.value);
    }
    return true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return false;
  } finally {
    lines.close();
    input.close();
  }
}

type ParsedRecord = { readonly ok: true; readonly value: Readonly<Record<string, unknown>> } | { readonly ok: false };

function parseJsonRecord(line: string): ParsedRecord {
  if (!line.startsWith("{")) return { ok: false };
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ok: true, value: value as Readonly<Record<string, unknown>> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function connDay(file: string, stem: string): string | null {
  const match = new RegExp(`^${escapeRegExp(stem)}(\\d{8})\\.jsonl(?:\\.\\d+)?$`, "u").exec(file);
  return match?.[1] ?? null;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  createProbeLogSink,
  probeDayStamp,
  probeTimelinePath,
  probeTimelineStem,
  type ProbeLogSink,
} from "@harness-anything/daemon/internal/probe-log-sink";

// The availability timeline is the probe's own evidence: one JSONL line per sample or capture event,
// in the daemon's log directory and rolled by UTC day. Writes go through the daemon package's local
// log sink so the thin CLI performs no direct file writes; this module owns the record schema and
// the streaming reader.
export const DAEMON_PROBE_SCHEMA = Object.freeze({ id: "daemon-probe/v1" });

export { probeTimelinePath, probeTimelineStem };

export interface TimelineWriterOptions {
  readonly dir: string;
  readonly daemonId: string;
  readonly keptDays: number;
  readonly now?: () => Date;
  readonly onFailure?: (error: unknown) => void;
}

export interface TimelineWriter {
  readonly append: (record: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface TimelineReadOptions {
  readonly dir: string;
  readonly daemonId: string;
  readonly sinceMs: number;
  readonly untilMs: number;
}

export function createTimelineWriter(options: TimelineWriterOptions): TimelineWriter {
  const sink: ProbeLogSink = createProbeLogSink({
    dir: options.dir,
    daemonId: options.daemonId,
    keptDays: options.keptDays,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onFailure ? { onFailure: options.onFailure } : {}),
  });
  return {
    append: (record) =>
      sink.appendLine(
        `${JSON.stringify({
          schema: DAEMON_PROBE_SCHEMA.id,
          daemonId: options.daemonId,
          ...record,
        })}\n`,
      ),
    close: sink.close,
  };
}

export async function* readProbeTimeline(
  options: TimelineReadOptions,
): AsyncGenerator<Readonly<Record<string, unknown>>> {
  for (const day of daysInRange(options.sinceMs, options.untilMs)) {
    const records = await readTimelineFile(
      probeTimelinePath(options.dir, options.daemonId, day),
      options.sinceMs,
      options.untilMs,
    );
    for (const record of records) yield record;
  }
}

async function readTimelineFile(
  file: string,
  sinceMs: number,
  untilMs: number,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const input = createReadStream(file),
    lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY }),
    records: Readonly<Record<string, unknown>>[] = [];
  try {
    for await (const line of lines) {
      const parsed = parseTimelineLine(line);
      if (!parsed.ok) continue;
      const at = Date.parse(String(parsed.value.at));
      if (Number.isFinite(at) && at >= sinceMs && at <= untilMs) records.push(parsed.value);
    }
    return records;
  } catch (error) {
    // A day without a probe file is normal; any other read failure is the caller's to see.
    if (!isMissingFile(error)) throw error;
    return [];
  } finally {
    lines.close();
    input.close();
  }
}

type ParsedTimelineLine =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false };

function parseTimelineLine(line: string): ParsedTimelineLine {
  if (!line.startsWith("{")) return { ok: false };
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Readonly<Record<string, unknown>>).schema === DAEMON_PROBE_SCHEMA.id
      ? { ok: true, value: value as Readonly<Record<string, unknown>> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function daysInRange(sinceMs: number, untilMs: number): readonly string[] {
  const days: string[] = [];
  const start = Date.parse(new Date(sinceMs).toISOString().slice(0, 10) + "T00:00:00.000Z"),
    end = Date.parse(new Date(untilMs).toISOString().slice(0, 10) + "T00:00:00.000Z");
  for (let at = start; at <= end; at += 86_400_000)
    days.push(new Date(at).toISOString().slice(0, 10).replaceAll("-", ""));
  return days;
}

export function dayStamp(at: Date): string {
  return probeDayStamp(at);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

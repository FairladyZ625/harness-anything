import { cliOperationalPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { addDuration, createDurationHistogram, durationPercentile, type DurationHistogram } from "./slo-metrics.ts";

const DAY_MS = 86_400_000,
  DEFAULT_SLOW_LIMIT = cliOperationalPolicy.defaultValue.slo.defaultRows,
  MAX_SLOW_LIMIT = cliOperationalPolicy.defaultValue.slo.maximumRows;

export interface DaemonSloOptions {
  readonly day: string;
  readonly thresholdMs: number;
  readonly userRoot: string;
  readonly daemonId: string;
  readonly json: boolean;
  readonly slowLimit: number;
}

export function parseDaemonSloOptions(argv: readonly string[], userRoot: string, daemonId: string): DaemonSloOptions {
  const day = daemonSloOption(argv, "--day") ?? new Date().toISOString().slice(0, 10).replaceAll("-", ""),
    threshold = daemonSloOption(argv, "--threshold"),
    slowLimitValue = daemonSloOption(argv, "--slow-limit");
  if (!/^\d{8}$/u.test(day) || !Number.isFinite(dayWindow(day).sinceMs))
    throw invalidField(`Invalid --day ${day}; use YYYYMMDD (UTC).`);
  const thresholdMs = threshold === undefined ? 1_000 : parseMilliseconds(threshold),
    slowLimit = slowLimitValue === undefined ? DEFAULT_SLOW_LIMIT : parseSlowLimit(slowLimitValue);
  return { day, thresholdMs, userRoot, daemonId, json: argv.includes("--json"), slowLimit };
}

export async function runDaemonSlo(options: DaemonSloOptions): Promise<Record<string, unknown>> {
  const { sinceMs, untilMs } = dayWindow(options.day, Date.now()),
    requests = await readConnRequests(
      options.userRoot,
      options.daemonId,
      options.day,
      options.thresholdMs,
      options.slowLimit,
    ),
    availability = await readProbeAvailability(options.userRoot, options.daemonId, options.day, sinceMs, untilMs),
    methods = [...requests.byMethod.entries()]
      .map(([method, aggregate]) => {
        const p50 = durationPercentile(aggregate.durations, 0.5),
          p99 = durationPercentile(aggregate.durations, 0.99),
          dispatch99 = durationPercentile(aggregate.dispatchDelay, 0.99),
          service99 = durationPercentile(aggregate.service, 0.99);
        return {
          method,
          count: aggregate.count,
          errors: aggregate.errors,
          p50Ms: p50?.upperMs ?? null,
          p99Ms: p99?.upperMs ?? null,
          p99LowerMs: p99?.lowerMs ?? null,
          p99Exact: p99?.exact ?? null,
          maxMs: aggregate.durations.maxMs,
          dispatchP99Ms: dispatch99?.upperMs ?? null,
          serviceP99Ms: service99?.upperMs ?? null,
        };
      })
      .sort((left, right) => right.count - left.count),
    durationTotal = methods.reduce((total, method) => total + method.count, 0);
  return {
    schema: "daemon-slo/v1",
    ok: true,
    command: "daemon-slo",
    daemonId: options.daemonId,
    day: options.day,
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    requests: {
      count: requests.count,
      errors: requests.errors,
      errorRatePercent: requests.count === 0 ? null : round2((requests.errors / requests.count) * 100),
      byMethod: methods,
      bytes: { request: requests.requestBytes, reply: requests.replyBytes },
      traceCoverage: {
        spans: requests.traceSpans,
        sampled: durationTotal,
        percent: durationTotal === 0 ? null : round2((requests.traceSpans / durationTotal) * 100),
      },
      read: requests.read,
      overThreshold: {
        thresholdMs: options.thresholdMs,
        count: requests.overThresholdCount,
        retained: requests.overThreshold.length,
        truncated: requests.overThresholdCount > requests.overThreshold.length,
        slowLimit: options.slowLimit,
        requests: requests.overThreshold,
      },
    },
    availability,
  };
}

export function renderDaemonSlo(receipt: Record<string, unknown>): string {
  const requests = object(receipt.requests),
    availability = object(receipt.availability),
    byMethod = array(requests.byMethod),
    over = object(requests.overThreshold),
    lines = [
      sloHeader(receipt),
      requestLine(requests, object(requests.bytes)),
      ...readLines(requests, availability),
      availabilityLine(availability),
      ...downtimeLines(availability),
    ];
  lines.push(`methods: ${byMethod.length} (p99 over completed requests)`);
  for (const value of byMethod) lines.push(methodLine(value));
  lines.push(
    `over threshold >= ${String(over.thresholdMs)}ms: ${String(over.count ?? 0)} request(s); ` +
      `showing=${String(over.retained ?? 0)} truncated=${String(over.truncated ?? false)} ` +
      `slowLimit=${String(over.slowLimit ?? 0)}; span coverage=${String(object(requests.traceCoverage).percent ?? "unknown")}%`,
  );
  for (const value of array(over.requests)) lines.push(slowLine(value));
  return lines.join("\n");
}

function sloHeader(receipt: Record<string, unknown>): string {
  const window = object(receipt.window);
  return (
    `daemon slo: ${String(receipt.daemonId)} ${String(receipt.day)} ` +
    `[${String(window.since ?? "?")}, ${String(window.until ?? "?")}]`
  );
}

function requestLine(requests: Record<string, unknown>, bytes: Record<string, unknown>): string {
  return (
    `requests=${String(requests.count ?? 0)} errors=${String(requests.errors ?? 0)} ` +
    `errorRate=${String(requests.errorRatePercent ?? "unknown")}% ` +
    `bytes request=${String(bytes.request ?? 0)} reply=${String(bytes.reply ?? 0)}`
  );
}

function readLines(requests: Record<string, unknown>, availability: Record<string, unknown>): string[] {
  const read = object(requests.read),
    incomplete = array(read.incompleteLines).length + array(availability.incompleteLines).length,
    missing = array(read.missingFiles).length;
  return incomplete === 0 && missing === 0
    ? []
    : [`  read: incompleteLines=${String(incomplete)} missingFiles=${String(missing)} (excluded from denominators)`];
}

function availabilityLine(availability: Record<string, unknown>): string {
  return (
    `availability source=${String(availability.source ?? "none")} status=${String(availability.status ?? "unobserved")} ` +
    `up=${String(availability.up ?? 0)} slow=${String(availability.slow ?? 0)} down=${String(availability.down ?? 0)} ` +
    `availability=${String(availability.availabilityPercent ?? "unknown")}% ` +
    `healthy=${String(availability.healthyPercent ?? "unknown")}%`
  );
}

function downtimeLines(availability: Record<string, unknown>): string[] {
  const segments = array(availability.downtimeSegments);
  return segments.length === 0
    ? ["  downtime: none observed"]
    : segments.map((segment) => {
        const row = object(segment);
        return `  downtime ${String(row.from ?? "?")} -> ${String(row.to ?? "?")}`;
      });
}

function methodLine(value: unknown): string {
  const row = object(value);
  return (
    `  ${String(row.method)} n=${String(row.count)} p50=${String(row.p50Ms)}ms ` +
    `p99=${String(row.p99Ms)}ms${row.p99Exact === false ? `~${String(row.p99LowerMs)}-${String(row.p99Ms)}` : ""} ` +
    `max=${String(row.maxMs)}ms errors=${String(row.errors)}`
  );
}

function slowLine(value: unknown): string {
  const row = object(value);
  return (
    `  ${String(row.method)} ${String(row.durationMs)}ms at=${String(row.at)} ok=${String(row.ok)} ` +
    `node=${String(row.nodeId ?? "local")} code=${String(row.code ?? "none")}`
  );
}

export function dayWindow(day: string, nowMs = Date.now()): { readonly sinceMs: number; readonly untilMs: number } {
  const sinceMs = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00.000Z`);
  if (!Number.isFinite(sinceMs)) throw invalidField(`Invalid day ${day}.`);
  const endMs = sinceMs + DAY_MS;
  // A future UTC day has no "now" inside it; keep the full window so the report is empty, not zero-width.
  return { sinceMs, untilMs: nowMs >= sinceMs ? Math.min(endMs, nowMs) : endMs };
}

interface MethodAggregate {
  count: number;
  errors: number;
  readonly durations: DurationHistogram;
  readonly dispatchDelay: DurationHistogram;
  readonly service: DurationHistogram;
}
interface ReadState {
  file: string;
  readonly incompleteLines: number[];
  readonly missingFiles: string[];
}
interface ConnRequests {
  count: number;
  errors: number;
  requestBytes: number;
  replyBytes: number;
  traceSpans: number;
  byMethod: Map<string, MethodAggregate>;
  overThresholdCount: number;
  overThreshold: Record<string, unknown>[];
  readonly read: ReadState;
}
async function readConnRequests(
  userRoot: string,
  daemonId: string,
  day: string,
  threshold: number,
  slowLimit: number,
): Promise<ConnRequests> {
  const dir = path.join(userRoot, "logs"),
    stem = `daemon-${safeRuntimeId(daemonId)}-conn-`,
    names = (await readdirOrMissing(dir))
      .filter((name) => name.startsWith(stem) && name.includes(day) && /\.jsonl(?:\.\d+)?$/u.test(name))
      .sort((left, right) => generation(left) - generation(right)),
    aggregate: ConnRequests = {
      count: 0,
      errors: 0,
      requestBytes: 0,
      replyBytes: 0,
      traceSpans: 0,
      byMethod: new Map(),
      overThresholdCount: cliOperationalPolicy.defaultValue.slo.initialOverThresholdCount,
      overThreshold: [],
      read: { file: "", incompleteLines: [], missingFiles: [] },
    };
  for (const name of names)
    for await (const record of readJsonLines(path.join(dir, name), aggregate.read)) {
      if (record.schema !== "daemon-conn-log/v1" || record.event !== "request") continue;
      const method = typeof record.method === "string" ? record.method : "<unknown>",
        durationMs = number(record.durationMs),
        ok = record.ok === true,
        existing = aggregate.byMethod.get(method) ?? {
          count: 0,
          errors: 0,
          durations: createDurationHistogram(),
          dispatchDelay: createDurationHistogram(),
          service: createDurationHistogram(),
        };
      existing.count += 1;
      if (!ok) existing.errors += 1;
      addDuration(existing.durations, durationMs);
      addDuration(existing.dispatchDelay, number(record.dispatchDelayMs));
      addDuration(existing.service, number(record.serviceMs));
      aggregate.byMethod.set(method, existing);
      aggregate.count += 1;
      if (!ok) aggregate.errors += 1;
      aggregate.requestBytes += number(record.requestBytes);
      aggregate.replyBytes += number(record.replyBytes);
      if (typeof record.traceId === "string") aggregate.traceSpans += 1;
      if (durationMs >= threshold) {
        aggregate.overThresholdCount += 1;
        insertSlow(
          aggregate.overThreshold,
          {
            method,
            durationMs,
            at: typeof record.at === "string" ? record.at : "",
            ok,
            code: typeof record.code === "string" ? record.code : null,
            nodeId: typeof record.nodeId === "string" ? record.nodeId : null,
            requestBytes: number(record.requestBytes),
            replyBytes: number(record.replyBytes),
            phases: Array.isArray(record.phases) ? record.phases : [],
          },
          slowLimit,
        );
      }
    }
  return aggregate;
}

function insertSlow(target: Record<string, unknown>[], sample: Record<string, unknown>, limit: number): void {
  target.push(sample);
  target.sort((left, right) => number(right.durationMs) - number(left.durationMs));
  if (target.length > limit) target.length = limit;
}

interface Availability {
  readonly source: "daemon-probe/v1";
  readonly status: OperationalStatus.ObservationStatus;
  readonly samples: number;
  readonly up: number;
  readonly slow: number;
  readonly down: number;
  readonly availabilityPercent: number | null;
  readonly healthyPercent: number | null;
  readonly observedFrom: string | null;
  readonly observedTo: string | null;
  readonly downtimeSegments: readonly { readonly from: string; readonly to: string; readonly durationMs: number }[];
  readonly slowSegments: readonly { readonly from: string; readonly to: string; readonly durationMs: number }[];
  readonly incompleteLines: readonly number[];
}
async function readProbeAvailability(
  userRoot: string,
  daemonId: string,
  day: string,
  sinceMs: number,
  untilMs: number,
): Promise<Availability> {
  const file = path.join(userRoot, "logs", `daemon-${safeRuntimeId(daemonId)}-probe-${day}.jsonl`),
    samples: { at: number; state: "up" | "slow" | "down" }[] = [],
    read: ReadState = { file, incompleteLines: [], missingFiles: [] };
  for await (const record of readJsonLines(file, read)) {
    if (record.schema !== "daemon-probe/v1" || record.kind !== "sample") continue;
    const at = Date.parse(String(record.at)),
      state = record.state;
    if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
    if (state === "up" || state === "slow" || state === "down") samples.push({ at, state });
  }
  samples.sort((left, right) => left.at - right.at);
  if (samples.length === 0)
    return {
      source: "daemon-probe/v1",
      status: "unobserved",
      samples: 0,
      up: 0,
      slow: 0,
      down: 0,
      availabilityPercent: null,
      healthyPercent: null,
      observedFrom: null,
      observedTo: null,
      downtimeSegments: [],
      slowSegments: [],
      incompleteLines: read.incompleteLines,
    };
  const counts = { up: 0, slow: 0, down: 0 };
  for (const sample of samples) counts[sample.state] += 1;
  return {
    source: "daemon-probe/v1",
    status: "observed",
    samples: samples.length,
    ...counts,
    availabilityPercent: round2(((counts.up + counts.slow) / samples.length) * 100),
    healthyPercent: round2((counts.up / samples.length) * 100),
    observedFrom: new Date(samples[0]!.at).toISOString(),
    observedTo: new Date(samples.at(-1)!.at).toISOString(),
    downtimeSegments: segmentsFor(samples, "down", untilMs),
    slowSegments: segmentsFor(samples, "slow", untilMs),
    incompleteLines: read.incompleteLines,
  };
}

function segmentsFor(
  samples: readonly { readonly at: number; readonly state: string }[],
  state: "down" | "slow",
  untilMs: number,
): { from: string; to: string; durationMs: number }[] {
  const segments: { from: string; to: string; durationMs: number }[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    if (samples[index]!.state !== state) continue;
    const start = samples[index]!.at,
      next = samples.slice(index + 1).find((sample) => sample.state !== state),
      end = next?.at ?? untilMs;
    segments.push({
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      durationMs: Math.max(0, end - start),
    });
    index = next === undefined ? samples.length : samples.indexOf(next) - 1;
  }
  return segments;
}

async function* readJsonLines(file: string, state: ReadState): AsyncGenerator<Record<string, unknown>> {
  state.file = file;
  const input = createReadStream(file, { encoding: "utf8" });
  let buffer = "",
    lineNumber = 0;
  const consumeLine = function* (line: string, terminated: boolean): Generator<Record<string, unknown>> {
    if (line.trim() === "") return;
    lineNumber += 1;
    if (!terminated) {
      // A writer may be mid-append; never guess at a partial JSON object.
      state.incompleteLines.push(lineNumber);
      return;
    }
    if (!line.startsWith("{")) throw new Error(`Invalid JSON line in ${file}:${lineNumber}: expected an object`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid JSON line in ${file}:${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!record(parsed)) throw new Error(`Invalid JSON line in ${file}:${lineNumber}: JSON line is not an object`);
    yield parsed;
  };
  let missing = false;
  const iterator = input[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await iterator.next().catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
        missing = true;
        return { done: true as const, value: undefined };
      });
      if (step.done) break;
      buffer += step.value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield* consumeLine(line, true);
        newline = buffer.indexOf("\n");
      }
    }
    if (!missing && buffer.length > 0) yield* consumeLine(buffer, false);
  } finally {
    try {
      await iterator.return?.();
    } finally {
      input.destroy();
    }
  }
  if (missing) state.missingFiles.push(file);
}

async function readdirOrMissing(dir: string): Promise<string[]> {
  return readdir(dir).catch((error: unknown) => {
    if (!isMissingFile(error)) throw error;
    return [];
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function generation(name: string): number {
  return Number(/\.jsonl\.(\d+)$/u.exec(name)?.[1] ?? 0);
}
function safeRuntimeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
function daemonSloOption(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}
function parseSlowLimit(value: string): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < cliOperationalPolicy.defaultValue.slo.minimumRows ||
    parsed > MAX_SLOW_LIMIT
  )
    throw invalidField(`Invalid --slow-limit ${value}; use 1..${MAX_SLOW_LIMIT}.`);
  return parsed;
}
function parseMilliseconds(value: string): number {
  const match = /^(\d+)(ms|s)?$/u.exec(value.trim().toLowerCase());
  if (!match) throw invalidField(`Invalid --threshold ${value}; use milliseconds or s.`);
  return match[2] === "s" ? Number(match[1]) * 1_000 : Number(match[1]);
}
function invalidField(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_field" });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  return record(value) ? value : {};
}
function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Kept for command help and callers that want the diagnostics endpoint without a snapshot. */
export function daemonSloEndpoint(userRoot: string, daemonId: string): string {
  return localUserDaemonEndpoint(userRoot, daemonId);
}

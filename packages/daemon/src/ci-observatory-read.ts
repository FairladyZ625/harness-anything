import { existsSync, readFileSync } from "node:fs";
import { nonEmpty } from "./migration-import-report.ts";

/** Test outcome labels are observation data, not lifecycle state. */
const outcomeIs = (entry: { readonly status: string }, outcome: string): boolean => entry.status === outcome;
import path from "node:path";
import type { CiRunObservationEventV1, TaskProjection } from "../../kernel/src/index.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";

export interface CiObservatoryRead {
  readonly schema: "daemon.ci-observatory/v1";
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly window: number;
  readonly flakes: readonly {
    readonly test: string;
    readonly file: string;
    readonly attempts: number;
    readonly flakes: number;
    readonly flakeRate: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly quarantined: boolean;
    readonly ownerTask: string | null;
    readonly quarantinedAt: string | null;
    readonly quarantineDays: number | null;
  }[];
  readonly shardDurations: readonly { readonly shard: number; readonly durationMs: number }[];
  readonly gateTrends: readonly {
    readonly gate: string;
    readonly metric: string;
    readonly points: readonly {
      readonly runId: string;
      readonly occurredAt: string;
      readonly value: number;
      readonly pass: boolean;
    }[];
  }[];
  readonly l0MedianMs: number | null;
  readonly runs: readonly {
    readonly runId: string;
    readonly sha: string;
    readonly branch: string;
    readonly prNumber: number | null;
    readonly job: string;
    readonly wallclockMs: number;
    readonly runner: string;
    readonly occurredAt: string;
    readonly pass: boolean;
    readonly testCount: number;
    readonly gateCount: number;
  }[];
  readonly watermark: number;
  readonly sourceRevision: number;
}

type QuarantineEntry = { readonly test: string; readonly ownerTask: string; readonly quarantinedAt: string };

export class CiObservatoryContractError extends Error {
  readonly code = "invalid_result";
  constructor(message: string) {
    super(message);
    this.name = "CiObservatoryContractError";
  }
}

export function readCiObservatory(input: {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly window?: number;
  readonly now?: string;
}): CiObservatoryRead {
  const window = input.window ?? 100;
  if (!Number.isSafeInteger(window) || window < 1 || window > 100)
    throw new Error("CI observatory window must be 1..100");
  const read = input.projection.readCiRunObservations(Math.max(window * 20, 100)),
    events = selectRunWindow(read.events.filter(mainOrQueue), window),
    quarantine = new Map(readQuarantine(input.rootDir).map((entry) => [entry.test, entry])),
    now = Date.parse(input.now ?? new Date().toISOString());
  return {
    schema: "daemon.ci-observatory/v1",
    ok: true,
    status: read.status,
    window,
    flakes: flakeRows(events, quarantine, now),
    shardDurations: shardRows(events),
    gateTrends: gateRows(events),
    l0MedianMs: percentile(l0Wallclocks(events), 0.5),
    runs: events.map((event) => ({
      ...event.payload.run,
      occurredAt: event.occurredAt,
      pass:
        finalTestOutcomes(event).every((entry) => !outcomeIs(entry, "failed")) &&
        event.payload.gates.every((entry) => entry.pass),
      testCount: event.payload.tests.length,
      gateCount: event.payload.gates.length,
    })),
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}

function selectRunWindow(
  events: readonly CiRunObservationEventV1[],
  window: number,
): readonly CiRunObservationEventV1[] {
  const selected = new Set<string>();
  for (const event of events) {
    const runId = event.payload.run.runId;
    if (!selected.has(runId) && selected.size >= window) continue;
    selected.add(runId);
  }
  return events.filter((event) => selected.has(event.payload.run.runId));
}

function mainOrQueue(event: CiRunObservationEventV1): boolean {
  return event.payload.run.branch === "main" || event.payload.run.branch.startsWith("mergify/merge-queue/");
}

function isL0Job(job: string): boolean {
  return [
    "pr-body-lint",
    "typecheck",
    "fast-contract",
    "integration-shard",
    "boundaries",
    "package-policy",
    "supply-chain",
    "gui-build",
    "node26-compatibility",
  ].some((name) => job === name || job.startsWith(`${name} (`));
}

function l0Wallclocks(events: readonly CiRunObservationEventV1[]): readonly number[] {
  const runs = new Map<string, number>();
  for (const event of events)
    if (isL0Job(event.payload.run.job))
      runs.set(event.payload.run.runId, (runs.get(event.payload.run.runId) ?? 0) + event.payload.run.wallclockMs);
  return [...runs.values()];
}

function flakeRows(
  events: readonly CiRunObservationEventV1[],
  quarantine: ReadonlyMap<string, QuarantineEntry>,
  now: number,
): CiObservatoryRead["flakes"] {
  const rows = new Map<string, { file: string; durations: number[]; attempts: number; flakes: number }>();
  for (const event of events)
    for (const observation of finalTestOutcomes(event)) {
      if (outcomeIs(observation, "skipped")) continue;
      const key = observation.name,
        row = rows.get(key) ?? { file: observation.file, durations: [], attempts: 0, flakes: 0 };
      row.attempts += 1;
      row.durations.push(observation.durationMs);
      if (outcomeIs(observation, "passed") && observation.retry > 0) row.flakes += 1;
      rows.set(key, row);
    }
  return [...rows]
    .map(([test, row]) => {
      const entry = quarantine.get(test),
        quarantinedAt = entry?.quarantinedAt ?? null;
      return {
        test,
        file: row.file,
        attempts: row.attempts,
        flakes: row.flakes,
        flakeRate: row.attempts === 0 ? 0 : row.flakes / row.attempts,
        p50Ms: percentile(row.durations, 0.5) ?? 0,
        p95Ms: percentile(row.durations, 0.95) ?? 0,
        quarantined: entry !== undefined,
        ownerTask: entry?.ownerTask ?? null,
        quarantinedAt,
        quarantineDays:
          quarantinedAt === null
            ? null
            : Math.max(0, Math.floor((now - Date.parse(`${quarantinedAt}T00:00:00.000Z`)) / 86_400_000)),
      };
    })
    .sort(
      (left, right) =>
        right.flakeRate - left.flakeRate || right.p95Ms - left.p95Ms || left.test.localeCompare(right.test),
    );
}

function finalTestOutcomes(
  event: CiRunObservationEventV1,
): readonly CiRunObservationEventV1["payload"]["tests"][number][] {
  const outcomes = new Map<string, CiRunObservationEventV1["payload"]["tests"][number]>();
  for (const observation of event.payload.tests)
    outcomes.set(`${observation.file}\u0000${observation.name}`, observation);
  return [...outcomes.values()];
}

function shardRows(events: readonly CiRunObservationEventV1[]): CiObservatoryRead["shardDurations"] {
  const totals = new Map<number, number>();
  for (const event of events)
    for (const observation of event.payload.tests)
      if (observation.shard !== null)
        totals.set(observation.shard, (totals.get(observation.shard) ?? 0) + observation.durationMs);
  return [...totals].sort(([left], [right]) => left - right).map(([shard, durationMs]) => ({ shard, durationMs }));
}

function gateRows(events: readonly CiRunObservationEventV1[]): CiObservatoryRead["gateTrends"] {
  const trends = new Map<string, CiObservatoryRead["gateTrends"][number]>();
  for (const event of [...events].reverse())
    for (const gate of event.payload.gates)
      for (const [metric, value] of Object.entries(gate.metrics)) {
        const key = `${gate.gate}\u0000${metric}`,
          current = trends.get(key) ?? { gate: gate.gate, metric, points: [] };
        trends.set(key, {
          ...current,
          points: [
            ...current.points,
            { runId: event.payload.run.runId, occurredAt: event.occurredAt, value, pass: gate.pass },
          ],
        });
      }
  return [...trends.values()].sort(
    (left, right) => left.gate.localeCompare(right.gate) || left.metric.localeCompare(right.metric),
  );
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function readQuarantine(rootDir: string): readonly QuarantineEntry[] {
  const file = path.join(rootDir, "tools/test-quarantine.json");
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!isJsonObject(value) || value.schema !== "harness-test-quarantine/v1" || !Array.isArray(value.tests))
    throw new Error("test quarantine is invalid");
  const entries: QuarantineEntry[] = [],
    seen = new Set<string>();
  for (const [index, entry] of value.tests.entries()) {
    if (!isJsonObject(entry) || Object.keys(entry).some((key) => !["test", "ownerTask", "quarantinedAt"].includes(key)))
      throw new Error(`test quarantine entry ${index + 1} is invalid`);
    if (typeof entry.test !== "string" || !entry.test.trim() || seen.has(entry.test))
      throw new Error(`test quarantine entry ${index + 1} has an invalid or duplicate test name`);
    if (typeof entry.ownerTask !== "string" || !/^task_[a-zA-Z0-9]+$/u.test(entry.ownerTask))
      throw new Error(`test quarantine entry ${index + 1} requires ownerTask task_<id>`);
    if (
      typeof entry.quarantinedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(entry.quarantinedAt) ||
      !Number.isFinite(Date.parse(`${entry.quarantinedAt}T00:00:00.000Z`))
    )
      throw new Error(`test quarantine entry ${index + 1} requires quarantinedAt YYYY-MM-DD`);
    seen.add(entry.test);
    entries.push({ test: entry.test, ownerTask: entry.ownerTask, quarantinedAt: entry.quarantinedAt });
  }
  return entries;
}

export function validateCiObservatoryRead(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    value.schema !== "daemon.ci-observatory/v1" ||
    value.ok !== true ||
    !["ready", "pending"].includes(String(value.status)) ||
    !safeNonNegativeInteger(value.window) ||
    value.window < 1 ||
    !Array.isArray(value.flakes) ||
    !value.flakes.every(validFlake) ||
    !Array.isArray(value.shardDurations) ||
    !value.shardDurations.every(validShard) ||
    !Array.isArray(value.gateTrends) ||
    !value.gateTrends.every(validTrend) ||
    !(value.l0MedianMs === null || finiteNumber(value.l0MedianMs)) ||
    !Array.isArray(value.runs) ||
    !value.runs.every(validRun) ||
    !safeNonNegativeInteger(value.watermark) ||
    !safeNonNegativeInteger(value.sourceRevision)
  )
    return ["daemon ci observatory read is invalid"];
  return [];
}

function validFlake(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    nonEmpty(value.test) &&
    nonEmpty(value.file) &&
    safeNonNegativeInteger(value.attempts) &&
    safeNonNegativeInteger(value.flakes) &&
    finiteNumber(value.flakeRate) &&
    value.flakeRate >= 0 &&
    value.flakeRate <= 1 &&
    finiteNumber(value.p50Ms) &&
    value.p50Ms >= 0 &&
    finiteNumber(value.p95Ms) &&
    value.p95Ms >= 0 &&
    typeof value.quarantined === "boolean" &&
    (value.ownerTask === null || nonEmpty(value.ownerTask)) &&
    (value.quarantinedAt === null || /^\d{4}-\d{2}-\d{2}$/u.test(String(value.quarantinedAt))) &&
    (value.quarantineDays === null || safeNonNegativeInteger(value.quarantineDays))
  );
}

function validShard(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    safeNonNegativeInteger(value.shard) &&
    Number(value.shard) > 0 &&
    finiteNumber(value.durationMs) &&
    value.durationMs >= 0
  );
}

function validTrend(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    nonEmpty(value.gate) &&
    nonEmpty(value.metric) &&
    Array.isArray(value.points) &&
    value.points.every(
      (point) =>
        isJsonObject(point) &&
        nonEmpty(point.runId) &&
        isUtcLike(point.occurredAt) &&
        finiteNumber(point.value) &&
        typeof point.pass === "boolean",
    )
  );
}

function validRun(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    nonEmpty(value.runId) &&
    nonEmpty(value.sha) &&
    nonEmpty(value.branch) &&
    (value.prNumber === null || (safeNonNegativeInteger(value.prNumber) && Number(value.prNumber) > 0)) &&
    nonEmpty(value.job) &&
    finiteNumber(value.wallclockMs) &&
    value.wallclockMs >= 0 &&
    nonEmpty(value.runner) &&
    isUtcLike(value.occurredAt) &&
    typeof value.pass === "boolean" &&
    safeNonNegativeInteger(value.testCount) &&
    safeNonNegativeInteger(value.gateCount)
  );
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUtcLike(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function serializeCiObservatoryRead(value: unknown): string {
  const errors = validateCiObservatoryRead(value);
  if (errors.length) throw new CiObservatoryContractError(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}

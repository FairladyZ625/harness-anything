import { nonEmpty } from "./migration-import-report.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";

import type { CiObservationRead, TaskProjection } from "@harness-anything/kernel";

export interface CiObservatoryRead {
  readonly schema: "daemon.ci-observatory/v1";
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly window: number;
  readonly statisticsAvailability: "pending";
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
    readonly pass: boolean | null;
    readonly testCount: number | null;
    readonly measurementCoverage: CiObservationRead["payload"]["measurementCoverage"];
    readonly failedTests: CiObservationRead["payload"]["failedTests"];
    readonly fileOutcomes: CiObservationRead["payload"]["fileOutcomes"];
    readonly gateCount: number;
  }[];
  readonly watermark: number;
  readonly sourceRevision: number;
}

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
    events = selectRunWindow(read.events.filter(mainBranch), window);
  return {
    schema: "daemon.ci-observatory/v1",
    ok: true,
    status: read.status,
    window,
    flakes: [],
    statisticsAvailability: "pending",
    shardDurations: shardRows(events),
    gateTrends: gateRows(events),
    l0MedianMs: percentile(l0Wallclocks(events), 0.5),
    runs: events.map((event) => ({
      ...event.payload.run,
      occurredAt: event.occurredAt,
      pass: event.payload.verification
        ? event.payload.verification.conclusion === "success"
        : event.payload.measurementCoverage.status === "complete"
          ? event.payload.testSummary!.failed === 0 &&
            event.payload.fileOutcomes.length === 0 &&
            event.payload.gates.every((gate) => gate.result === "pass")
          : null,
      testCount: event.payload.testSummary?.observationCount ?? null,
      measurementCoverage: event.payload.measurementCoverage,
      failedTests: event.payload.failedTests,
      fileOutcomes: event.payload.fileOutcomes,
      gateCount: event.payload.gates.length,
    })),
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}

function selectRunWindow(events: readonly CiObservationRead[], window: number): readonly CiObservationRead[] {
  const selected = new Set<string>();
  for (const event of events) {
    const runId = event.payload.run.runId;
    if (!selected.has(runId) && selected.size >= window) continue;
    selected.add(runId);
  }
  return events.filter((event) => selected.has(event.payload.run.runId));
}

function mainBranch(event: CiObservationRead): boolean {
  return event.payload.run.branch === "main";
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

function l0Wallclocks(events: readonly CiObservationRead[]): readonly number[] {
  const runs = new Map<string, number>();
  for (const event of events)
    if (isL0Job(event.payload.run.job))
      runs.set(event.payload.run.runId, (runs.get(event.payload.run.runId) ?? 0) + event.payload.run.wallclockMs);
  return [...runs.values()];
}

function shardRows(events: readonly CiObservationRead[]): CiObservatoryRead["shardDurations"] {
  const totals = new Map<number, number>();
  for (const event of events)
    for (const observation of event.payload.shardDurations)
      if (observation.shard !== null)
        totals.set(observation.shard, (totals.get(observation.shard) ?? 0) + observation.durationMs);
  return [...totals].sort(([left], [right]) => left - right).map(([shard, durationMs]) => ({ shard, durationMs }));
}

function gateRows(events: readonly CiObservationRead[]): CiObservatoryRead["gateTrends"] {
  const trends = new Map<
    string,
    {
      readonly gate: string;
      readonly metric: string;
      readonly points: {
        runId: string;
        occurredAt: string;
        value: number;
        pass: boolean;
      }[];
    }
  >();
  for (const event of [...events].reverse())
    for (const gate of event.payload.gates)
      for (const [metric, value] of Object.entries(gate.metrics)) {
        const key = `${gate.gate}\u0000${metric}`,
          current = trends.get(key) ?? { gate: gate.gate, metric, points: [] };
        current.points.push({
          runId: event.payload.run.runId,
          occurredAt: event.occurredAt,
          value,
          pass: gate.result === "pass",
        });
        trends.set(key, current);
      }
  return [...trends.values()].sort(
    (left, right) => left.gate.localeCompare(right.gate) || left.metric.localeCompare(right.metric),
  );
}

function percentileOfSorted(sorted: readonly number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
}

function percentile(values: readonly number[], ratio: number): number | null {
  return percentileOfSorted(
    [...values].sort((left, right) => left - right),
    ratio,
  );
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
    (value.pass === null || typeof value.pass === "boolean") &&
    (value.testCount === null || safeNonNegativeInteger(value.testCount)) &&
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

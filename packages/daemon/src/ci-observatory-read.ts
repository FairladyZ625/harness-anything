import {
  ciRunWindow,
  ciRerunStatistics,
  validDiagnosticTest,
  type CiRunDetail,
  type ScheduleV1,
} from "@harness-anything/kernel";
import { nonEmpty } from "./migration-import-report.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";

import type { CiObservationRead, TaskProjection } from "@harness-anything/kernel";

export interface CiObservatoryRead {
  readonly schema: "daemon.ci-observatory/v1";
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly window: number;
  readonly importer: {
    readonly scheduleId: string;
    readonly activeRun: ScheduleV1["status"]["activeRun"];
    readonly lastRun: ScheduleV1["status"]["lastRun"];
    readonly progress: NonNullable<ScheduleV1["status"]["ciObserve"]> | null;
  } | null;
  readonly statisticsAvailability: "pending" | "ready";
  readonly missingDetails: readonly string[];
  readonly recoveries: ReturnType<typeof ciRerunStatistics>["recoveries"];
  readonly tests: ReturnType<typeof ciRerunStatistics>["tests"];
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
    readonly eventId: string;
    readonly identity: CiObservationRead["payload"]["identity"];
    readonly scope: CiObservationRead["payload"]["scope"];
    readonly detailAvailability: "ready" | "not_cached" | "unavailable";
    readonly detail: CiRunDetail | null;
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
  readonly includeDetails?: boolean;
  readonly readContentBlob?: (sha256: string) => Uint8Array | null;
}): CiObservatoryRead {
  const window = input.window ?? 100;
  if (!Number.isSafeInteger(window) || window < 1 || window > 100)
    throw new Error("CI observatory window must be 1..100");
  const read = input.projection.readCiRunObservations(2000);
  const all = [...read.events];
  let page = read;
  while (page.events.length === 2000) {
    const before = Math.min(...page.events.map((event) => event.workspaceRevision));
    page = input.projection.readCiRunObservations(2000, before);
    if (page.sourceRevision !== read.sourceRevision || page.watermark !== read.watermark)
      throw new Error("CI observation cut changed during pagination");
    if (page.events.some((event) => event.workspaceRevision >= before))
      throw new Error("CI observation page did not advance");
    all.push(...page.events);
  }
  const events = ciRunWindow(all, window),
    details = new Map<string, CiRunDetail>();
  for (const event of events) {
    const ref = event.payload.detailRef;
    if (!ref) continue;
    const bytes = input.readContentBlob?.(ref.sha256);
    if (!bytes) continue;
    // The canonical import boundary validates content bytes, schema and hot measurement together.
    const detail = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as CiRunDetail;
    details.set(event.eventId, detail);
  }
  const statistics = ciRerunStatistics(events, details);
  const importer = input.projection
    .listEntities("schedule")
    .map((row) => row.value as unknown as ScheduleV1)
    .find((schedule) => schedule.spec.target.kind === "builtin" && schedule.spec.target.builtinId === "ci-observe");
  return {
    schema: "daemon.ci-observatory/v1",
    ok: true,
    status: read.status,
    window,
    importer: importer
      ? {
          scheduleId: importer.scheduleId,
          activeRun: importer.status.activeRun,
          lastRun: importer.status.lastRun,
          progress: importer.status.ciObserve ?? null,
        }
      : null,
    statisticsAvailability: read.status === "ready" ? statistics.availability : "pending",
    missingDetails: statistics.missing,
    recoveries:
      read.status === "ready"
        ? statistics.recoveries
        : statistics.recoveries.map((fact) => ({ ...fact, complete: false })),
    tests: read.status === "ready" ? statistics.tests : [],
    shardDurations: shardRows(events),
    gateTrends: gateRows(events),
    l0MedianMs: percentile(l0Wallclocks(events), 0.5),
    runs: events
      .filter((event) => event.payload.scope !== "attempt")
      .map((event) => ({
        ...event.payload.run,
        eventId: event.eventId,
        identity: event.payload.identity,
        scope: event.payload.scope,
        detailAvailability: details.has(event.eventId)
          ? "ready"
          : event.payload.detailRef
            ? "not_cached"
            : "unavailable",
        detail: input.includeDetails ? (details.get(event.eventId) ?? null) : null,
        occurredAt: event.occurredAt,
        pass: event.payload.verification
          ? event.payload.verification.conclusion === "success"
            ? true
            : event.payload.verification.conclusion === "failure"
              ? false
              : null
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
  for (const event of [...events].sort(
    (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId),
  ))
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
    !validImporter(value.importer) ||
    !safeNonNegativeInteger(value.window) ||
    value.window < 1 ||
    !["pending", "ready"].includes(String(value.statisticsAvailability)) ||
    !Array.isArray(value.missingDetails) ||
    !value.missingDetails.every(nonEmpty) ||
    !Array.isArray(value.tests) ||
    !value.tests.every(validStatistic) ||
    !Array.isArray(value.recoveries) ||
    !value.recoveries.every(validRecovery) ||
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

function validStatistic(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    nonEmpty(value.identity) &&
    nonEmpty(value.file) &&
    nonEmpty(value.name) &&
    [value.families, value.recoveredFamilies, value.excludedFamilies, value.n].every(safeNonNegativeInteger) &&
    Number(value.recoveredFamilies) <= Number(value.families) &&
    (value.rerunRecoveryRate === null ||
      (finiteNumber(value.rerunRecoveryRate) && value.rerunRecoveryRate >= 0 && value.rerunRecoveryRate <= 1)) &&
    Array.isArray(value.notRerunAttempts) &&
    value.notRerunAttempts.every(
      (row) => isJsonObject(row) && nonEmpty(row.familyKey) && safeNonNegativeInteger(row.attempt) && row.attempt > 0,
    ) &&
    [value.p50Ms, value.p95Ms].every((n) => n === null || (finiteNumber(n) && n >= 0))
  );
}
function validRecovery(value: unknown): boolean {
  const ref = (v: unknown) =>
    isJsonObject(v) && nonEmpty(v.eventId) && safeNonNegativeInteger(v.attempt) && v.attempt > 0;
  return (
    isJsonObject(value) &&
    value.kind === "recoveredAfterRerun" &&
    nonEmpty(value.familyKey) &&
    nonEmpty(value.jobKey) &&
    nonEmpty(value.testKey) &&
    typeof value.complete === "boolean" &&
    ["passed", "failed", "skipped", "cancelled"].includes(String(value.finalStatus)) &&
    ref(value.from) &&
    ref(value.to)
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
    nonEmpty(value.eventId) &&
    isJsonObject(value.identity) &&
    nonEmpty(value.identity.databaseRunId) &&
    safeNonNegativeInteger(value.identity.runAttempt) &&
    ["workflow", "job", "legacy"].includes(String(value.scope)) &&
    ["ready", "not_cached", "unavailable"].includes(String(value.detailAvailability)) &&
    (value.detail === null ||
      (isJsonObject(value.detail) &&
        value.detail.schema === "ci-run-detail/v1" &&
        Array.isArray(value.detail.tests) &&
        value.detail.tests.every((test) => validDiagnosticTest(test)) &&
        Array.isArray(value.detail.fileOutcomes) &&
        Array.isArray(value.detail.diagnostics))) &&
    Array.isArray(value.failedTests) &&
    value.failedTests.every((test) => validDiagnosticTest(test)) &&
    Array.isArray(value.fileOutcomes) &&
    isJsonObject(value.measurementCoverage) &&
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

function validImporter(value: unknown): boolean {
  if (value === null) return true;
  const run = (v: unknown) =>
    v === null || (isJsonObject(v) && nonEmpty(v.occurrenceId) && nonEmpty(v.nodeId) && nonEmpty(v.claimFence));
  return (
    isJsonObject(value) &&
    nonEmpty(value.scheduleId) &&
    run(value.activeRun) &&
    run(value.lastRun) &&
    (value.progress === null ||
      (isJsonObject(value.progress) &&
        typeof value.progress.workflow === "string" &&
        safeNonNegativeInteger(value.progress.scanPass) &&
        safeNonNegativeInteger(value.progress.nextPage) &&
        (value.progress.error === null || nonEmpty(value.progress.error)) &&
        Array.isArray(value.progress.pending) &&
        value.progress.pending.every(
          (target) =>
            isJsonObject(target) && safeNonNegativeInteger(target.runId) && safeNonNegativeInteger(target.attempt),
        ) &&
        Array.isArray(value.progress.unavailable) &&
        value.progress.unavailable.every((target) => isJsonObject(target) && nonEmpty(target.reason))))
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

import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { TaskProjection } from "@harness-anything/kernel";
import { dispatchLifecycleSummary, type DispatchLifecycleSummary } from "@harness-anything/kernel";
import { coded } from "./agent-runtime-contract.ts";
import { agentRuntimeTokenUsageRangeWords } from "../runtime-engine/runtime-constants.ts";
import { dispatchStreamRelativePath, readDispatchStreamSummary } from "./dispatch-stream.ts";
import type { DispatchStreamHeader, DispatchStreamSummary } from "./dispatch-stream.ts";
import {
  sessionOutcomeFields,
  tokenUsageInsightLimits,
  tokenUsageInsights,
  tokenUsageOutcomeWords,
  validTokenUsageInsights,
} from "./agent-runtime-token-usage-insights.ts";
import type {
  AgentRuntimeTokenUsageInsights,
  AgentRuntimeTokenUsageOutcome,
  AgentRuntimeTokenUsageSessionOutcomes,
  TokenUsageDispatchFact,
} from "./agent-runtime-token-usage-insights.ts";
import { cacheWriteTokensOfUsage } from "./runtime-spawn-provider-stream.ts";
import { workRootWalk } from "@harness-anything/application/internal/queries/workspace-scope-read.ts";
import type { WorkRuleTask } from "@harness-anything/application/internal/queries/workspace-scope-read.ts";
import { modelPriceOf, modelPricingVersion, usageCostUsd } from "../runtime-engine/agent-runtime-model-pricing.ts";
import {
  collaboratorTokenUsageResult,
  validateCollaboratorTokenUsage,
  type CollaboratorTokenUsageResult,
} from "./collaborator-token-usage-read.ts";

export {
  tokenUsageInsightLimits,
  tokenUsageOutcomeWords,
  tokenUsageSessionBinCeilings,
} from "./agent-runtime-token-usage-insights.ts";
export type {
  AgentRuntimeTokenUsageOutcome,
  AgentRuntimeTokenUsageOutcomeRow,
  AgentRuntimeTokenUsageSessionBin,
  AgentRuntimeTokenUsageSessionStats,
  AgentRuntimeTokenUsageTaskRow,
  AgentRuntimeTokenUsageTopSession,
  AgentRuntimeTokenUsageTrendSeries,
  AgentRuntimeTokenUsageUnreportedProvider,
  AgentRuntimeTokenUsageWorkRow,
} from "./agent-runtime-token-usage-insights.ts";

/** One consumption counter set, summed over the dispatches each row aggregates. The field
 * names match `TaskDispatchRow.metrics` because both read the same `runtime_metrics` records. */
export interface AgentRuntimeTokenUsageCounters {
  readonly sessionCount: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
}
/** How many dispatches settled with usage numbers versus a provider that reported none, so the
 * renderer can tell "0 tokens consumed" from "provider never reported usage" (runtime_metrics
 * carries `usageUnavailable` for the latter; settled dispatches without metrics are also
 * unavailable, while live dispatches without metrics remain pending). */
export interface AgentRuntimeTokenUsageReporting {
  readonly usageReportedDispatches: number;
  readonly usageUnavailableDispatches: number;
}
/** The amount converted at public API list prices (USD), plus the total tokens it could not be
 * computed for: dispatches whose model has no tabulated price count their tokens here instead
 * of silently pricing at zero. Amounts are computed read-side against `modelPricingVersion`. */
export interface AgentRuntimeTokenUsageCost {
  readonly costUsd: number;
  readonly unpricedTokens: number;
}
/** Cache-write provenance over the dispatches a row aggregates. "Unreported" dispatches come
 * from providers whose usage carries no cache-write field at all — their zero is absence, and
 * the renderer labels it instead of showing a misleading 0. "Unitemized" dispatches settled
 * before the separate counter existed (2026-10-10): their provider did report writes, which
 * stay inside the input remainder at the input rate. */
export interface AgentRuntimeTokenUsageCacheWriteProvenance {
  readonly cacheWriteUnreportedDispatches: number;
  readonly cacheWriteUnitemizedDispatches: number;
}
export type AgentRuntimeTokenUsageTotals = AgentRuntimeTokenUsageCounters &
  AgentRuntimeTokenUsageReporting &
  AgentRuntimeTokenUsageCost &
  AgentRuntimeTokenUsageCacheWriteProvenance;
export interface AgentRuntimeTokenUsageAgentRow
  extends AgentRuntimeTokenUsageTotals,
    AgentRuntimeTokenUsageSessionOutcomes {
  readonly agentId: string;
  readonly agentName: string;
}
export interface AgentRuntimeTokenUsageSquadRow
  extends AgentRuntimeTokenUsageTotals,
    AgentRuntimeTokenUsageSessionOutcomes {
  readonly squadId: string;
  readonly squadName: string;
}
/** Consumption per model as the dispatch declared it; at most `tokenUsageInsightLimits.models` rows. */
export interface AgentRuntimeTokenUsageModelRow
  extends AgentRuntimeTokenUsageTotals,
    AgentRuntimeTokenUsageSessionOutcomes {
  readonly model: string;
}
export type AgentRuntimeTokenUsageRange = (typeof agentRuntimeTokenUsageRangeWords)[number];
export const agentRuntimeTokenUsageRanges: readonly AgentRuntimeTokenUsageRange[] = agentRuntimeTokenUsageRangeWords;
/** One time-slice of the window: `today` slices by local hour, multi-day ranges by local day.
 * `dispatchCount` counts dispatches started in the slice (session ids repeat across attempts). */
export interface AgentRuntimeTokenUsageBucket
  extends AgentRuntimeTokenUsageReporting,
    AgentRuntimeTokenUsageCacheWriteProvenance {
  readonly bucketStart: string;
  readonly dispatchCount: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
  /** List-price amount of the slice; tokens of unpriced models are in it at zero, the window
   * totals carry the unpriced share instead. */
  readonly costUsd: number;
}
export type AgentRuntimeTokenUsageResult = {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly range: AgentRuntimeTokenUsageRange;
  /** Inclusive lower bound of the window: local midnight on the daemon's clock. */
  readonly since: string;
  readonly bucketMs: number;
  readonly totals: AgentRuntimeTokenUsageTotals;
  /** The equally long span one window earlier: it starts as many local days before `since` as
   * the window covers and ends that many days before the read's `now`, so a partial window is
   * compared against the same elapsed part of the earlier one. */
  readonly previous: {
    readonly since: string;
    readonly until: string;
    readonly totals: AgentRuntimeTokenUsageTotals;
  };
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly agents: readonly AgentRuntimeTokenUsageAgentRow[];
  readonly squads: readonly AgentRuntimeTokenUsageSquadRow[];
  readonly models: readonly AgentRuntimeTokenUsageModelRow[];
  readonly tasks: AgentRuntimeTokenUsageInsights["tasks"];
  readonly works: AgentRuntimeTokenUsageInsights["works"];
  readonly sessions: AgentRuntimeTokenUsageInsights["sessions"];
  readonly outcomes: AgentRuntimeTokenUsageInsights["outcomes"];
  readonly trend: AgentRuntimeTokenUsageInsights["trend"];
  readonly unreported: AgentRuntimeTokenUsageInsights["unreported"];
  /** Which price table version the amounts were converted at; the page labels them with it. */
  readonly pricing: { readonly version: string };
  readonly watermark: number;
  readonly sourceRevision: number;
};

export type AgentRuntimeTokenUsageMember =
  | { readonly kind: "agent"; readonly agentId: string; readonly agentName: string }
  | { readonly kind: "squad"; readonly squadId: string; readonly squadName: string };
/** What the caller knows before reading: the member identity, before the stream headers
 * supply the display name. */
export type AgentRuntimeTokenUsageMemberIdentity =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "squad"; readonly squadId: string };
/** One dispatch of the member: what it consumed, which task it served, how it ended. `usage` is
 * "pending" while no runtime_metrics record exists and the process has not exited. */
export interface AgentRuntimeTokenUsageSessionRow {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly taskId: string | null;
  readonly model: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: AgentRuntimeTokenUsageOutcome;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
  readonly usage: "reported" | "unavailable" | "pending";
}

interface AgentRuntimeTokenUsageDetailPage {
  readonly limit: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}
export type AgentRuntimeTokenUsageDetailResult = {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly range: AgentRuntimeTokenUsageRange;
  readonly since: string;
  readonly bucketMs: number;
  readonly member: AgentRuntimeTokenUsageMember;
  readonly totals: AgentRuntimeTokenUsageTotals;
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly sessions: readonly AgentRuntimeTokenUsageSessionRow[];
  readonly page?: AgentRuntimeTokenUsageDetailPage;
  /** Which price table version the amounts were converted at; the page labels them with it. */
  readonly pricing: { readonly version: string };
  readonly watermark: number;
  readonly sourceRevision: number;
};

type UsageAccumulator = {
  name: string;
  sessions: Set<string>;
  usageReportedDispatches: number;
  usageUnavailableDispatches: number;
  cacheWriteUnreportedDispatches: number;
  cacheWriteUnitemizedDispatches: number;
  counters: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCallCount: number;
    costUsd: number;
    unpricedTokens: number;
  };
};

/** One dispatch's contribution to the cost columns: its own model against the price table, so
 * every accumulating view (fleet, member, model, bucket) prices the same dispatch identically.
 * Unpriced models report their token total for the unpriced share instead of a zero amount. */
function dispatchCost(
  model: string | null,
  metrics: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens?: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  } | null,
): { costUsd: number; unpricedTokens: number } {
  if (metrics === null) return { costUsd: 0, unpricedTokens: 0 };
  const price = modelPriceOf(model);
  if (price === null) return { costUsd: 0, unpricedTokens: metrics.totalTokens };
  // Pre-2026-10-10 records carry no cache-write field: their writes stay inside the
  // input remainder and price at the input rate, never as an estimate.
  return {
    costUsd: usageCostUsd(price, { ...metrics, cacheWriteTokens: metrics.cacheWriteTokens ?? 0 }),
    unpricedTokens: 0,
  };
}

/** Local calendar days in the window (inclusive of today): today keeps hour buckets, the
 * multi-day ranges one bucket per local day. The ladder stops at `now` — no future zeros. */
function planWindow(
  now: Date,
  range: AgentRuntimeTokenUsageRange,
): {
  readonly sinceMs: number;
  readonly bucketMs: number;
  readonly previousSinceMs: number;
  readonly previousUntilMs: number;
} {
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30,
    previousUntil = new Date(now);
  // Calendar arithmetic, not a fixed millisecond span: a daylight-saving day is not 24 hours.
  previousUntil.setDate(now.getDate() - days);
  return {
    sinceMs: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime(),
    bucketMs: range === "today" ? 3_600_000 : 86_400_000,
    previousSinceMs: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (2 * days - 1)).getTime(),
    previousUntilMs: previousUntil.getTime(),
  };
}

type EffectiveRuntimeMetrics = {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
  readonly usageUnavailable?: boolean;
  readonly raw?: Readonly<Record<string, unknown>>;
  readonly cacheWriteUnitemized?: boolean;
};

type TokenUsageProjection = Pick<TaskProjection, "readRuntimeDispatchPage" | "readDispatchLifecycle"> &
  Partial<Pick<TaskProjection, "readDocument" | "readTaskIndex">>;

type DetailCursor = {
  readonly startedAt: string;
  readonly dispatchId: string;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly memberKind: "agent" | "squad";
  readonly memberId: string;
  readonly personId: string | null;
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly watermark: number;
  readonly sourceRevision: number;
};

type DetailWindowSnapshot = {
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly memberName: string | null;
  readonly totals: AgentRuntimeTokenUsageTotals;
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
};

const MAX_DETAIL_SNAPSHOTS_PER_PROJECTION = 32;
const detailSnapshotCache = new WeakMap<
  object,
  readonly { readonly key: string; readonly snapshot: DetailWindowSnapshot }[]
>();

function getDetailSnapshot(projection: object, key: string): DetailWindowSnapshot | null {
  return detailSnapshotCache.get(projection)?.find((entry) => entry.key === key)?.snapshot ?? null;
}

function putDetailSnapshot(projection: object, key: string, snapshot: DetailWindowSnapshot): void {
  const retained = (detailSnapshotCache.get(projection) ?? []).filter((entry) => entry.key !== key);
  detailSnapshotCache.set(projection, [...retained, { key, snapshot }].slice(-MAX_DETAIL_SNAPSHOTS_PER_PROJECTION));
}

function compareSessionOrder(
  left: { readonly startedAt: string; readonly dispatchId: string },
  right: { readonly startedAt: string; readonly dispatchId: string },
): number {
  return (
    Date.parse(right.startedAt) - Date.parse(left.startedAt) ||
    Buffer.compare(Buffer.from(left.dispatchId), Buffer.from(right.dispatchId))
  );
}

function encodeDetailCursor(cursor: DetailCursor): string {
  return Buffer.from(
    [
      "v2",
      cursor.startedAt,
      cursor.dispatchId,
      cursor.range,
      cursor.memberKind,
      cursor.memberId,
      cursor.personId ?? "",
      String(cursor.sinceMs),
      String(cursor.untilMs),
      String(cursor.watermark),
      String(cursor.sourceRevision),
    ].join("\0"),
    "utf8",
  ).toString("base64url");
}

function parseSafeIntegerField(value: string): number | null {
  if (!/^-?\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

function decodeDetailCursor(value: string): DetailCursor | null {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== value) return null;
  const parts = decoded.split("\0");
  if (parts.length !== 11 || parts[0] !== "v2") return null;
  const [
    ,
    startedAt,
    dispatchId,
    range,
    memberKind,
    memberId,
    rawPersonId,
    rawSinceMs,
    rawUntilMs,
    rawWatermark,
    rawSourceRevision,
  ] = parts;
  if (
    !isoTimestamp(startedAt) ||
    !nonEmptyString(dispatchId) ||
    !agentRuntimeTokenUsageRanges.includes(range as AgentRuntimeTokenUsageRange) ||
    (memberKind !== "agent" && memberKind !== "squad") ||
    !nonEmptyString(memberId)
  )
    return null;
  const sinceMs = parseSafeIntegerField(rawSinceMs!),
    untilMs = parseSafeIntegerField(rawUntilMs!),
    watermark = parseSafeIntegerField(rawWatermark!),
    sourceRevision = parseSafeIntegerField(rawSourceRevision!);
  if (
    sinceMs === null ||
    untilMs === null ||
    watermark === null ||
    sourceRevision === null ||
    sinceMs > untilMs ||
    watermark < 0 ||
    sourceRevision < 0
  )
    return null;
  return {
    startedAt,
    dispatchId,
    range: range as AgentRuntimeTokenUsageRange,
    memberKind,
    memberId,
    personId: rawPersonId === "" ? null : rawPersonId!,
    sinceMs,
    untilMs,
    watermark,
    sourceRevision,
  };
}

function validArchivedRuntimeMetrics(value: unknown): value is EffectiveRuntimeMetrics {
  return (
    isRecord(value) &&
    nonNegativeInteger(value.inputTokens) &&
    nonNegativeInteger(value.cacheReadTokens) &&
    nonNegativeInteger(value.outputTokens) &&
    nonNegativeInteger(value.totalTokens) &&
    nonNegativeInteger(value.toolCallCount) &&
    (value.cacheWriteTokens === undefined || nonNegativeInteger(value.cacheWriteTokens)) &&
    typeof value.usageUnavailable === "boolean"
  );
}

function readArchivedDispatchMetrics(
  projection: TokenUsageProjection,
  taskPackageCache: Map<string, string | null>,
  event: ReturnType<TaskProjection["readRuntimeDispatchPage"]>["rows"][number]["event"],
): EffectiveRuntimeMetrics | null {
  if (!projection.readDocument) return null;
  const payload = event.payload;
  let packagePath: string | null = null;
  if (payload.taskId) {
    if (!taskPackageCache.has(payload.taskId)) {
      const taskRow = projection.readTaskIndex?.({ taskIds: [payload.taskId] }).rows[0];
      taskPackageCache.set(payload.taskId, taskRow?.packagePath ?? null);
    }
    packagePath = taskPackageCache.get(payload.taskId) ?? null;
  } else if (payload.reviewTarget?.kind === "decision" && payload.reviewTarget.decisionId) {
    packagePath = `decisions/decision-${payload.reviewTarget.decisionId}`;
  }
  if (!packagePath) return null;
  const document = projection.readDocument(`${packagePath}/artifacts/dispatches/${payload.dispatchId}.json`).document;
  if (document === null) return null;
  const parsed: unknown = JSON.parse(document.body);
  if (
    !isRecord(parsed) ||
    parsed.schema !== "runtime-dispatch/v1" ||
    !validArchivedRuntimeMetrics(parsed.runtimeMetrics)
  )
    return null;
  return parsed.runtimeMetrics;
}

function resolveDispatchEntry(
  rootDir: string,
  projection: TokenUsageProjection,
  taskPackageCache: Map<string, string | null>,
  row: ReturnType<TaskProjection["readRuntimeDispatchPage"]>["rows"][number],
): {
  readonly header: DispatchStreamHeader;
  readonly metrics: EffectiveRuntimeMetrics | null;
  readonly endedAt: string | null;
  readonly lifecycle: DispatchLifecycleSummary;
} {
  const header = projectedHeader(rootDir, row),
    summary = readDispatchStreamSummary(rootDir, header.dispatchId);
  let metrics: EffectiveRuntimeMetrics | null = summary?.runtimeMetrics ?? null;
  if (metrics === null) {
    const archived = readArchivedDispatchMetrics(projection, taskPackageCache, row.event);
    if (archived !== null) metrics = archived;
    else if (row.metrics !== null)
      metrics =
        row.metrics.usageUnavailable === true || row.metrics.cacheWriteTokens !== undefined
          ? row.metrics
          : { ...row.metrics, cacheWriteUnitemized: true };
  }
  return {
    header,
    metrics,
    endedAt: (summary === null ? null : exitOccurredAt(summary)) ?? row.endedAt,
    lifecycle: dispatchLifecycleSummary(
      projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [header.dispatchId] }),
    ),
  };
}

/** Stream window dispatches from the indexed canonical runtime dispatch page; only in-window
 * matching dispatches probe local stream summaries, falling back to archived dispatch metrics
 * and then canonical settlement metrics when the dispatch ran on an edge node. */
function windowDispatches(
  rootDir: string,
  projection: TokenUsageProjection,
  query: {
    readonly startedAtGte: string;
    readonly startedAtLte?: string;
    readonly agentId?: string;
    readonly squadId?: string;
    readonly personId?: string;
    readonly order?: "asc" | "desc";
    readonly maxRevision?: number;
  },
  pick: (header: DispatchStreamHeader) => boolean,
  visit: (entry: {
    readonly header: DispatchStreamHeader;
    readonly metrics: EffectiveRuntimeMetrics | null;
    readonly endedAt: string | null;
    readonly lifecycle: DispatchLifecycleSummary;
  }) => void,
): void {
  const seen = new Set<string>(),
    taskPackageCache = new Map<string, string | null>(),
    minMs = Date.parse(query.startedAtGte),
    maxMs = query.startedAtLte === undefined ? null : Date.parse(query.startedAtLte);
  let cursor: { readonly startedAt: string; readonly dispatchId: string } | undefined;
  for (;;) {
    const page = projection.readRuntimeDispatchPage({
      ...query,
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    for (const row of page.rows) {
      const header = projectedHeader(rootDir, row),
        startedMs = Date.parse(header.startedAt);
      if (
        !Number.isFinite(startedMs) ||
        (Number.isFinite(minMs) && startedMs < minMs) ||
        (maxMs !== null && Number.isFinite(maxMs) && startedMs > maxMs) ||
        (query.personId !== undefined && row.event.actor.principal.personId !== query.personId) ||
        !pick(header) ||
        seen.has(header.dispatchId)
      )
        continue;
      seen.add(header.dispatchId);
      visit(resolveDispatchEntry(rootDir, projection, taskPackageCache, row));
    }
    if (page.done) break;
    if (!page.nextCursor) throw new Error("runtime dispatch page is incomplete without a next cursor");
    cursor = page.nextCursor;
  }
}

function projectedHeader(
  rootDir: string,
  row: ReturnType<TaskProjection["readRuntimeDispatchPage"]>["rows"][number],
): DispatchStreamHeader {
  const payload = row.event.payload;
  return {
    schema: "runtime-dispatch-stream/v1",
    kind: "dispatch",
    dispatchId: payload.dispatchId,
    runtimeSessionId: payload.runtimeSessionId,
    instanceId: payload.instanceId,
    startedAt: payload.startedAt ?? row.event.occurredAt,
    eventStreamRef: `file:${dispatchStreamRelativePath(rootDir, payload.dispatchId)}`,
    taskId: payload.taskId ?? null,
    executionId: payload.executionId ?? null,
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.agentName ? { agentName: payload.agentName } : {}),
    ...(payload.squadId ? { squadId: payload.squadId } : {}),
    ...(payload.kindId ? { kindId: payload.kindId } : {}),
    ...(payload.definitionSnapshot.model ? { model: payload.definitionSnapshot.model } : {}),
  };
}

/**
 * The consumption aggregate for the requested range, read-only. The dispatch stream headers
 * carry the attribution (agentId/agentName/squadId/model/taskId/startedAt) and each stream
 * summary carries the latest `runtime_metrics` record, so the renderer gets one aggregate —
 * totals, the previous period, trend, member and model rows, and the analysis groups —
 * instead of pulling every dispatch row. Dispatches without agent or squad attribution are not
 * part of those two views; the session count still includes dispatches whose metrics have not
 * been emitted yet.
 */
export function readAgentRuntimeTokenUsage(input: {
  readonly rootDir: string;
  readonly now: string;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly entityLabel: (squadId: string) => string | null;
  readonly taskOf: (taskId: string) => WorkRuleTask | undefined;
  readonly projection: TokenUsageProjection;
  readonly cut: {
    readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
}): AgentRuntimeTokenUsageResult {
  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime())) throw new Error(`Agent runtime token usage now is invalid: ${input.now}.`);
  const { sinceMs, bucketMs, previousSinceMs, previousUntilMs } = planWindow(now, input.range),
    agents = new Map<string, UsageAccumulator>(),
    squads = new Map<string, UsageAccumulator>(),
    models = new Map<string, UsageAccumulator>(),
    // The totals strip and the trend answer "how much / when" for the whole window — every
    // dispatch counts exactly once here, while the member rows below stay attribution views
    // (a dispatch carrying both agent and squad attribution appears in both rows).
    fleet = new Map<string, UsageAccumulator>(),
    previous = new Map<string, UsageAccumulator>(),
    buckets = bucketLadder(sinceMs, now.getTime(), bucketMs),
    facts: TokenUsageDispatchFact[] = [],
    startedMs = (header: DispatchStreamHeader): number => Date.parse(header.startedAt);
  let pending = input.cut.status === "pending";
  // One walk covers both periods; the tail of the earlier window past `previousUntil` belongs
  // to neither, so its streams are never opened.
  windowDispatches(
    input.rootDir,
    input.projection,
    { startedAtGte: new Date(previousSinceMs).toISOString() },
    (candidate) => startedMs(candidate) < previousUntilMs || startedMs(candidate) >= sinceMs,
    ({ header, metrics, endedAt, lifecycle }) => {
      pending ||= lifecycle.status === "pending";
      if (startedMs(header) < sinceMs) {
        accumulate(previous, "", "", header, metrics, lifecycle);
        return;
      }
      accumulateBucket(buckets, header.startedAt, header.model ?? null, metrics, sinceMs, bucketMs, lifecycle);
      accumulate(fleet, "", "", header, metrics, lifecycle);
      if (header.agentId)
        accumulate(agents, header.agentId, header.agentName ?? header.agentId, header, metrics, lifecycle);
      if (header.squadId)
        accumulate(
          squads,
          header.squadId,
          input.entityLabel(header.squadId) ?? header.squadId,
          header,
          metrics,
          lifecycle,
        );
      if (header.model) accumulate(models, header.model, header.model, header, metrics, lifecycle);
      facts.push({
        ...sessionRowOf(header, metrics, endedAt, lifecycle),
        agentId: header.agentId ?? null,
        agentName: header.agentName ?? null,
        kindId: header.kindId ?? null,
        instanceId: header.instanceId,
        bucketIndex: bucketIndexOf(buckets.length, header.startedAt, sinceMs, bucketMs),
      });
    },
  );
  const { sessionOutcome, ...insights } = tokenUsageInsights({
      facts,
      bucketCount: buckets.length,
      taskOf: input.taskOf,
      workOf: (taskId) => workRootWalk(taskId, input.taskOf),
    }),
    rowOf = (accumulator: UsageAccumulator) => ({
      ...countersOf(accumulator),
      ...sessionOutcomesOf(accumulator, sessionOutcome),
    });
  return {
    ok: true,
    status: pending ? "pending" : "ready",
    range: input.range,
    since: new Date(sinceMs).toISOString(),
    bucketMs,
    totals: countersOf(fleet.get("") ?? emptyAccumulator()),
    previous: {
      since: new Date(previousSinceMs).toISOString(),
      until: new Date(previousUntilMs).toISOString(),
      totals: countersOf(previous.get("") ?? emptyAccumulator()),
    },
    buckets,
    agents: [...agents].map(([agentId, row]) => ({ agentId, agentName: row.name, ...rowOf(row) })).sort(compareRows),
    squads: [...squads].map(([squadId, row]) => ({ squadId, squadName: row.name, ...rowOf(row) })).sort(compareRows),
    models: [...models]
      .map(([model, row]) => ({ model, ...rowOf(row) }))
      .sort(compareRows)
      .slice(0, tokenUsageInsightLimits.models),
    ...insights,
    pricing: { version: modelPricingVersion },
    watermark: input.cut.watermark,
    sourceRevision: input.cut.sourceRevision,
  };
}

/**
 * The member-scoped companion read: the same window and the same dispatch stream summaries,
 * filtered to one agent or squad, with one row per dispatch so the detail page can link each
 * consumption to its session and task.
 */
export function readAgentRuntimeTokenUsageDetail(input: {
  readonly rootDir: string;
  readonly now: string;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly member: AgentRuntimeTokenUsageMemberIdentity;
  readonly personId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly entityLabel: (squadId: string) => string | null;
  readonly projection: TokenUsageProjection;
  readonly cut: {
    readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
}): AgentRuntimeTokenUsageDetailResult {
  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime())) throw new Error(`Agent runtime token usage now is invalid: ${input.now}.`);
  const maxLimit = storageReadPolicy.defaultValue.pageSizes.standard,
    paginated = input.limit !== undefined || input.cursor !== undefined,
    limit = input.limit ?? maxLimit;
  if (input.limit !== undefined && (!positiveInteger(input.limit) || input.limit > maxLimit))
    throw coded("invalid_command", `Token usage detail limit must be an integer from 1 to ${maxLimit}.`);
  const decodedCursor = input.cursor === undefined ? null : decodeDetailCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null)
    throw coded("invalid_cursor", "Token usage detail cursor is invalid.");
  const member = input.member,
    memberId = member.kind === "agent" ? member.agentId : member.squadId,
    personId = input.personId ?? null;
  if (
    decodedCursor !== null &&
    (decodedCursor.range !== input.range ||
      decodedCursor.memberKind !== member.kind ||
      decodedCursor.memberId !== memberId ||
      decodedCursor.personId !== personId ||
      decodedCursor.watermark > input.cut.watermark)
  )
    throw coded("invalid_cursor", "Token usage detail cursor does not match the requested window or member.");
  const initialWindow = planWindow(now, input.range),
    sinceMs = decodedCursor === null ? initialWindow.sinceMs : decodedCursor.sinceMs,
    untilMs = decodedCursor === null ? now.getTime() : decodedCursor.untilMs,
    bucketMs = initialWindow.bucketMs,
    pinnedWatermark = decodedCursor === null ? input.cut.watermark : decodedCursor.watermark,
    pinnedSourceRevision = decodedCursor === null ? input.cut.sourceRevision : decodedCursor.sourceRevision,
    memberQuery = member.kind === "agent" ? { agentId: member.agentId } : { squadId: member.squadId },
    personQuery = personId === null ? {} : { personId },
    pickMember =
      member.kind === "agent"
        ? (header: DispatchStreamHeader) => header.agentId === member.agentId
        : (header: DispatchStreamHeader) => header.squadId === member.squadId,
    formatMember = (memberName: string | null): AgentRuntimeTokenUsageMember =>
      member.kind === "agent"
        ? { kind: "agent", agentId: member.agentId, agentName: memberName ?? member.agentId }
        : {
            kind: "squad",
            squadId: member.squadId,
            squadName: input.entityLabel(member.squadId) ?? member.squadId,
          };

  // F10: unpaginated callers (GUI & previous-version 12-key decoders) retain full session return
  // and exact 12-key wire shape without emitting `page` or truncating at 500 sessions.
  if (!paginated) {
    const buckets = bucketLadder(sinceMs, untilMs, bucketMs),
      totals = new Map<string, UsageAccumulator>(),
      sessions: AgentRuntimeTokenUsageSessionRow[] = [];
    let pending = input.cut.status === "pending";
    let memberName: string | null = null;
    windowDispatches(
      input.rootDir,
      input.projection,
      {
        ...memberQuery,
        ...personQuery,
        startedAtGte: new Date(sinceMs).toISOString(),
        order: "desc",
        maxRevision: pinnedWatermark,
      },
      pickMember,
      ({ header, metrics, endedAt, lifecycle }) => {
        pending ||= lifecycle.status === "pending";
        if (memberName === null && member.kind === "agent") memberName = header.agentName ?? member.agentId;
        accumulate(totals, "", "", header, metrics, lifecycle);
        accumulateBucket(buckets, header.startedAt, header.model ?? null, metrics, sinceMs, bucketMs, lifecycle);
        sessions.push(sessionRowOf(header, metrics, endedAt, lifecycle));
      },
    );
    sessions.sort(compareSessionOrder);
    return {
      ok: true,
      status: pending ? "pending" : "ready",
      range: input.range,
      since: new Date(sinceMs).toISOString(),
      bucketMs,
      member: formatMember(memberName),
      totals: countersOf(totals.get("") ?? emptyAccumulator()),
      buckets,
      sessions,
      pricing: { version: modelPricingVersion },
      watermark: pinnedWatermark,
      sourceRevision: pinnedSourceRevision,
    };
  }

  const startedAtGte = new Date(sinceMs).toISOString(),
    startedAtLte = new Date(untilMs).toISOString(),
    snapshotKey = [
      input.rootDir,
      input.range,
      member.kind,
      memberId,
      personId ?? "",
      String(sinceMs),
      String(untilMs),
      String(pinnedWatermark),
      String(pinnedSourceRevision),
    ].join("\0"),
    makeNextCursor = (row: AgentRuntimeTokenUsageSessionRow): string =>
      encodeDetailCursor({
        startedAt: row.startedAt,
        dispatchId: row.dispatchId,
        range: input.range,
        memberKind: member.kind,
        memberId,
        personId,
        sinceMs,
        untilMs,
        watermark: pinnedWatermark,
        sourceRevision: pinnedSourceRevision,
      });

  // F11 + F13: continuation pages hit the cached pinned-window aggregate and seek directly to
  // `(startedAt DESC, dispatchId ASC)` in a single `limit`-sized storage page, avoiding O(W^2) scans.
  const cachedSnapshot = decodedCursor === null ? null : getDetailSnapshot(input.projection, snapshotKey);
  if (decodedCursor !== null && cachedSnapshot !== null) {
    const taskPackageCache = new Map<string, string | null>(),
      page = input.projection.readRuntimeDispatchPage({
        ...memberQuery,
        ...personQuery,
        startedAtGte,
        startedAtLte,
        order: "desc",
        maxRevision: pinnedWatermark,
        cursor: { startedAt: decodedCursor.startedAt, dispatchId: decodedCursor.dispatchId },
        limit,
      }),
      sessions: AgentRuntimeTokenUsageSessionRow[] = [];
    let pending = cachedSnapshot.status === "pending";
    for (const row of page.rows) {
      const entry = resolveDispatchEntry(input.rootDir, input.projection, taskPackageCache, row);
      if (!pickMember(entry.header)) continue;
      pending ||= entry.lifecycle.status === "pending";
      sessions.push(sessionRowOf(entry.header, entry.metrics, entry.endedAt, entry.lifecycle));
    }
    const nextCursor = !page.done && sessions.length > 0 ? makeNextCursor(sessions.at(-1)!) : null;
    return {
      ok: true,
      status: pending ? "pending" : "ready",
      range: input.range,
      since: startedAtGte,
      bucketMs,
      member: formatMember(cachedSnapshot.memberName),
      totals: cachedSnapshot.totals,
      buckets: cachedSnapshot.buckets,
      sessions,
      page: { limit, cursor: input.cursor ?? null, nextCursor },
      pricing: { version: modelPricingVersion },
      watermark: pinnedWatermark,
      sourceRevision: pinnedSourceRevision,
    };
  }

  // First page (or cold cache miss): compute the pinned window snapshot once and retain only
  // `limit + 1` page candidates in memory while caching the frozen totals/buckets for follow-up pages.
  const buckets = bucketLadder(sinceMs, untilMs, bucketMs),
    totals = new Map<string, UsageAccumulator>(),
    pageCandidates: AgentRuntimeTokenUsageSessionRow[] = [],
    candidateCap = limit + storageReadPolicy.defaultValue.minimumRows;
  let pending = input.cut.status === "pending";
  let memberName: string | null = null;
  windowDispatches(
    input.rootDir,
    input.projection,
    {
      ...memberQuery,
      ...personQuery,
      startedAtGte,
      startedAtLte,
      order: "desc",
      maxRevision: pinnedWatermark,
    },
    pickMember,
    ({ header, metrics, endedAt, lifecycle }) => {
      pending ||= lifecycle.status === "pending";
      if (memberName === null && member.kind === "agent") memberName = header.agentName ?? member.agentId;
      accumulate(totals, "", "", header, metrics, lifecycle);
      accumulateBucket(buckets, header.startedAt, header.model ?? null, metrics, sinceMs, bucketMs, lifecycle);
      if (decodedCursor === null || compareSessionOrder(decodedCursor, header) < 0) {
        pageCandidates.push(sessionRowOf(header, metrics, endedAt, lifecycle));
        if (pageCandidates.length > candidateCap) {
          pageCandidates.sort(compareSessionOrder);
          pageCandidates.length = candidateCap;
        }
      }
    },
  );
  pageCandidates.sort(compareSessionOrder);
  const frozenTotals = countersOf(totals.get("") ?? emptyAccumulator()),
    snapshotStatus: ProjectionStatus.ReadSetProjectionCut["status"] = pending ? "pending" : "ready",
    hasMore = pageCandidates.length > limit,
    sessions = hasMore ? pageCandidates.slice(0, limit) : pageCandidates,
    nextCursor = hasMore && sessions.length > 0 ? makeNextCursor(sessions.at(-1)!) : null;
  putDetailSnapshot(input.projection, snapshotKey, {
    status: snapshotStatus,
    memberName,
    totals: frozenTotals,
    buckets,
  });
  return {
    ok: true,
    status: snapshotStatus,
    range: input.range,
    since: startedAtGte,
    bucketMs,
    member: formatMember(memberName),
    totals: frozenTotals,
    buckets,
    sessions,
    page: { limit, cursor: input.cursor ?? null, nextCursor },
    pricing: { version: modelPricingVersion },
    watermark: pinnedWatermark,
    sourceRevision: pinnedSourceRevision,
  };
}

/**
 * The repo-cell handlers for `repo.agentRuntime.tokenUsage` / `repo.agentRuntime.tokenUsageDetail`.
 * The squad display name comes from the entity projection, guarded by the same ready-cut check
 * the session-groups read uses.
 */
export function agentRuntimeTokenUsageHandler(context: {
  readonly rootDir: string;
  readonly now: () => string;
  readonly projection: Pick<
    TaskProjection,
    "readCut" | "getEntity" | "readRuntimeDispatchPage" | "readTaskIndex" | "readDispatchLifecycle" | "readDocument"
  >;
  readonly range: AgentRuntimeTokenUsageRange;
}): AgentRuntimeTokenUsageResult {
  const cut = context.projection.readCut();
  return readAgentRuntimeTokenUsage({
    rootDir: context.rootDir,
    now: context.now(),
    range: context.range,
    entityLabel: entityLabelOf(cut, context.projection),
    taskOf: taskOf(cut, context.projection),
    cut,
    projection: context.projection,
  });
}
export function agentRuntimeTokenUsageDetailHandler(context: {
  readonly rootDir: string;
  readonly now: () => string;
  readonly projection: Pick<
    TaskProjection,
    "readCut" | "getEntity" | "readRuntimeDispatchPage" | "readTaskIndex" | "readDispatchLifecycle" | "readDocument"
  >;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly member: AgentRuntimeTokenUsageMemberIdentity;
  readonly limit?: number;
  readonly cursor?: string;
}): AgentRuntimeTokenUsageDetailResult {
  const cut = context.projection.readCut();
  return readAgentRuntimeTokenUsageDetail({
    rootDir: context.rootDir,
    now: context.now(),
    range: context.range,
    member: context.member,
    ...(context.limit === undefined ? {} : { limit: context.limit }),
    ...(context.cursor === undefined ? {} : { cursor: context.cursor }),
    entityLabel: entityLabelOf(cut, context.projection),
    cut,
    projection: context.projection,
  });
}
/** Payload selector parsers for the repo-cell handlers: they return null on an invalid
 * selector so the cell layer owns the error envelope; the vocabulary stays with the read. */
export function agentRuntimeTokenUsageRangeOf(
  value: Readonly<Record<string, unknown>>,
): AgentRuntimeTokenUsageRange | null {
  if (value.range === undefined) return "today";
  return agentRuntimeTokenUsageRanges.includes(value.range as AgentRuntimeTokenUsageRange)
    ? (value.range as AgentRuntimeTokenUsageRange)
    : null;
}
export function agentRuntimeTokenUsageMemberOf(
  value: Readonly<Record<string, unknown>>,
): AgentRuntimeTokenUsageMemberIdentity | null {
  const fields = Object.keys(value).filter((field) => !["range", "limit", "cursor"].includes(field));
  if (fields.length !== 1 || !["agentId", "squadId"].includes(fields[0] ?? "")) return null;
  const id = typeof value[fields[0]!] === "string" && value[fields[0]!] !== "" ? (value[fields[0]!] as string) : null;
  return id === null ? null : fields[0] === "agentId" ? { kind: "agent", agentId: id } : { kind: "squad", squadId: id };
}

/** The repo-cell handler pair for both token usage reads, selector validation included:
 * the read module owns its wire selectors end to end; the cell layer only registers them. */
export function agentRuntimeTokenUsageReadHandlers(context: {
  readonly rootDir: string;
  readonly now: () => string;
  readonly projection: Pick<
    TaskProjection,
    | "readCut"
    | "getEntity"
    | "readRuntimeDispatchPage"
    | "readTaskIndex"
    | "readDispatchLifecycle"
    | "readDocument"
    | "readRuntimeSessionEventsByType"
  >;
  readonly cellCodedError: (code: string, text: string) => Error;
}): {
  readonly "repo.agentRuntime.tokenUsage": (
    payload: Readonly<Record<string, unknown>>,
  ) => AgentRuntimeTokenUsageResult | CollaboratorTokenUsageResult;
  readonly "repo.agentRuntime.tokenUsageDetail": (
    payload: Readonly<Record<string, unknown>>,
  ) => AgentRuntimeTokenUsageDetailResult;
} {
  return {
    "repo.agentRuntime.tokenUsage": (payload) => {
      const range = agentRuntimeTokenUsageRangeOf(payload);
      if (range === null)
        throw context.cellCodedError("invalid_command", "Token usage range must be today, 7d or 30d.");
      const { scopePersonId, filterPersonId, filterNodeId } = payload;
      const groupBy =
        payload.groupBy ??
        (scopePersonId !== undefined || filterPersonId !== undefined
          ? "person"
          : filterNodeId !== undefined
            ? "node"
            : null);
      if (groupBy === "person" || groupBy === "node") {
        const { sinceMs } = planWindow(new Date(context.now()), range);
        return collaboratorTokenUsageResult(
          context.projection,
          {
            startedAtGte: new Date(sinceMs).toISOString(),
            ...(typeof scopePersonId === "string" ? { scopePersonId } : {}),
            ...(typeof filterPersonId === "string" ? { filterPersonId } : {}),
            ...(typeof filterNodeId === "string" ? { filterNodeId } : {}),
          },
          groupBy,
        );
      }
      return agentRuntimeTokenUsageHandler({ ...context, range });
    },
    "repo.agentRuntime.tokenUsageDetail": (payload) => {
      const range = agentRuntimeTokenUsageRangeOf(payload),
        member = agentRuntimeTokenUsageMemberOf(payload);
      if (range === null)
        throw context.cellCodedError("invalid_command", "Token usage range must be today, 7d or 30d.");
      if (member === null)
        throw context.cellCodedError(
          "invalid_command",
          "Token usage detail requires exactly one of agentId or squadId.",
        );
      const limit = payload.limit === undefined ? undefined : payload.limit,
        maxLimit = storageReadPolicy.defaultValue.pageSizes.standard;
      if (limit !== undefined && (!positiveInteger(limit) || limit > maxLimit))
        throw context.cellCodedError(
          "invalid_command",
          `Token usage detail limit must be an integer from 1 to ${maxLimit}.`,
        );
      const cursor = payload.cursor === undefined ? undefined : payload.cursor;
      if (cursor !== undefined && (typeof cursor !== "string" || decodeDetailCursor(cursor) === null))
        throw context.cellCodedError("invalid_cursor", "Token usage detail cursor is invalid.");
      return agentRuntimeTokenUsageDetailHandler({
        ...context,
        range,
        member,
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
    },
  };
}

function entityLabelOf(
  cut: { readonly status: string },
  projection: Pick<TaskProjection, "getEntity">,
): (squadId: string) => string | null {
  return (squadId) => {
    const value = cut.status === "ready" ? projection.getEntity("squad", squadId)?.value : undefined;
    return typeof value?.name === "string" && value.name ? value.name : null;
  };
}

/** Cache only named task/ancestor lookups under the same ready-cut guard as the squad label. */
function taskOf(
  cut: { readonly status: string },
  projection: Pick<TaskProjection, "readTaskIndex">,
): (taskId: string) => WorkRuleTask | undefined {
  const tasks = new Map<string, WorkRuleTask | undefined>();
  return (taskId) => {
    if (cut.status !== "ready") return undefined;
    if (!tasks.has(taskId)) tasks.set(taskId, projection.readTaskIndex({ taskIds: [taskId] }).rows[0]);
    return tasks.get(taskId);
  };
}

/** The accumulating form of a bucket; frozen into the readonly result shape once filled. */
type MutableBucket = {
  cacheWriteUnreportedDispatches: number;
  cacheWriteUnitemizedDispatches: number;
  bucketStart: string;
  dispatchCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallCount: number;
  usageReportedDispatches: number;
  usageUnavailableDispatches: number;
  costUsd: number;
};
function bucketLadder(sinceMs: number, nowMs: number, bucketMs: number): MutableBucket[] {
  const buckets: MutableBucket[] = [];
  for (let start = sinceMs; start <= nowMs; start += bucketMs)
    buckets.push({
      bucketStart: new Date(start).toISOString(),
      cacheWriteUnreportedDispatches: 0,
      cacheWriteUnitemizedDispatches: 0,
      dispatchCount: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallCount: 0,
      usageReportedDispatches: 0,
      usageUnavailableDispatches: 0,
      costUsd: 0,
    });
  return buckets;
}
/** The ladder position a dispatch falls in, or -1 outside the window. */
function bucketIndexOf(bucketCount: number, startedAt: string, sinceMs: number, bucketMs: number): number {
  const at = Date.parse(startedAt),
    index = Number.isFinite(at) ? Math.floor((at - sinceMs) / bucketMs) : -1;
  return index >= 0 && index < bucketCount ? index : -1;
}
function accumulateBucket(
  buckets: readonly MutableBucket[],
  startedAt: string,
  model: string | null,
  metrics: EffectiveRuntimeMetrics | null,
  sinceMs: number,
  bucketMs: number,
  lifecycle: DispatchLifecycleSummary,
): void {
  const bucket = buckets[bucketIndexOf(buckets.length, startedAt, sinceMs, bucketMs)];
  if (bucket === undefined) return;
  bucket.dispatchCount += 1;
  if (metrics) {
    bucket.inputTokens += metrics.inputTokens;
    bucket.cacheReadTokens += metrics.cacheReadTokens;
    bucket.cacheWriteTokens += metrics.cacheWriteTokens ?? 0;
    bucket.outputTokens += metrics.outputTokens;
    bucket.totalTokens += metrics.totalTokens;
    bucket.toolCallCount += metrics.toolCallCount;
    bucket.costUsd += dispatchCost(model, metrics).costUsd;
  }
  const provenance = cacheWriteProvenanceOf(metrics);
  if (provenance === "unreported") bucket.cacheWriteUnreportedDispatches += 1;
  else if (provenance === "unitemized") bucket.cacheWriteUnitemizedDispatches += 1;
  const usage = usageOf(metrics, lifecycle);
  if (usage === "unavailable") bucket.usageUnavailableDispatches += 1;
  else if (usage === "reported") bucket.usageReportedDispatches += 1;
}

function accumulate(
  map: Map<string, UsageAccumulator>,
  key: string,
  name: string,
  header: DispatchStreamHeader,
  metrics: EffectiveRuntimeMetrics | null,
  lifecycle: DispatchLifecycleSummary,
): void {
  const accumulator = map.get(key) ?? { ...emptyAccumulator(), name };
  accumulator.sessions.add(header.runtimeSessionId);
  if (metrics) {
    accumulator.counters.inputTokens += metrics.inputTokens;
    accumulator.counters.cacheReadTokens += metrics.cacheReadTokens;
    accumulator.counters.cacheWriteTokens += metrics.cacheWriteTokens ?? 0;
    accumulator.counters.outputTokens += metrics.outputTokens;
    accumulator.counters.totalTokens += metrics.totalTokens;
    accumulator.counters.toolCallCount += metrics.toolCallCount;
    const cost = dispatchCost(header.model ?? null, metrics);
    accumulator.counters.costUsd += cost.costUsd;
    accumulator.counters.unpricedTokens += cost.unpricedTokens;
  }
  const usage = usageOf(metrics, lifecycle);
  if (usage === "unavailable") accumulator.usageUnavailableDispatches += 1;
  else if (usage === "reported") accumulator.usageReportedDispatches += 1;
  const provenance = cacheWriteProvenanceOf(metrics);
  if (provenance === "unreported") accumulator.cacheWriteUnreportedDispatches += 1;
  else if (provenance === "unitemized") accumulator.cacheWriteUnitemizedDispatches += 1;
  map.set(key, accumulator);
}

function usageOf(
  metrics: EffectiveRuntimeMetrics | null,
  lifecycle: DispatchLifecycleSummary,
): AgentRuntimeTokenUsageSessionRow["usage"] {
  if (metrics) return metrics.usageUnavailable === true ? "unavailable" : "reported";
  return lifecycle.policy?.attemptSettled ? "unavailable" : "pending";
}

function sessionRowOf(
  header: DispatchStreamHeader,
  metrics: EffectiveRuntimeMetrics | null,
  endedAt: string | null,
  lifecycle: DispatchLifecycleSummary,
): AgentRuntimeTokenUsageSessionRow {
  const startedMs = Date.parse(header.startedAt),
    endedMs = endedAt === null ? Number.NaN : Date.parse(endedAt),
    durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : null;
  return {
    dispatchId: header.dispatchId,
    runtimeSessionId: header.runtimeSessionId,
    taskId: header.taskId,
    model: header.model ?? null,
    startedAt: header.startedAt,
    endedAt,
    durationMs,
    // Previous-version analytics vocabulary projection; remove narrowing 2026-12-07.
    outcome: tokenUsageOutcomeWords.includes(lifecycle.displayStatus as AgentRuntimeTokenUsageOutcome)
      ? (lifecycle.displayStatus as AgentRuntimeTokenUsageOutcome)
      : "unknown",
    inputTokens: metrics?.inputTokens ?? 0,
    cacheReadTokens: metrics?.cacheReadTokens ?? 0,
    cacheWriteTokens: metrics?.cacheWriteTokens ?? 0,
    outputTokens: metrics?.outputTokens ?? 0,
    totalTokens: metrics?.totalTokens ?? 0,
    toolCallCount: metrics?.toolCallCount ?? 0,
    usage: usageOf(metrics, lifecycle),
  };
}
/** Cache-write provenance of one dispatch, or null when its usage carries nothing to classify
 * (no metrics record, or a provider that reported no usage numbers at all). */
function cacheWriteProvenanceOf(metrics: EffectiveRuntimeMetrics | null): "unreported" | "unitemized" | null {
  if (metrics === null || metrics.usageUnavailable === true) return null;
  if (metrics.cacheWriteTokens !== undefined) return null;
  if (metrics.cacheWriteUnitemized === true) return "unitemized";
  return metrics.raw !== undefined && cacheWriteTokensOfUsage(metrics.raw) !== null ? "unitemized" : "unreported";
}
function exitOccurredAt(summary: DispatchStreamSummary): string | null {
  let endedAt: string | null = null;
  for (const record of summary.records)
    if (record.kind === "process_exit" && typeof record.occurredAt === "string") endedAt = record.occurredAt;
  return endedAt;
}

function countersOf(accumulator: UsageAccumulator): AgentRuntimeTokenUsageTotals {
  return {
    sessionCount: accumulator.sessions.size,
    ...accumulator.counters,
    usageReportedDispatches: accumulator.usageReportedDispatches,
    usageUnavailableDispatches: accumulator.usageUnavailableDispatches,
    cacheWriteUnreportedDispatches: accumulator.cacheWriteUnreportedDispatches,
    cacheWriteUnitemizedDispatches: accumulator.cacheWriteUnitemizedDispatches,
  };
}
function emptyAccumulator(): UsageAccumulator {
  return {
    name: "",
    sessions: new Set<string>(),
    counters: {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallCount: 0,
      costUsd: 0,
      unpricedTokens: 0,
    },
    usageReportedDispatches: 0,
    usageUnavailableDispatches: 0,
    cacheWriteUnreportedDispatches: 0,
    cacheWriteUnitemizedDispatches: 0,
  };
}
function sessionOutcomesOf(
  accumulator: UsageAccumulator,
  sessionOutcome: ReadonlyMap<string, AgentRuntimeTokenUsageOutcome>,
): AgentRuntimeTokenUsageSessionOutcomes {
  const ended = (outcome: AgentRuntimeTokenUsageOutcome): number =>
    [...accumulator.sessions].filter((sessionId) => sessionOutcome.get(sessionId) === outcome).length;
  return {
    succeededSessions: ended("succeeded"),
    failedSessions: ended("failed"),
    cancelledSessions: ended("cancelled"),
  };
}

type MemberRow = AgentRuntimeTokenUsageAgentRow | AgentRuntimeTokenUsageSquadRow | AgentRuntimeTokenUsageModelRow;
function compareRows(left: MemberRow, right: MemberRow): number {
  const keyOf = (row: MemberRow): string =>
    "agentId" in row ? row.agentId : "squadId" in row ? row.squadId : row.model;
  return right.totalTokens - left.totalTokens || keyOf(left).localeCompare(keyOf(right));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const isoTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableNonEmptyString = (value: unknown): value is string | null => value === null || nonEmptyString(value);

const totalsFields = [
  "sessionCount",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "totalTokens",
  "toolCallCount",
  "usageReportedDispatches",
  "usageUnavailableDispatches",
  "cacheWriteUnreportedDispatches",
  "cacheWriteUnitemizedDispatches",
  "unpricedTokens",
];
/** Counter fields without the exact-key-count rule — member rows carry id/name on top. */
function hasTotalsFields(value: Record<string, unknown>): boolean {
  return totalsFields.every((field) => nonNegativeInteger(value[field])) && nonNegativeNumber(value.costUsd);
}
function validTotals(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 13 && hasTotalsFields(value);
}
function validBucket(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 13 &&
    isoTimestamp(value.bucketStart) &&
    nonNegativeInteger(value.dispatchCount) &&
    ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens", "toolCallCount"].every(
      (field) => nonNegativeInteger(value[field]),
    ) &&
    [
      "usageReportedDispatches",
      "usageUnavailableDispatches",
      "cacheWriteUnreportedDispatches",
      "cacheWriteUnitemizedDispatches",
    ].every((field) => nonNegativeInteger(value[field])) &&
    nonNegativeNumber(value.costUsd)
  );
}
function validMember(value: unknown): boolean {
  return (
    isRecord(value) &&
    ((value.kind === "agent" &&
      Object.keys(value).length === 3 &&
      nonEmptyString(value.agentId) &&
      nonEmptyString(value.agentName)) ||
      (value.kind === "squad" &&
        Object.keys(value).length === 3 &&
        nonEmptyString(value.squadId) &&
        nonEmptyString(value.squadName)))
  );
}
function validSessionRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 15 &&
    nonEmptyString(value.dispatchId) &&
    nonEmptyString(value.runtimeSessionId) &&
    nullableNonEmptyString(value.taskId) &&
    nullableNonEmptyString(value.model) &&
    isoTimestamp(value.startedAt) &&
    nullableNonEmptyString(value.endedAt) &&
    (value.durationMs === null || nonNegativeInteger(value.durationMs)) &&
    tokenUsageOutcomeWords.includes(value.outcome as AgentRuntimeTokenUsageOutcome) &&
    ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens", "toolCallCount"].every(
      (field) => nonNegativeInteger(value[field]),
    ) &&
    ["reported", "unavailable", "pending"].includes(String(value.usage))
  );
}
function sharedResultFields(value: Record<string, unknown>): boolean {
  return (
    value.ok === true &&
    ["ready", "pending"].includes(String(value.status)) &&
    agentRuntimeTokenUsageRanges.includes(value.range as AgentRuntimeTokenUsageRange) &&
    isoTimestamp(value.since) &&
    positiveInteger(value.bucketMs) &&
    validTotals(value.totals) &&
    Array.isArray(value.buckets) &&
    value.buckets.every(validBucket) &&
    isRecord(value.pricing) &&
    Object.keys(value.pricing).length === 1 &&
    nonEmptyString(value.pricing.version) &&
    nonNegativeInteger(value.watermark) &&
    nonNegativeInteger(value.sourceRevision)
  );
}

export function validateAgentRuntimeTokenUsage(value: unknown): readonly string[] {
  if (isRecord(value) && value.groupBy !== undefined) return validateCollaboratorTokenUsage(value);
  const validRow = (row: unknown, keys: number, ...labels: readonly string[]): boolean =>
    isRecord(row) &&
    Object.keys(row).length === keys &&
    labels.every((label) => nonEmptyString(row[label])) &&
    hasTotalsFields(row) &&
    sessionOutcomeFields.every((field) => nonNegativeInteger(row[field]));
  return isRecord(value) &&
    Object.keys(value).length === 20 &&
    sharedResultFields(value) &&
    isRecord(value.previous) &&
    Object.keys(value.previous).length === 3 &&
    isoTimestamp(value.previous.since) &&
    isoTimestamp(value.previous.until) &&
    validTotals(value.previous.totals) &&
    Array.isArray(value.agents) &&
    value.agents.every((row) => validRow(row, 18, "agentId", "agentName")) &&
    Array.isArray(value.squads) &&
    value.squads.every((row) => validRow(row, 18, "squadId", "squadName")) &&
    Array.isArray(value.models) &&
    value.models.length <= tokenUsageInsightLimits.models &&
    value.models.every((row) => validRow(row, 17, "model")) &&
    validTokenUsageInsights(value, (value.buckets as readonly unknown[]).length)
    ? []
    : ["agent runtime token usage is invalid"];
}
function validDetailPage(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    positiveInteger(value.limit) &&
    value.limit <= storageReadPolicy.defaultValue.pageSizes.standard &&
    nullableNonEmptyString(value.cursor) &&
    nullableNonEmptyString(value.nextCursor)
  );
}
export function validateAgentRuntimeTokenUsageDetail(value: unknown): readonly string[] {
  const hasPage = isRecord(value) && Object.hasOwn(value, "page");
  return isRecord(value) &&
    Object.keys(value).length === (hasPage ? 13 : 12) &&
    sharedResultFields(value) &&
    validMember(value.member) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(validSessionRow) &&
    (!hasPage || validDetailPage(value.page))
    ? []
    : ["agent runtime token usage detail is invalid"];
}

export function serializeAgentRuntimeTokenUsage(value: unknown): string {
  const errors = validateAgentRuntimeTokenUsage(value);
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}
export function serializeAgentRuntimeTokenUsageDetail(value: unknown): string {
  const errors = validateAgentRuntimeTokenUsageDetail(value);
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}

import type { TaskProjection } from "@harness-anything/kernel";
import { runtimeSessionOutcomeFromEvidence } from "@harness-anything/kernel";
import { agentRuntimeTokenUsageRangeWords } from "./protocol/daemon-protocol-schema-ids.ts";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";
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
import { workRootWalk } from "./workspace-scope-read.ts";
import type { WorkRuleTask } from "./workspace-scope-read.ts";
import { modelPriceOf, modelPricingVersion, usageCostUsd } from "./agent-runtime-model-pricing.ts";

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
export interface AgentRuntimeTokenUsageBucket extends AgentRuntimeTokenUsageReporting {
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
  readonly status: "ready" | "pending";
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
export type AgentRuntimeTokenUsageDetailResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly range: AgentRuntimeTokenUsageRange;
  readonly since: string;
  readonly bucketMs: number;
  readonly member: AgentRuntimeTokenUsageMember;
  readonly totals: AgentRuntimeTokenUsageTotals;
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly sessions: readonly AgentRuntimeTokenUsageSessionRow[];
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

/** One dispatch inside the window with the summary fields both reads need. Reading the summary
 * (bounded head/tail windows, cached by mtime+size) is the whole read cost — no full-file scan. */
function windowDispatches(
  rootDir: string,
  projection: Pick<TaskProjection, "readRuntimeDispatchPage">,
  sinceMs: number,
  pick: (header: DispatchStreamHeader) => boolean,
): { readonly header: DispatchStreamHeader; readonly summary: DispatchStreamSummary | null }[] {
  const selected = new Map<
    string,
    { readonly header: DispatchStreamHeader; readonly summary: DispatchStreamSummary | null }
  >();
  let cursor: { readonly startedAt: string; readonly dispatchId: string } | undefined;
  for (;;) {
    const page = projection.readRuntimeDispatchPage({
      startedAtGte: new Date(sinceMs).toISOString(),
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    for (const row of page.rows) {
      const payload = row.event.payload;
      if (!payload.startedAt || !pick(projectedHeader(row))) continue;
      selected.set(payload.dispatchId, {
        header: projectedHeader(row),
        summary: readDispatchStreamSummary(rootDir, payload.dispatchId),
      });
    }
    if (page.done) break;
    if (!page.nextCursor) throw new Error("runtime dispatch page is incomplete without a next cursor");
    cursor = page.nextCursor;
  }
  for (const header of readDispatchStreamHeaders(rootDir)) {
    if (selected.has(header.dispatchId) || Date.parse(header.startedAt) < sinceMs || !pick(header)) continue;
    selected.set(header.dispatchId, { header, summary: readDispatchStreamSummary(rootDir, header.dispatchId) });
  }
  return [...selected.values()];
}

function projectedHeader(
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
    eventStreamRef: `file:.harness/runtime/dispatches/${payload.dispatchId}.jsonl`,
    taskId: payload.taskId ?? null,
    executionId: payload.executionId ?? null,
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.agentName ? { agentName: payload.agentName } : {}),
    ...(payload.squadId ? { squadId: payload.squadId } : {}),
    kindId: payload.kindId,
    model: payload.definitionSnapshot.model,
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
  readonly projection: Pick<TaskProjection, "readRuntimeDispatchPage">;
  readonly cut: {
    readonly status: "ready" | "pending";
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
  // One walk covers both periods; the tail of the earlier window past `previousUntil` belongs
  // to neither, so its streams are never opened.
  for (const { header, summary } of windowDispatches(
    input.rootDir,
    input.projection,
    previousSinceMs,
    (candidate) => startedMs(candidate) < previousUntilMs || startedMs(candidate) >= sinceMs,
  )) {
    if (startedMs(header) < sinceMs) {
      accumulate(previous, "", "", header, summary);
      continue;
    }
    accumulateBucket(buckets, header.startedAt, header.model ?? null, summary, sinceMs, bucketMs);
    accumulate(fleet, "", "", header, summary);
    if (header.agentId) accumulate(agents, header.agentId, header.agentName ?? header.agentId, header, summary);
    if (header.squadId)
      accumulate(squads, header.squadId, input.entityLabel(header.squadId) ?? header.squadId, header, summary);
    if (header.model) accumulate(models, header.model, header.model, header, summary);
    facts.push({
      ...sessionRowOf(header, summary),
      agentId: header.agentId ?? null,
      agentName: header.agentName ?? null,
      kindId: header.kindId ?? null,
      instanceId: header.instanceId,
      bucketIndex: bucketIndexOf(buckets.length, header.startedAt, sinceMs, bucketMs),
    });
  }
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
    status: input.cut.status,
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
  readonly entityLabel: (squadId: string) => string | null;
  readonly projection: Pick<TaskProjection, "readRuntimeDispatchPage">;
  readonly cut: {
    readonly status: "ready" | "pending";
    readonly watermark: number;
    readonly sourceRevision: number;
  };
}): AgentRuntimeTokenUsageDetailResult {
  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime())) throw new Error(`Agent runtime token usage now is invalid: ${input.now}.`);
  const { sinceMs, bucketMs } = planWindow(now, input.range),
    buckets = bucketLadder(sinceMs, now.getTime(), bucketMs),
    sessions: AgentRuntimeTokenUsageSessionRow[] = [];
  const member = input.member,
    pickMember =
      member.kind === "agent"
        ? (header: DispatchStreamHeader) => header.agentId === member.agentId
        : (header: DispatchStreamHeader) => header.squadId === member.squadId;
  let memberName: string | null = null;
  const provenance = { unreported: 0, unitemized: 0 };
  for (const { header, summary } of windowDispatches(input.rootDir, input.projection, sinceMs, pickMember)) {
    if (memberName === null && member.kind === "agent") memberName = header.agentName ?? member.agentId;
    sessions.push(sessionRowOf(header, summary));
    const cacheWrite = cacheWriteProvenanceOf(summary);
    if (cacheWrite === "unreported") provenance.unreported += 1;
    else if (cacheWrite === "unitemized") provenance.unitemized += 1;
    accumulateBucket(buckets, header.startedAt, header.model ?? null, summary, sinceMs, bucketMs);
  }
  sessions.sort(
    (left, right) =>
      Date.parse(right.startedAt) - Date.parse(left.startedAt) || left.dispatchId.localeCompare(right.dispatchId),
  );
  return {
    ok: true,
    status: input.cut.status,
    range: input.range,
    since: new Date(sinceMs).toISOString(),
    bucketMs,
    member:
      input.member.kind === "agent"
        ? { kind: "agent", agentId: input.member.agentId, agentName: memberName ?? input.member.agentId }
        : {
            kind: "squad",
            squadId: input.member.squadId,
            squadName: input.entityLabel(input.member.squadId) ?? input.member.squadId,
          },
    totals: detailTotals(sessions, provenance),
    buckets,
    sessions,
    pricing: { version: modelPricingVersion },
    watermark: input.cut.watermark,
    sourceRevision: input.cut.sourceRevision,
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
  readonly projection: Pick<TaskProjection, "readCut" | "getEntity" | "readRuntimeDispatchPage" | "readTaskIndex">;
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
  readonly projection: Pick<TaskProjection, "readCut" | "getEntity" | "readRuntimeDispatchPage">;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly member: AgentRuntimeTokenUsageMemberIdentity;
}): AgentRuntimeTokenUsageDetailResult {
  const cut = context.projection.readCut();
  return readAgentRuntimeTokenUsageDetail({
    rootDir: context.rootDir,
    now: context.now(),
    range: context.range,
    member: context.member,
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
  const fields = Object.keys(value).filter((field) => field !== "range");
  if (fields.length !== 1 || !["agentId", "squadId"].includes(fields[0] ?? "")) return null;
  const id = typeof value[fields[0]!] === "string" && value[fields[0]!] !== "" ? (value[fields[0]!] as string) : null;
  return id === null ? null : fields[0] === "agentId" ? { kind: "agent", agentId: id } : { kind: "squad", squadId: id };
}

/** The repo-cell handler pair for both token usage reads, selector validation included:
 * the read module owns its wire selectors end to end; the cell layer only registers them. */
export function agentRuntimeTokenUsageReadHandlers(context: {
  readonly rootDir: string;
  readonly now: () => string;
  readonly projection: Pick<TaskProjection, "readCut" | "getEntity" | "readRuntimeDispatchPage" | "readTaskIndex">;
  readonly cellCodedError: (code: string, text: string) => Error;
}): {
  readonly "repo.agentRuntime.tokenUsage": (payload: Readonly<Record<string, unknown>>) => AgentRuntimeTokenUsageResult;
  readonly "repo.agentRuntime.tokenUsageDetail": (
    payload: Readonly<Record<string, unknown>>,
  ) => AgentRuntimeTokenUsageDetailResult;
} {
  return {
    "repo.agentRuntime.tokenUsage": (payload) => {
      const range = agentRuntimeTokenUsageRangeOf(payload);
      if (range === null)
        throw context.cellCodedError("invalid_command", "Token usage range must be today, 7d or 30d.");
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
      return agentRuntimeTokenUsageDetailHandler({ ...context, range, member });
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

/** Task titles and parent links for the task and work rows: one task-index read per usage
 * read, taken on the first lookup, under the same ready-cut guard as the squad label. */
function taskOf(
  cut: { readonly status: string },
  projection: Pick<TaskProjection, "readTaskIndex">,
): (taskId: string) => WorkRuleTask | undefined {
  let tasks: ReadonlyMap<string, WorkRuleTask> | null = null;
  return (taskId) => {
    if (cut.status !== "ready") return undefined;
    tasks ??= new Map(projection.readTaskIndex({}).rows.map((row) => [row.taskId, row]));
    return tasks.get(taskId);
  };
}

/** The accumulating form of a bucket; frozen into the readonly result shape once filled. */
type MutableBucket = {
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
  summary: DispatchStreamSummary | null,
  sinceMs: number,
  bucketMs: number,
): void {
  const metrics = summary?.runtimeMetrics,
    bucket = buckets[bucketIndexOf(buckets.length, startedAt, sinceMs, bucketMs)];
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
  const usage = usageOf(summary);
  if (usage === "unavailable") bucket.usageUnavailableDispatches += 1;
  else if (usage === "reported") bucket.usageReportedDispatches += 1;
}

function accumulate(
  map: Map<string, UsageAccumulator>,
  key: string,
  name: string,
  header: DispatchStreamHeader,
  summary: DispatchStreamSummary | null,
): void {
  const metrics = summary?.runtimeMetrics;
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
  const usage = usageOf(summary);
  if (usage === "unavailable") accumulator.usageUnavailableDispatches += 1;
  else if (usage === "reported") accumulator.usageReportedDispatches += 1;
  const provenance = cacheWriteProvenanceOf(summary);
  if (provenance === "unreported") accumulator.cacheWriteUnreportedDispatches += 1;
  else if (provenance === "unitemized") accumulator.cacheWriteUnitemizedDispatches += 1;
  map.set(key, accumulator);
}

function usageOf(summary: DispatchStreamSummary | null): AgentRuntimeTokenUsageSessionRow["usage"] {
  const metrics = summary?.runtimeMetrics;
  if (metrics) return metrics.usageUnavailable === true ? "unavailable" : "reported";
  return summary?.process?.exited === true ? "unavailable" : "pending";
}

function sessionRowOf(
  header: DispatchStreamHeader,
  summary: DispatchStreamSummary | null,
): AgentRuntimeTokenUsageSessionRow {
  const metrics = summary?.runtimeMetrics ?? null,
    endedAt = summary === null ? null : exitOccurredAt(summary),
    startedMs = Date.parse(header.startedAt),
    durationMs =
      endedAt !== null && Number.isFinite(startedMs) && Number.isFinite(Date.parse(endedAt))
        ? Date.parse(endedAt) - startedMs
        : null;
  return {
    dispatchId: header.dispatchId,
    runtimeSessionId: header.runtimeSessionId,
    taskId: header.taskId,
    model: header.model ?? null,
    startedAt: header.startedAt,
    endedAt,
    durationMs,
    outcome: dispatchOutcomeWord(summary),
    inputTokens: metrics?.inputTokens ?? 0,
    cacheReadTokens: metrics?.cacheReadTokens ?? 0,
    cacheWriteTokens: metrics?.cacheWriteTokens ?? 0,
    outputTokens: metrics?.outputTokens ?? 0,
    totalTokens: metrics?.totalTokens ?? 0,
    toolCallCount: metrics?.toolCallCount ?? 0,
    usage: usageOf(summary),
  };
}
/** The dispatch's session outcome is the accepted terminal verdict on the stream — the same
 * `runtime_session_outcome_observed` payload the kernel holds — narrowed by the kernel's own
 * evidence function, never re-judged here from exit codes: a zero exit is not success evidence
 * and a signal exit is not a cancellation. `running` is process liveness (not yet exited);
 * everything without an accepted terminal outcome stays `unknown`. */
function dispatchOutcomeWord(summary: DispatchStreamSummary | null): AgentRuntimeTokenUsageOutcome {
  const terminal = summary?.terminalOutcome ?? null;
  if (terminal !== null) {
    const outcome = runtimeSessionOutcomeFromEvidence({
      outcome: terminal.payload.outcome,
      exitCode: terminal.payload.exitCode,
      resultRef: terminal.payload.resultRef,
      ...(terminal.payload.reasonCode ? { reasonCode: terminal.payload.reasonCode } : {}),
    });
    return outcome ?? "unknown";
  }
  const process = summary?.process ?? null;
  return process !== null && !process.exited ? "running" : "unknown";
}
/** Cache-write provenance of one dispatch, or null when its usage carries nothing to classify
 * (no metrics record, or a provider that reported no usage numbers at all). */
function cacheWriteProvenanceOf(summary: DispatchStreamSummary | null): "unreported" | "unitemized" | null {
  const metrics = summary?.runtimeMetrics ?? null;
  if (metrics === null || metrics.usageUnavailable === true) return null;
  if (metrics.cacheWriteTokens !== undefined) return null;
  return cacheWriteTokensOfUsage(metrics.raw) !== null ? "unitemized" : "unreported";
}
function exitOccurredAt(summary: DispatchStreamSummary): string | null {
  let endedAt: string | null = null;
  for (const record of summary.records)
    if (record.kind === "process_exit" && typeof record.occurredAt === "string") endedAt = record.occurredAt;
  return endedAt;
}

function detailTotals(
  sessions: readonly AgentRuntimeTokenUsageSessionRow[],
  provenance: { unreported: number; unitemized: number },
): AgentRuntimeTokenUsageTotals {
  const unique = new Set(sessions.map(({ runtimeSessionId }) => runtimeSessionId));
  return {
    sessionCount: unique.size,
    inputTokens: sum(sessions, ({ inputTokens }) => inputTokens),
    cacheReadTokens: sum(sessions, ({ cacheReadTokens }) => cacheReadTokens),
    cacheWriteTokens: sum(sessions, ({ cacheWriteTokens }) => cacheWriteTokens),
    outputTokens: sum(sessions, ({ outputTokens }) => outputTokens),
    totalTokens: sum(sessions, ({ totalTokens }) => totalTokens),
    toolCallCount: sum(sessions, ({ toolCallCount }) => toolCallCount),
    usageReportedDispatches: sessions.filter(({ usage }) => usage === "reported").length,
    usageUnavailableDispatches: sessions.filter(({ usage }) => usage === "unavailable").length,
    cacheWriteUnreportedDispatches: provenance.unreported,
    cacheWriteUnitemizedDispatches: provenance.unitemized,
    costUsd: sum(sessions, (row) => {
      const price = modelPriceOf(row.model);
      return price === null ? 0 : usageCostUsd(price, row);
    }),
    unpricedTokens: sum(sessions, ({ model, totalTokens }) => (modelPriceOf(model) === null ? totalTokens : 0)),
  };
}
function sum<T>(values: readonly T[], pick: (value: T) => number): number {
  return values.reduce((total, value) => total + pick(value), 0);
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
    Object.keys(value).length === 11 &&
    isoTimestamp(value.bucketStart) &&
    nonNegativeInteger(value.dispatchCount) &&
    ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens", "toolCallCount"].every(
      (field) => nonNegativeInteger(value[field]),
    ) &&
    ["usageReportedDispatches", "usageUnavailableDispatches"].every((field) => nonNegativeInteger(value[field])) &&
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
export function validateAgentRuntimeTokenUsageDetail(value: unknown): readonly string[] {
  return isRecord(value) &&
    Object.keys(value).length === 12 &&
    sharedResultFields(value) &&
    validMember(value.member) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(validSessionRow)
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

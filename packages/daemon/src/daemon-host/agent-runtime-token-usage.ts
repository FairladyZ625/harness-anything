import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import {
  compareRuntimeDispatchPageKeys,
  runtimeDispatchPageTimeKey,
} from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { TaskProjection } from "@harness-anything/kernel";
import { dispatchLifecycleSummary, type DispatchLifecycleSummary } from "@harness-anything/kernel";
import {
  agentRuntimeTokenUsageRanges,
  buildTokenUsageBucketLadder,
  isValidTokenUsageDetailCursor,
  planTokenUsageWindow,
  readTokenUsageDetailPage,
  tokenUsageBucketIndexOf,
  type AgentRuntimeTokenUsageBucket,
  type AgentRuntimeTokenUsageCacheWriteProvenance,
  type AgentRuntimeTokenUsageCost,
  type AgentRuntimeTokenUsageCounters,
  type AgentRuntimeTokenUsageDetailResult,
  type AgentRuntimeTokenUsageMember,
  type AgentRuntimeTokenUsageMemberIdentity,
  type AgentRuntimeTokenUsageRange,
  type AgentRuntimeTokenUsageReporting,
  type AgentRuntimeTokenUsageSessionRow,
  type AgentRuntimeTokenUsageTotals,
  type TokenUsageDetailProjection,
} from "@harness-anything/application/internal/queries/token-usage-detail-read.ts";
import { coded } from "./agent-runtime-contract.ts";
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
import {
  modelPriceOf,
  modelPricingFingerprint,
  modelPricingVersion,
  usageCostUsd,
} from "../runtime-engine/agent-runtime-model-pricing.ts";
import {
  collaboratorTokenUsageResult,
  validateCollaboratorTokenUsage,
  type CollaboratorTokenUsageResult,
} from "./collaborator-token-usage-read.ts";

export { agentRuntimeTokenUsageRanges, tokenUsageInsightLimits, tokenUsageOutcomeWords, tokenUsageSessionBinCeilings };
export type {
  AgentRuntimeTokenUsageBucket,
  AgentRuntimeTokenUsageCacheWriteProvenance,
  AgentRuntimeTokenUsageCost,
  AgentRuntimeTokenUsageCounters,
  AgentRuntimeTokenUsageDetailResult,
  AgentRuntimeTokenUsageMember,
  AgentRuntimeTokenUsageMemberIdentity,
  AgentRuntimeTokenUsageOutcome,
  AgentRuntimeTokenUsageOutcomeRow,
  AgentRuntimeTokenUsageRange,
  AgentRuntimeTokenUsageReporting,
  AgentRuntimeTokenUsageSessionBin,
  AgentRuntimeTokenUsageSessionRow,
  AgentRuntimeTokenUsageSessionStats,
  AgentRuntimeTokenUsageTaskRow,
  AgentRuntimeTokenUsageTopSession,
  AgentRuntimeTokenUsageTotals,
  AgentRuntimeTokenUsageTrendSeries,
  AgentRuntimeTokenUsageUnreportedProvider,
  AgentRuntimeTokenUsageWorkRow,
};
import { tokenUsageSessionBinCeilings } from "./agent-runtime-token-usage-insights.ts";
import type {
  AgentRuntimeTokenUsageOutcomeRow,
  AgentRuntimeTokenUsageSessionBin,
  AgentRuntimeTokenUsageSessionStats,
  AgentRuntimeTokenUsageTaskRow,
  AgentRuntimeTokenUsageTopSession,
  AgentRuntimeTokenUsageTrendSeries,
  AgentRuntimeTokenUsageUnreportedProvider,
  AgentRuntimeTokenUsageWorkRow,
} from "./agent-runtime-token-usage-insights.ts";

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
export type AgentRuntimeTokenUsageResult = {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly range: AgentRuntimeTokenUsageRange;
  /** Inclusive lower bound of the window: local midnight on the daemon's clock. */
  readonly since: string;
  readonly bucketMs: number;
  readonly totals: AgentRuntimeTokenUsageTotals;
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

type EffectiveRuntimeMetrics = {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
  readonly usageUnavailable?: boolean;
  readonly raw?: Readonly<Record<string, unknown>>;
};

type TokenUsageProjection = TokenUsageDetailProjection & Partial<Pick<TaskProjection, "readTaskIndex">>;
type DispatchProjectionRow = ReturnType<TaskProjection["readRuntimeDispatchPage"]>["rows"][number];

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
  return {
    costUsd: usageCostUsd(price, { ...metrics, cacheWriteTokens: metrics.cacheWriteTokens ?? 0 }),
    unpricedTokens: 0,
  };
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

function resolveLiveDispatchEntry(
  rootDir: string,
  projection: TokenUsageProjection,
  row: DispatchProjectionRow,
): {
  readonly header: DispatchStreamHeader;
  readonly metrics: EffectiveRuntimeMetrics | null;
  readonly endedAt: string | null;
  readonly lifecycle: DispatchLifecycleSummary;
} {
  const header = projectedHeader(rootDir, row),
    summary = readDispatchStreamSummary(rootDir, header.dispatchId),
    metrics: EffectiveRuntimeMetrics | null = summary?.runtimeMetrics ?? row.metrics;
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
 * matching dispatches are visited with O(1) cursor progression. */
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
  visit: (row: DispatchProjectionRow, header: DispatchStreamHeader) => void,
): void {
  const minMs = Date.parse(query.startedAtGte),
    maxMs = query.startedAtLte === undefined ? null : Date.parse(query.startedAtLte),
    compareKeys =
      (query.order ?? "asc") === "asc"
        ? compareRuntimeDispatchPageKeys
        : (
            left: { readonly startedAt: string; readonly dispatchId: string },
            right: { readonly startedAt: string; readonly dispatchId: string },
          ) =>
            runtimeDispatchPageTimeKey(right.startedAt) - runtimeDispatchPageTimeKey(left.startedAt) ||
            Buffer.compare(Buffer.from(left.dispatchId), Buffer.from(right.dispatchId));
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
        !pick(header)
      )
        continue;
      visit(row, header);
    }
    if (page.done) break;
    if (!page.nextCursor || (cursor !== undefined && compareKeys(page.nextCursor, cursor) <= 0))
      throw new Error("runtime dispatch page is incomplete without a next cursor");
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
  const { sinceMs, bucketMs, previousSinceMs, previousUntilMs } = planTokenUsageWindow(now, input.range),
    agents = new Map<string, UsageAccumulator>(),
    squads = new Map<string, UsageAccumulator>(),
    models = new Map<string, UsageAccumulator>(),
    fleet = new Map<string, UsageAccumulator>(),
    previous = new Map<string, UsageAccumulator>(),
    buckets = buildTokenUsageBucketLadder(sinceMs, now.getTime(), bucketMs),
    facts: TokenUsageDispatchFact[] = [],
    startedMs = (header: DispatchStreamHeader): number => Date.parse(header.startedAt);
  let pending = input.cut.status === "pending";
  windowDispatches(
    input.rootDir,
    input.projection,
    { startedAtGte: new Date(previousSinceMs).toISOString() },
    (candidate) => startedMs(candidate) < previousUntilMs || startedMs(candidate) >= sinceMs,
    (row) => {
      const { header, metrics, endedAt, lifecycle } = resolveLiveDispatchEntry(input.rootDir, input.projection, row);
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
        bucketIndex: tokenUsageBucketIndexOf(buckets.length, header.startedAt, sinceMs, bucketMs),
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

/** Member-scoped detail read: paginated reads delegate pure snapshot/paging orchestration to
 * `@harness-anything/application` (dec_7C93DEBCFB2D1A94C6FA07AAAD/CH1,CH3); unpaginated local
 * callers retain live `.jsonl` stream reads and the exact 12-key baseline wire shape (F10). */
export function readAgentRuntimeTokenUsageDetail(input: {
  readonly rootDir: string;
  readonly repoId?: string;
  readonly now: string;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly member: AgentRuntimeTokenUsageMemberIdentity;
  readonly personId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly cursorSecret?: string | Buffer;
  readonly maxUnpaginatedSessions?: number;
  readonly maxWindowSessions?: number;
  readonly entityLabel: (squadId: string) => string | null;
  readonly projection: TokenUsageProjection;
  readonly cut: {
    readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
}): AgentRuntimeTokenUsageDetailResult {
  if (input.limit !== undefined || input.cursor !== undefined) {
    return readTokenUsageDetailPage({
      repoId: input.repoId ?? "local",
      now: input.now,
      range: input.range,
      member: input.member,
      ...(input.personId === undefined ? {} : { personId: input.personId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.cursorSecret === undefined ? {} : { cursorSecret: input.cursorSecret }),
      ...(input.maxWindowSessions === undefined ? {} : { maxWindowSessions: input.maxWindowSessions }),
      pricing: {
        version: modelPricingVersion,
        fingerprint: modelPricingFingerprint,
        costOf: dispatchCost,
      },
      entityLabel: input.entityLabel,
      projection: input.projection,
      cut: input.cut,
    });
  }

  const now = new Date(input.now),
    nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error(`Agent runtime token usage now is invalid: ${input.now}.`);
  const { sinceMs, bucketMs } = planTokenUsageWindow(now, input.range),
    member = input.member,
    memberQuery = member.kind === "agent" ? { agentId: member.agentId } : { squadId: member.squadId },
    personQuery = input.personId === undefined ? {} : { personId: input.personId },
    pickMember =
      member.kind === "agent"
        ? (header: DispatchStreamHeader) => header.agentId === member.agentId
        : (header: DispatchStreamHeader) => header.squadId === member.squadId,
    buckets = buildTokenUsageBucketLadder(sinceMs, nowMs, bucketMs),
    totals = new Map<string, UsageAccumulator>(),
    sessions: AgentRuntimeTokenUsageSessionRow[] = [],
    sessionCeiling = input.maxUnpaginatedSessions;
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
      maxRevision: input.cut.watermark,
    },
    pickMember,
    (row) => {
      if (sessionCeiling !== undefined && sessions.length >= sessionCeiling)
        throw coded(
          "resource_exhausted",
          `Unpaginated token usage detail exceeds ${sessionCeiling} sessions; request paged results with limit and cursor.`,
        );
      const { header, metrics, endedAt, lifecycle } = resolveLiveDispatchEntry(input.rootDir, input.projection, row);
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
    member:
      member.kind === "agent"
        ? { kind: "agent", agentId: member.agentId, agentName: memberName ?? member.agentId }
        : {
            kind: "squad",
            squadId: member.squadId,
            squadName: input.entityLabel(member.squadId) ?? member.squadId,
          },
    totals: countersOf(totals.get("") ?? emptyAccumulator()),
    buckets,
    sessions,
    pricing: { version: modelPricingVersion },
    watermark: input.cut.watermark,
    sourceRevision: input.cut.sourceRevision,
  };
}

export function agentRuntimeTokenUsageHandler(context: {
  readonly rootDir: string;
  readonly now: () => string;
  readonly projection: Pick<
    TaskProjection,
    "readCut" | "getEntity" | "readRuntimeDispatchPage" | "readTaskIndex" | "readDispatchLifecycle"
  > &
    TokenUsageProjection;
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
  readonly repoId?: string;
  readonly now: () => string;
  readonly projection: Pick<
    TaskProjection,
    "readCut" | "getEntity" | "readRuntimeDispatchPage" | "readTaskIndex" | "readDispatchLifecycle"
  > &
    TokenUsageProjection;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly member: AgentRuntimeTokenUsageMemberIdentity;
  readonly limit?: number;
  readonly cursor?: string;
  readonly maxUnpaginatedSessions?: number;
}): AgentRuntimeTokenUsageDetailResult {
  const nowIso = context.now(),
    nowMs = Date.parse(nowIso),
    repoId = context.repoId ?? "local";
  if (!Number.isFinite(nowMs)) throw new Error(`Agent runtime token usage now is invalid: ${nowIso}.`);
  const maxLimit = storageReadPolicy.defaultValue.pageSizes.standard;
  if (context.limit !== undefined && (!positiveInteger(context.limit) || context.limit > maxLimit))
    throw coded("invalid_command", `Token usage detail limit must be an integer from 1 to ${maxLimit}.`);
  if (
    context.cursor !== undefined &&
    !isValidTokenUsageDetailCursor(context.cursor, {
      repoId,
      nowMs,
      pricingVersion: modelPricingVersion,
      pricingFingerprint: modelPricingFingerprint,
    })
  )
    throw coded("invalid_cursor", "Token usage detail cursor is invalid.");
  const cut = context.projection.readCut();
  return readAgentRuntimeTokenUsageDetail({
    rootDir: context.rootDir,
    repoId,
    now: nowIso,
    range: context.range,
    member: context.member,
    ...(context.limit === undefined ? {} : { limit: context.limit }),
    ...(context.cursor === undefined ? {} : { cursor: context.cursor }),
    ...(context.maxUnpaginatedSessions === undefined ? {} : { maxUnpaginatedSessions: context.maxUnpaginatedSessions }),
    entityLabel: entityLabelOf(cut, context.projection),
    cut,
    projection: context.projection,
  });
}

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

export function agentRuntimeTokenUsageReadHandlers(context: {
  readonly rootDir: string;
  readonly input?: { readonly repoId: string };
  readonly now: () => string;
  readonly projection: Pick<
    TaskProjection,
    | "readCut"
    | "getEntity"
    | "readRuntimeDispatchPage"
    | "readTaskIndex"
    | "readDispatchLifecycle"
    | "readRuntimeSessionEventsByType"
    | "readTaskSubmissionOperation"
    | "readTaskOperation"
    | "readTaskCompletion"
    | "readEventList"
    | "readRuntimeDispatchById"
  >;
  readonly cellCodedError: (code: string, text: string) => Error;
}): {
  readonly "repo.agentRuntime.tokenUsage": (
    payload: Readonly<Record<string, unknown>>,
  ) => AgentRuntimeTokenUsageResult | CollaboratorTokenUsageResult;
  readonly "repo.agentRuntime.tokenUsageDetail": (
    payload: Readonly<Record<string, unknown>>,
    binding?: import("./repo-cell-types.ts").RepoCellBinding,
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
        const { sinceMs } = planTokenUsageWindow(new Date(context.now()), range);
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
    "repo.agentRuntime.tokenUsageDetail": (payload, binding) => {
      const range = agentRuntimeTokenUsageRangeOf(payload),
        member = agentRuntimeTokenUsageMemberOf(payload),
        repoId = context.input?.repoId ?? "local";
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
      const nowIso = context.now(),
        nowMs = Date.parse(nowIso),
        cursor = payload.cursor === undefined ? undefined : payload.cursor;
      if (
        cursor !== undefined &&
        (typeof cursor !== "string" ||
          !Number.isFinite(nowMs) ||
          !isValidTokenUsageDetailCursor(cursor, {
            repoId,
            nowMs,
            pricingVersion: modelPricingVersion,
            pricingFingerprint: modelPricingFingerprint,
          }))
      )
        throw context.cellCodedError("invalid_cursor", "Token usage detail cursor is invalid.");
      const isRemoteFleetRead =
        binding?.fleetReplicaPrincipal !== undefined ||
        (typeof binding?.source === "object" &&
          binding.source !== null &&
          "kind" in binding.source &&
          binding.source.kind === "node");
      return agentRuntimeTokenUsageDetailHandler({
        ...context,
        repoId,
        range,
        member,
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(isRemoteFleetRead ? { maxUnpaginatedSessions: maxLimit } : {}),
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

type MutableBucket = ReturnType<typeof buildTokenUsageBucketLadder>[number];

function accumulateBucket(
  buckets: readonly MutableBucket[],
  startedAt: string,
  model: string | null,
  metrics: EffectiveRuntimeMetrics | null,
  sinceMs: number,
  bucketMs: number,
  lifecycle: DispatchLifecycleSummary,
): void {
  const bucket = buckets[tokenUsageBucketIndexOf(buckets.length, startedAt, sinceMs, bucketMs)];
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

function cacheWriteProvenanceOf(metrics: EffectiveRuntimeMetrics | null): "unreported" | "unitemized" | null {
  if (metrics === null || metrics.usageUnavailable === true) return null;
  if (metrics.cacheWriteTokens !== undefined) return null;
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

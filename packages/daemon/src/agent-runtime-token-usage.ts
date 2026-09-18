import type { TaskProjection } from "../../kernel/src/index.ts";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";
import type { DispatchStreamHeader, DispatchStreamSummary } from "./dispatch-stream.ts";

/** One consumption counter set, summed over the dispatches each row aggregates. The field
 * names match `TaskDispatchRow.metrics` because both read the same `runtime_metrics` records. */
export interface AgentRuntimeTokenUsageCounters {
  readonly sessionCount: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
}
/** How many dispatches settled with usage numbers versus a provider that reported none, so the
 * renderer can tell "0 tokens consumed" from "provider never reported usage" (runtime_metrics
 * carries `usageUnavailable` for the latter; dispatches with no metrics record yet count in
 * neither). */
export interface AgentRuntimeTokenUsageReporting {
  readonly usageReportedDispatches: number;
  readonly usageUnavailableDispatches: number;
}
export type AgentRuntimeTokenUsageTotals = AgentRuntimeTokenUsageCounters & AgentRuntimeTokenUsageReporting;
export interface AgentRuntimeTokenUsageAgentRow extends AgentRuntimeTokenUsageTotals {
  readonly agentId: string;
  readonly agentName: string;
}
export interface AgentRuntimeTokenUsageSquadRow extends AgentRuntimeTokenUsageTotals {
  readonly squadId: string;
  readonly squadName: string;
}
export type AgentRuntimeTokenUsageRange = "today" | "7d" | "30d";
export const agentRuntimeTokenUsageRanges: readonly AgentRuntimeTokenUsageRange[] = ["today", "7d", "30d"];
/** One time-slice of the window: `today` slices by local hour, multi-day ranges by local day.
 * `dispatchCount` counts dispatches started in the slice (session ids repeat across attempts). */
export interface AgentRuntimeTokenUsageBucket extends AgentRuntimeTokenUsageReporting {
  readonly bucketStart: string;
  readonly dispatchCount: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
}
export type AgentRuntimeTokenUsageResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly range: AgentRuntimeTokenUsageRange;
  /** Inclusive lower bound of the window: local midnight on the daemon's clock. */
  readonly since: string;
  readonly bucketMs: number;
  readonly totals: AgentRuntimeTokenUsageTotals;
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly agents: readonly AgentRuntimeTokenUsageAgentRow[];
  readonly squads: readonly AgentRuntimeTokenUsageSquadRow[];
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
 * "pending" while no runtime_metrics record exists yet (typically still running). */
export interface AgentRuntimeTokenUsageSessionRow {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly taskId: string | null;
  readonly model: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: "running" | "succeeded" | "failed" | "unknown";
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
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
  readonly watermark: number;
  readonly sourceRevision: number;
};

type UsageAccumulator = {
  name: string;
  sessions: Set<string>;
  usageReportedDispatches: number;
  usageUnavailableDispatches: number;
  counters: {
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCallCount: number;
  };
};

/** Local calendar days in the window (inclusive of today): today keeps hour buckets, the
 * multi-day ranges one bucket per local day. The ladder stops at `now` — no future zeros. */
function planWindow(
  now: Date,
  range: AgentRuntimeTokenUsageRange,
): { readonly sinceMs: number; readonly bucketMs: number } {
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  return {
    sinceMs: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime(),
    bucketMs: range === "today" ? 3_600_000 : 86_400_000,
  };
}

/** One dispatch inside the window with the summary fields both reads need. Reading the summary
 * (bounded head/tail windows, cached by mtime+size) is the whole read cost — no full-file scan. */
function windowDispatches(
  rootDir: string,
  sinceMs: number,
  pick: (header: DispatchStreamHeader) => boolean,
): { readonly header: DispatchStreamHeader; readonly summary: DispatchStreamSummary | null }[] {
  const selected: { readonly header: DispatchStreamHeader; readonly summary: DispatchStreamSummary | null }[] = [];
  for (const header of readDispatchStreamHeaders(rootDir)) {
    if (Date.parse(header.startedAt) < sinceMs || !pick(header)) continue;
    selected.push({ header, summary: readDispatchStreamSummary(rootDir, header.dispatchId) });
  }
  return selected;
}

/**
 * The per-agent (and per-squad) consumption aggregate for the requested range, read-only. The
 * dispatch stream headers carry the attribution (agentId/agentName/squadId/startedAt) and each
 * stream summary carries the latest `runtime_metrics` record, so the renderer gets one
 * aggregate instead of pulling every dispatch row. Dispatches without agent or squad
 * attribution are not part of either view; the session count still includes dispatches whose
 * metrics have not been emitted yet.
 */
export function readAgentRuntimeTokenUsage(input: {
  readonly rootDir: string;
  readonly now: string;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly entityLabel: (squadId: string) => string | null;
  readonly cut: {
    readonly status: "ready" | "pending";
    readonly watermark: number;
    readonly sourceRevision: number;
  };
}): AgentRuntimeTokenUsageResult {
  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime())) throw new Error(`Agent runtime token usage now is invalid: ${input.now}.`);
  const { sinceMs, bucketMs } = planWindow(now, input.range),
    agents = new Map<string, UsageAccumulator>(),
    squads = new Map<string, UsageAccumulator>(),
    // The totals strip and the trend answer "how much / when" for the whole window — every
    // dispatch counts exactly once here, while the member rows below stay attribution views
    // (a dispatch carrying both agent and squad attribution appears in both rows).
    fleet = new Map<string, UsageAccumulator>([
      [
        "",
        {
          name: "",
          sessions: new Set<string>(),
          counters: zero(),
          usageReportedDispatches: 0,
          usageUnavailableDispatches: 0,
        },
      ],
    ]),
    buckets = bucketLadder(sinceMs, now.getTime(), bucketMs);
  for (const { header, summary } of windowDispatches(input.rootDir, sinceMs, () => true)) {
    const metrics = summary?.runtimeMetrics ?? null;
    accumulateBucket(buckets, header.startedAt, metrics, sinceMs, bucketMs);
    accumulate(fleet, "", "", header, metrics);
    if (header.agentId) accumulate(agents, header.agentId, header.agentName ?? header.agentId, header, metrics);
    if (header.squadId)
      accumulate(squads, header.squadId, input.entityLabel(header.squadId) ?? header.squadId, header, metrics);
  }
  return {
    ok: true,
    status: input.cut.status,
    range: input.range,
    since: new Date(sinceMs).toISOString(),
    bucketMs,
    totals: countersOf(fleet.get("")!),
    buckets,
    agents: [...agentRows(agents)].sort(compareRows),
    squads: [...squadRows(squads)].sort(compareRows),
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
  for (const { header, summary } of windowDispatches(input.rootDir, sinceMs, pickMember)) {
    if (memberName === null && member.kind === "agent") memberName = header.agentName ?? member.agentId;
    sessions.push(sessionRowOf(header, summary));
    const metrics = summary?.runtimeMetrics ?? null;
    accumulateBucket(buckets, header.startedAt, metrics, sinceMs, bucketMs);
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
    totals: detailTotals(sessions),
    buckets,
    sessions,
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
  readonly projection: Pick<TaskProjection, "readCut" | "getEntity">;
  readonly range: AgentRuntimeTokenUsageRange;
}): AgentRuntimeTokenUsageResult {
  const cut = context.projection.readCut();
  return readAgentRuntimeTokenUsage({
    rootDir: context.rootDir,
    now: context.now(),
    range: context.range,
    entityLabel: entityLabelOf(cut, context.projection),
    cut,
  });
}
export function agentRuntimeTokenUsageDetailHandler(context: {
  readonly rootDir: string;
  readonly now: () => string;
  readonly projection: Pick<TaskProjection, "readCut" | "getEntity">;
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
  });
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

/** The accumulating form of a bucket; frozen into the readonly result shape once filled. */
type MutableBucket = {
  bucketStart: string;
  dispatchCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallCount: number;
  usageReportedDispatches: number;
  usageUnavailableDispatches: number;
};
function bucketLadder(sinceMs: number, nowMs: number, bucketMs: number): MutableBucket[] {
  const buckets: MutableBucket[] = [];
  for (let start = sinceMs; start <= nowMs; start += bucketMs)
    buckets.push({
      bucketStart: new Date(start).toISOString(),
      dispatchCount: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallCount: 0,
      usageReportedDispatches: 0,
      usageUnavailableDispatches: 0,
    });
  return buckets;
}
function bucketOf(
  buckets: readonly MutableBucket[],
  startedAt: string,
  sinceMs: number,
  bucketMs: number,
): MutableBucket | null {
  const at = Date.parse(startedAt),
    index = Number.isFinite(at) ? Math.floor((at - sinceMs) / bucketMs) : -1;
  return index >= 0 && index < buckets.length ? (buckets[index] ?? null) : null;
}
function accumulateBucket(
  buckets: readonly MutableBucket[],
  startedAt: string,
  metrics: DispatchStreamSummary["runtimeMetrics"],
  sinceMs: number,
  bucketMs: number,
): void {
  const bucket = bucketOf(buckets, startedAt, sinceMs, bucketMs);
  if (bucket === null) return;
  bucket.dispatchCount += 1;
  if (metrics) {
    bucket.inputTokens += metrics.inputTokens;
    bucket.cacheReadTokens += metrics.cacheReadTokens;
    bucket.outputTokens += metrics.outputTokens;
    bucket.totalTokens += metrics.totalTokens;
    bucket.toolCallCount += metrics.toolCallCount;
    if (metrics.usageUnavailable === true) bucket.usageUnavailableDispatches += 1;
    else bucket.usageReportedDispatches += 1;
  }
}

function accumulate(
  map: Map<string, UsageAccumulator>,
  key: string,
  name: string,
  header: DispatchStreamHeader,
  metrics: DispatchStreamSummary["runtimeMetrics"],
): void {
  const accumulator = map.get(key) ?? {
    name,
    sessions: new Set<string>(),
    counters: zero(),
    usageReportedDispatches: 0,
    usageUnavailableDispatches: 0,
  };
  accumulator.sessions.add(header.runtimeSessionId);
  if (metrics) {
    accumulator.counters.inputTokens += metrics.inputTokens;
    accumulator.counters.cacheReadTokens += metrics.cacheReadTokens;
    accumulator.counters.outputTokens += metrics.outputTokens;
    accumulator.counters.totalTokens += metrics.totalTokens;
    accumulator.counters.toolCallCount += metrics.toolCallCount;
    if (metrics.usageUnavailable === true) accumulator.usageUnavailableDispatches += 1;
    else accumulator.usageReportedDispatches += 1;
  }
  map.set(key, accumulator);
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
    outputTokens: metrics?.outputTokens ?? 0,
    totalTokens: metrics?.totalTokens ?? 0,
    toolCallCount: metrics?.toolCallCount ?? 0,
    usage: metrics === null ? "pending" : metrics.usageUnavailable === true ? "unavailable" : "reported",
  };
}
/** Coarse outcome from the stream's own lifecycle records: the process record says whether the
 * dispatch settled, the attempt classification keeps provider faults from posing as success. */
function dispatchOutcomeWord(summary: DispatchStreamSummary | null): AgentRuntimeTokenUsageSessionRow["outcome"] {
  const process = summary?.process ?? null;
  if (process === null || !process.exited) return process === null ? "unknown" : "running";
  const classification = summary?.attemptOutcome?.classification;
  if (classification === "provider_fault" || classification === "provider_quota" || classification === "gate_red")
    return "failed";
  return process.exitCode === 0 ? "succeeded" : process.exitCode === null ? "unknown" : "failed";
}
function exitOccurredAt(summary: DispatchStreamSummary): string | null {
  let endedAt: string | null = null;
  for (const record of summary.records)
    if (record.kind === "process_exit" && typeof record.occurredAt === "string") endedAt = record.occurredAt;
  return endedAt;
}

function detailTotals(sessions: readonly AgentRuntimeTokenUsageSessionRow[]): AgentRuntimeTokenUsageTotals {
  const unique = new Set(sessions.map(({ runtimeSessionId }) => runtimeSessionId));
  return {
    sessionCount: unique.size,
    inputTokens: sum(sessions, ({ inputTokens }) => inputTokens),
    cacheReadTokens: sum(sessions, ({ cacheReadTokens }) => cacheReadTokens),
    outputTokens: sum(sessions, ({ outputTokens }) => outputTokens),
    totalTokens: sum(sessions, ({ totalTokens }) => totalTokens),
    toolCallCount: sum(sessions, ({ toolCallCount }) => toolCallCount),
    usageReportedDispatches: sessions.filter(({ usage }) => usage === "reported").length,
    usageUnavailableDispatches: sessions.filter(({ usage }) => usage === "unavailable").length,
  };
}
function sum<T>(values: readonly T[], pick: (value: T) => number): number {
  return values.reduce((total, value) => total + pick(value), 0);
}

function* agentRows(
  agents: ReadonlyMap<string, UsageAccumulator>,
): Generator<AgentRuntimeTokenUsageAgentRow, void, undefined> {
  for (const [agentId, accumulator] of agents)
    yield { agentId, agentName: accumulator.name, ...countersOf(accumulator) };
}
function* squadRows(
  squads: ReadonlyMap<string, UsageAccumulator>,
): Generator<AgentRuntimeTokenUsageSquadRow, void, undefined> {
  for (const [squadId, accumulator] of squads)
    yield { squadId, squadName: accumulator.name, ...countersOf(accumulator) };
}
function countersOf(accumulator: UsageAccumulator): AgentRuntimeTokenUsageTotals {
  return {
    sessionCount: accumulator.sessions.size,
    ...accumulator.counters,
    usageReportedDispatches: accumulator.usageReportedDispatches,
    usageUnavailableDispatches: accumulator.usageUnavailableDispatches,
  };
}
function zero(): UsageAccumulator["counters"] {
  return { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, toolCallCount: 0 };
}

function compareRows(
  left: AgentRuntimeTokenUsageAgentRow | AgentRuntimeTokenUsageSquadRow,
  right: AgentRuntimeTokenUsageAgentRow | AgentRuntimeTokenUsageSquadRow,
): number {
  const leftKey = "agentId" in left ? left.agentId : left.squadId,
    rightKey = "agentId" in right ? right.agentId : right.squadId;
  return right.totalTokens - left.totalTokens || leftKey.localeCompare(rightKey);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const isoTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableNonEmptyString = (value: unknown): value is string | null => value === null || nonEmptyString(value);

const totalsFields = [
  "sessionCount",
  "inputTokens",
  "cacheReadTokens",
  "outputTokens",
  "totalTokens",
  "toolCallCount",
  "usageReportedDispatches",
  "usageUnavailableDispatches",
];
/** Counter fields without the exact-key-count rule — member rows carry id/name on top. */
function hasTotalsFields(value: Record<string, unknown>): boolean {
  return totalsFields.every((field) => nonNegativeInteger(value[field]));
}
function validTotals(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 8 && hasTotalsFields(value);
}
function validBucket(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 9 &&
    isoTimestamp(value.bucketStart) &&
    nonNegativeInteger(value.dispatchCount) &&
    ["inputTokens", "cacheReadTokens", "outputTokens", "totalTokens", "toolCallCount"].every((field) =>
      nonNegativeInteger(value[field]),
    ) &&
    ["usageReportedDispatches", "usageUnavailableDispatches"].every((field) => nonNegativeInteger(value[field]))
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
    Object.keys(value).length === 14 &&
    nonEmptyString(value.dispatchId) &&
    nonEmptyString(value.runtimeSessionId) &&
    nullableNonEmptyString(value.taskId) &&
    nullableNonEmptyString(value.model) &&
    isoTimestamp(value.startedAt) &&
    nullableNonEmptyString(value.endedAt) &&
    (value.durationMs === null || nonNegativeInteger(value.durationMs)) &&
    ["running", "succeeded", "failed", "unknown"].includes(String(value.outcome)) &&
    ["inputTokens", "cacheReadTokens", "outputTokens", "totalTokens", "toolCallCount"].every((field) =>
      nonNegativeInteger(value[field]),
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
    nonNegativeInteger(value.watermark) &&
    nonNegativeInteger(value.sourceRevision)
  );
}

export function validateAgentRuntimeTokenUsage(value: unknown): readonly string[] {
  const validRow = (row: unknown, idField: string, nameField: string): boolean =>
    isRecord(row) &&
    Object.keys(row).length === 10 &&
    nonEmptyString(row[idField]) &&
    nonEmptyString(row[nameField]) &&
    hasTotalsFields(row);
  return isRecord(value) &&
    Object.keys(value).length === 11 &&
    sharedResultFields(value) &&
    Array.isArray(value.agents) &&
    value.agents.every((row) => validRow(row, "agentId", "agentName")) &&
    Array.isArray(value.squads) &&
    value.squads.every((row) => validRow(row, "squadId", "squadName"))
    ? []
    : ["agent runtime token usage is invalid"];
}
export function validateAgentRuntimeTokenUsageDetail(value: unknown): readonly string[] {
  return isRecord(value) &&
    Object.keys(value).length === 11 &&
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

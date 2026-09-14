import type { TaskProjection } from "../../kernel/src/index.ts";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";

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
export interface AgentRuntimeTokenUsageAgentRow extends AgentRuntimeTokenUsageCounters {
  readonly agentId: string;
  readonly agentName: string;
}
export interface AgentRuntimeTokenUsageSquadRow extends AgentRuntimeTokenUsageCounters {
  readonly squadId: string;
  readonly squadName: string;
}
export type AgentRuntimeTokenUsageResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  /** Inclusive lower bound of the window: local midnight on the daemon's clock. */
  readonly since: string;
  readonly agents: readonly AgentRuntimeTokenUsageAgentRow[];
  readonly squads: readonly AgentRuntimeTokenUsageSquadRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
};

type UsageAccumulator = {
  name: string;
  sessions: Set<string>;
  counters: {
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCallCount: number;
  };
};

/**
 * The per-agent (and per-squad) consumption aggregate for today, read-only. The dispatch
 * stream headers carry the attribution (agentId/agentName/squadId/startedAt) and each
 * stream summary carries the latest `runtime_metrics` record, so the renderer gets one
 * aggregate instead of pulling every dispatch row. Dispatches without agent or squad
 * attribution are not part of either view; the session count still includes dispatches
 * whose metrics have not been emitted yet.
 */
export function readAgentRuntimeTokenUsage(input: {
  readonly rootDir: string;
  readonly now: string;
  readonly entityLabel: (squadId: string) => string | null;
  readonly cut: {
    readonly status: "ready" | "pending";
    readonly watermark: number;
    readonly sourceRevision: number;
  };
}): AgentRuntimeTokenUsageResult {
  const sinceMs = localMidnightMs(input.now),
    agents = new Map<string, UsageAccumulator>(),
    squads = new Map<string, UsageAccumulator>();
  for (const header of readDispatchStreamHeaders(input.rootDir)) {
    if (Date.parse(header.startedAt) < sinceMs) continue;
    const metrics = readDispatchStreamSummary(input.rootDir, header.dispatchId)?.runtimeMetrics ?? null;
    if (header.agentId)
      accumulate(agents, header.agentId, header.agentName ?? header.agentId, header.runtimeSessionId, metrics);
    if (header.squadId)
      accumulate(
        squads,
        header.squadId,
        input.entityLabel(header.squadId) ?? header.squadId,
        header.runtimeSessionId,
        metrics,
      );
  }
  return {
    ok: true,
    status: input.cut.status,
    since: new Date(sinceMs).toISOString(),
    agents: [...agentRows(agents)].sort(compareRows),
    squads: [...squadRows(squads)].sort(compareRows),
    watermark: input.cut.watermark,
    sourceRevision: input.cut.sourceRevision,
  };
}

/**
 * The repo-cell handler for `repo.agentRuntime.tokenUsage`. The squad display name comes from
 * the entity projection, guarded by the same ready-cut check the session-groups read uses.
 */
export function agentRuntimeTokenUsageHandler(context: {
  readonly rootDir: string;
  readonly now: () => string;
  readonly projection: Pick<TaskProjection, "readCut" | "getEntity">;
}): AgentRuntimeTokenUsageResult {
  const cut = context.projection.readCut();
  return readAgentRuntimeTokenUsage({
    rootDir: context.rootDir,
    now: context.now(),
    entityLabel: (squadId) => {
      const value = cut.status === "ready" ? context.projection.getEntity("squad", squadId)?.value : undefined;
      return typeof value?.name === "string" && value.name ? value.name : null;
    },
    cut,
  });
}

function accumulate(
  map: Map<string, UsageAccumulator>,
  key: string,
  name: string,
  runtimeSessionId: string,
  metrics: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly toolCallCount: number;
  } | null,
): void {
  const accumulator = map.get(key) ?? { name, sessions: new Set<string>(), counters: zero() };
  accumulator.sessions.add(runtimeSessionId);
  if (metrics) {
    accumulator.counters.inputTokens += metrics.inputTokens;
    accumulator.counters.cacheReadTokens += metrics.cacheReadTokens;
    accumulator.counters.outputTokens += metrics.outputTokens;
    accumulator.counters.totalTokens += metrics.totalTokens;
    accumulator.counters.toolCallCount += metrics.toolCallCount;
  }
  map.set(key, accumulator);
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
function countersOf(accumulator: UsageAccumulator): AgentRuntimeTokenUsageCounters {
  return { sessionCount: accumulator.sessions.size, ...accumulator.counters };
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

/** Local midnight of `now` on the daemon's clock: the definition of "today" for this read. */
function localMidnightMs(now: string): number {
  const at = new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error(`Agent runtime token usage now is invalid: ${now}.`);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isoTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));

export function validateAgentRuntimeTokenUsage(value: unknown): readonly string[] {
  const counters = ["sessionCount", "inputTokens", "cacheReadTokens", "outputTokens", "totalTokens", "toolCallCount"];
  const validRow = (row: unknown, idField: string, nameField: string): boolean =>
    isRecord(row) &&
    Object.keys(row).length === counters.length + 2 &&
    [row[idField], row[nameField]].every((item) => typeof item === "string" && item.length > 0) &&
    counters.every((field) => nonNegativeInteger(row[field]));
  return isRecord(value) &&
    Object.keys(value).length === 7 &&
    value.ok === true &&
    ["ready", "pending"].includes(String(value.status)) &&
    isoTimestamp(value.since) &&
    Array.isArray(value.agents) &&
    value.agents.every((row) => validRow(row, "agentId", "agentName")) &&
    Array.isArray(value.squads) &&
    value.squads.every((row) => validRow(row, "squadId", "squadName")) &&
    nonNegativeInteger(value.watermark) &&
    nonNegativeInteger(value.sourceRevision)
    ? []
    : ["agent runtime token usage is invalid"];
}

export function serializeAgentRuntimeTokenUsage(value: unknown): string {
  const errors = validateAgentRuntimeTokenUsage(value);
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}

import type { AgentRuntimeTokenUsageSessionRow } from "./agent-runtime-token-usage.ts";
import type { WorkRuleTask } from "./workspace-scope-read.ts";

/**
 * The analysis groups of `repo.agentRuntime.tokenUsage`, computed in the same pass as the
 * totals so the renderer never fans out detail reads: spend per task and work, session-level
 * statistics and size distribution, spend per outcome, the per-agent / per-model trend
 * series, and which providers settled without usage numbers. Every group is bounded by
 * `tokenUsageInsightLimits` or a fixed vocabulary, independent of how many dispatches the
 * window holds.
 */

/** Row caps of the analysis groups: each list is the top N by total tokens (dispatch count for
 * the unreported providers); the trend keeps N named series and folds the rest into one. */
export const tokenUsageInsightLimits = Object.freeze({
  models: 12,
  tasks: 10,
  works: 8,
  topSessions: 8,
  trendSeries: 5,
  unreportedProviders: 8,
});
/** Upper bounds (exclusive) of the session size bins, in total tokens; the last bin is open. */
export const tokenUsageSessionBinCeilings: readonly (number | null)[] = Object.freeze([
  10_000,
  100_000,
  1_000_000,
  10_000_000,
  100_000_000,
  null,
]);
/** `aborted` is a process that exited without an exit code (terminated by a signal); `unknown`
 * is a dispatch with no process record on this daemon. */
export const tokenUsageOutcomeWords = Object.freeze(["succeeded", "failed", "aborted", "running", "unknown"] as const);
export type AgentRuntimeTokenUsageOutcome = (typeof tokenUsageOutcomeWords)[number];

/** How the sessions a row covers ended. A session's outcome is that of its latest dispatch. */
export interface AgentRuntimeTokenUsageSessionOutcomes {
  readonly succeededSessions: number;
  readonly failedSessions: number;
  readonly abortedSessions: number;
}
export interface AgentRuntimeTokenUsageTaskRow {
  readonly taskId: string;
  /** The task title, or the id while the projection cannot name it. */
  readonly title: string;
  readonly workId: string | null;
  readonly workTitle: string | null;
  readonly sessionCount: number;
  readonly totalTokens: number;
}
export interface AgentRuntimeTokenUsageWorkRow {
  readonly workId: string;
  readonly title: string;
  /** Tasks of this work that had a dispatch in the window. */
  readonly taskCount: number;
  readonly sessionCount: number;
  readonly totalTokens: number;
}
export interface AgentRuntimeTokenUsageOutcomeRow {
  readonly outcome: AgentRuntimeTokenUsageOutcome;
  readonly sessionCount: number;
  readonly totalTokens: number;
}
export interface AgentRuntimeTokenUsageSessionBin {
  /** Exclusive upper bound in total tokens; null for the open last bin. */
  readonly ceiling: number | null;
  readonly sessionCount: number;
  readonly totalTokens: number;
}
export interface AgentRuntimeTokenUsageTopSession {
  readonly runtimeSessionId: string;
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  readonly model: string | null;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly outcome: AgentRuntimeTokenUsageOutcome;
  readonly totalTokens: number;
  readonly toolCallCount: number;
}
/** Session-level statistics. The token figures cover the sessions with reported usage only
 * (`reportedSessions`); a session whose provider reported nothing is missing data, not a zero. */
export interface AgentRuntimeTokenUsageSessionStats {
  readonly reportedSessions: number;
  readonly averageTokens: number;
  readonly medianTokens: number;
  readonly p90Tokens: number;
  readonly maxTokens: number;
  /** Mean run time of the sessions that have ended (`timedSessions`); null when none has. */
  readonly averageDurationMs: number | null;
  readonly timedSessions: number;
  readonly averageToolCalls: number;
  readonly distribution: readonly AgentRuntimeTokenUsageSessionBin[];
  readonly top: readonly AgentRuntimeTokenUsageTopSession[];
}
/** One stacked series of the trend, aligned index-for-index with `buckets`. `key` null is the
 * fold of everything outside the named series (including dispatches without that attribution). */
export interface AgentRuntimeTokenUsageTrendSeries {
  readonly key: string | null;
  readonly name: string;
  readonly totalTokens: readonly number[];
}
export interface AgentRuntimeTokenUsageUnreportedProvider {
  readonly kindId: string;
  readonly instanceId: string;
  readonly dispatchCount: number;
}
export interface AgentRuntimeTokenUsageInsights {
  readonly tasks: readonly AgentRuntimeTokenUsageTaskRow[];
  readonly works: readonly AgentRuntimeTokenUsageWorkRow[];
  readonly sessions: AgentRuntimeTokenUsageSessionStats;
  readonly outcomes: readonly AgentRuntimeTokenUsageOutcomeRow[];
  readonly trend: {
    readonly agents: readonly AgentRuntimeTokenUsageTrendSeries[];
    readonly models: readonly AgentRuntimeTokenUsageTrendSeries[];
  };
  readonly unreported: readonly AgentRuntimeTokenUsageUnreportedProvider[];
}

/** One dispatch of the window with the attribution the analysis groups key on. */
export interface TokenUsageDispatchFact extends AgentRuntimeTokenUsageSessionRow {
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly kindId: string | null;
  readonly instanceId: string;
  /** Index into the window's bucket ladder; -1 when the dispatch falls outside it. */
  readonly bucketIndex: number;
}

type Session = {
  readonly runtimeSessionId: string;
  latest: TokenUsageDispatchFact;
  startedAt: string;
  totalTokens: number;
  toolCallCount: number;
  durationMs: number | null;
  reported: boolean;
};

export function tokenUsageInsights(input: {
  readonly facts: readonly TokenUsageDispatchFact[];
  readonly bucketCount: number;
  readonly taskOf: (taskId: string) => WorkRuleTask | undefined;
  readonly workOf: (taskId: string) => WorkRuleTask | null;
}): AgentRuntimeTokenUsageInsights & {
  readonly sessionOutcome: ReadonlyMap<string, AgentRuntimeTokenUsageOutcome>;
} {
  const sessions = foldSessions(input.facts);
  return {
    ...taskRows(input.facts, input.taskOf, input.workOf),
    sessions: sessionStats(sessions, input.taskOf),
    outcomes: tokenUsageOutcomeWords.map((outcome) => {
      const matching = sessions.filter(({ latest }) => latest.outcome === outcome);
      return { outcome, sessionCount: matching.length, totalTokens: sum(matching, (session) => session.totalTokens) };
    }),
    trend: {
      agents: trendSeries(
        input.facts,
        input.bucketCount,
        ({ agentId }) => agentId,
        ({ agentName, agentId }) => agentName ?? agentId,
      ),
      models: trendSeries(
        input.facts,
        input.bucketCount,
        ({ model }) => model,
        ({ model }) => model,
      ),
    },
    unreported: unreportedProviders(input.facts),
    sessionOutcome: new Map(sessions.map(({ runtimeSessionId, latest }) => [runtimeSessionId, latest.outcome])),
  };
}

/** A runtime session spans every dispatch that carries its id (attempts, resumes): counters
 * add up, attribution and outcome come from the latest dispatch. */
function foldSessions(facts: readonly TokenUsageDispatchFact[]): Session[] {
  const sessions = new Map<string, Session>();
  for (const fact of facts) {
    const session = sessions.get(fact.runtimeSessionId);
    if (session === undefined) {
      sessions.set(fact.runtimeSessionId, {
        runtimeSessionId: fact.runtimeSessionId,
        latest: fact,
        startedAt: fact.startedAt,
        totalTokens: fact.totalTokens,
        toolCallCount: fact.toolCallCount,
        durationMs: fact.durationMs,
        reported: fact.usage === "reported",
      });
      continue;
    }
    if (later(fact, session.latest)) session.latest = fact;
    if (Date.parse(fact.startedAt) < Date.parse(session.startedAt)) session.startedAt = fact.startedAt;
    session.totalTokens += fact.totalTokens;
    session.toolCallCount += fact.toolCallCount;
    if (fact.durationMs !== null) session.durationMs = (session.durationMs ?? 0) + fact.durationMs;
    session.reported ||= fact.usage === "reported";
  }
  return [...sessions.values()];
}
function later(left: TokenUsageDispatchFact, right: TokenUsageDispatchFact): boolean {
  const delta = Date.parse(left.startedAt) - Date.parse(right.startedAt);
  return delta > 0 || (delta === 0 && left.dispatchId > right.dispatchId);
}

function sessionStats(
  sessions: readonly Session[],
  taskOf: (taskId: string) => WorkRuleTask | undefined,
): AgentRuntimeTokenUsageSessionStats {
  const sizes = sessions
      .filter(({ reported }) => reported)
      .map(({ totalTokens }) => totalTokens)
      .sort((left, right) => left - right),
    timed = sessions.filter(({ durationMs }) => durationMs !== null),
    rank = (share: number): number => sizes[Math.max(0, Math.ceil(sizes.length * share) - 1)] ?? 0;
  return {
    reportedSessions: sizes.length,
    averageTokens: mean(sizes),
    medianTokens: rank(0.5),
    p90Tokens: rank(0.9),
    maxTokens: sizes.at(-1) ?? 0,
    averageDurationMs: timed.length === 0 ? null : Math.max(0, mean(timed.map(({ durationMs }) => durationMs ?? 0))),
    timedSessions: timed.length,
    averageToolCalls: mean(sessions.map(({ toolCallCount }) => toolCallCount)),
    distribution: tokenUsageSessionBinCeilings.map((ceiling, index) => {
      const floor = index === 0 ? 0 : (tokenUsageSessionBinCeilings[index - 1] ?? 0),
        inBin = sizes.filter((size) => size >= floor && (ceiling === null || size < ceiling));
      return { ceiling, sessionCount: inBin.length, totalTokens: sum(inBin, (size) => size) };
    }),
    top: sessions
      .filter(({ totalTokens }) => totalTokens > 0)
      .sort(
        (left, right) =>
          right.totalTokens - left.totalTokens || left.runtimeSessionId.localeCompare(right.runtimeSessionId),
      )
      .slice(0, tokenUsageInsightLimits.topSessions)
      .map(({ runtimeSessionId, latest, startedAt, totalTokens, toolCallCount, durationMs }) => ({
        runtimeSessionId,
        agentId: latest.agentId,
        agentName: latest.agentName,
        taskId: latest.taskId,
        taskTitle: latest.taskId === null ? null : (taskOf(latest.taskId)?.title ?? null),
        model: latest.model,
        startedAt,
        durationMs: durationMs === null ? null : Math.max(0, durationMs),
        outcome: latest.outcome,
        totalTokens,
        toolCallCount,
      })),
  };
}

function taskRows(
  facts: readonly TokenUsageDispatchFact[],
  taskOf: (taskId: string) => WorkRuleTask | undefined,
  workOf: (taskId: string) => WorkRuleTask | null,
): Pick<AgentRuntimeTokenUsageInsights, "tasks" | "works"> {
  type Spend = { sessions: Set<string>; totalTokens: number };
  const tasks = new Map<string, Spend>(),
    works = new Map<string, Spend & { title: string; tasks: Set<string> }>(),
    workOfTask = new Map<string, WorkRuleTask | null>();
  for (const fact of facts) {
    if (fact.taskId === null) continue;
    const task = tasks.get(fact.taskId) ?? { sessions: new Set<string>(), totalTokens: 0 };
    task.sessions.add(fact.runtimeSessionId);
    task.totalTokens += fact.totalTokens;
    tasks.set(fact.taskId, task);
    if (!workOfTask.has(fact.taskId)) workOfTask.set(fact.taskId, workOf(fact.taskId));
    const root = workOfTask.get(fact.taskId) ?? null;
    if (root === null) continue;
    const work = works.get(root.taskId) ?? {
      title: root.title,
      tasks: new Set<string>(),
      sessions: new Set<string>(),
      totalTokens: 0,
    };
    work.tasks.add(fact.taskId);
    work.sessions.add(fact.runtimeSessionId);
    work.totalTokens += fact.totalTokens;
    works.set(root.taskId, work);
  }
  const bySpend = (left: readonly [string, Spend], right: readonly [string, Spend]): number =>
    right[1].totalTokens - left[1].totalTokens || left[0].localeCompare(right[0]);
  return {
    tasks: [...tasks]
      .sort(bySpend)
      .slice(0, tokenUsageInsightLimits.tasks)
      .map(([taskId, spend]) => {
        const work = workOfTask.get(taskId) ?? null;
        return {
          taskId,
          title: taskOf(taskId)?.title || taskId,
          workId: work?.taskId ?? null,
          workTitle: work === null ? null : work.title || work.taskId,
          sessionCount: spend.sessions.size,
          totalTokens: spend.totalTokens,
        };
      }),
    works: [...works]
      .sort(bySpend)
      .slice(0, tokenUsageInsightLimits.works)
      .map(([workId, work]) => ({
        workId,
        title: work.title || workId,
        taskCount: work.tasks.size,
        sessionCount: work.sessions.size,
        totalTokens: work.totalTokens,
      })),
  };
}

function trendSeries(
  facts: readonly TokenUsageDispatchFact[],
  bucketCount: number,
  keyOf: (fact: TokenUsageDispatchFact) => string | null,
  nameOf: (fact: TokenUsageDispatchFact) => string | null,
): AgentRuntimeTokenUsageTrendSeries[] {
  const series = new Map<string, { name: string; total: number; totalTokens: number[] }>(),
    rest = new Array<number>(bucketCount).fill(0);
  for (const fact of facts) {
    if (fact.bucketIndex < 0 || fact.bucketIndex >= bucketCount) continue;
    const key = keyOf(fact);
    if (key === null) {
      rest[fact.bucketIndex]! += fact.totalTokens;
      continue;
    }
    const row = series.get(key) ?? {
      name: nameOf(fact) ?? key,
      total: 0,
      totalTokens: new Array<number>(bucketCount).fill(0),
    };
    row.total += fact.totalTokens;
    row.totalTokens[fact.bucketIndex]! += fact.totalTokens;
    series.set(key, row);
  }
  const ranked = [...series]
    .filter(([, row]) => row.total > 0)
    .sort((left, right) => right[1].total - left[1].total || left[0].localeCompare(right[0]));
  for (const [, row] of ranked.slice(tokenUsageInsightLimits.trendSeries))
    row.totalTokens.forEach((value, index) => (rest[index]! += value));
  const named = ranked
    .slice(0, tokenUsageInsightLimits.trendSeries)
    .map(([key, row]) => ({ key, name: row.name, totalTokens: row.totalTokens }));
  return rest.some((value) => value > 0) ? [...named, { key: null, name: "", totalTokens: rest }] : named;
}

function unreportedProviders(facts: readonly TokenUsageDispatchFact[]): AgentRuntimeTokenUsageUnreportedProvider[] {
  const providers = new Map<string, { kindId: string; instanceId: string; dispatchCount: number }>();
  for (const fact of facts) {
    if (fact.usage !== "unavailable") continue;
    const kindId = fact.kindId ?? "unknown",
      key = `${kindId}\u0000${fact.instanceId}`,
      row = providers.get(key) ?? { kindId, instanceId: fact.instanceId, dispatchCount: 0 };
    row.dispatchCount += 1;
    providers.set(key, row);
  }
  return [...providers.values()]
    .sort(
      (left, right) =>
        right.dispatchCount - left.dispatchCount ||
        left.kindId.localeCompare(right.kindId) ||
        left.instanceId.localeCompare(right.instanceId),
    )
    .slice(0, tokenUsageInsightLimits.unreportedProviders);
}

function sum<T>(values: readonly T[], pick: (value: T) => number): number {
  return values.reduce((total, value) => total + pick(value), 0);
}
function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.round(sum(values, (value) => value) / values.length);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableText = (value: unknown): boolean => value === null || text(value);
const shaped = (value: unknown, keys: number): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).length === keys;
const rows = (value: unknown, limit: number, valid: (row: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= limit && value.every(valid);

export const sessionOutcomeFields = ["succeededSessions", "failedSessions", "abortedSessions"];

function validSessionStats(value: unknown): boolean {
  return (
    shaped(value, 10) &&
    ["reportedSessions", "averageTokens", "medianTokens", "p90Tokens", "maxTokens", "timedSessions"].every((field) =>
      count(value[field]),
    ) &&
    count(value.averageToolCalls) &&
    (value.averageDurationMs === null || count(value.averageDurationMs)) &&
    Array.isArray(value.distribution) &&
    value.distribution.length === tokenUsageSessionBinCeilings.length &&
    value.distribution.every(
      (bin, index) =>
        shaped(bin, 3) &&
        bin.ceiling === tokenUsageSessionBinCeilings[index] &&
        count(bin.sessionCount) &&
        count(bin.totalTokens),
    ) &&
    rows(
      value.top,
      tokenUsageInsightLimits.topSessions,
      (row) =>
        shaped(row, 11) &&
        text(row.runtimeSessionId) &&
        ["agentId", "agentName", "taskId", "taskTitle", "model"].every((field) => nullableText(row[field])) &&
        text(row.startedAt) &&
        Number.isFinite(Date.parse(row.startedAt)) &&
        (row.durationMs === null || count(row.durationMs)) &&
        tokenUsageOutcomeWords.includes(row.outcome as AgentRuntimeTokenUsageOutcome) &&
        count(row.totalTokens) &&
        count(row.toolCallCount),
    )
  );
}
function validTrend(value: unknown, bucketCount: number): boolean {
  return rows(
    value,
    tokenUsageInsightLimits.trendSeries + 1,
    (row) =>
      shaped(row, 3) &&
      (row.key === null ? row.name === "" : text(row.key) && text(row.name)) &&
      Array.isArray(row.totalTokens) &&
      row.totalTokens.length === bucketCount &&
      row.totalTokens.every(count),
  );
}

/** Whether the analysis groups of a token usage result hold their declared shape and bounds. */
export function validTokenUsageInsights(value: Record<string, unknown>, bucketCount: number): boolean {
  return (
    rows(
      value.tasks,
      tokenUsageInsightLimits.tasks,
      (row) =>
        shaped(row, 6) &&
        text(row.taskId) &&
        text(row.title) &&
        nullableText(row.workId) &&
        nullableText(row.workTitle) &&
        count(row.sessionCount) &&
        count(row.totalTokens),
    ) &&
    rows(
      value.works,
      tokenUsageInsightLimits.works,
      (row) =>
        shaped(row, 5) &&
        text(row.workId) &&
        text(row.title) &&
        count(row.taskCount) &&
        count(row.sessionCount) &&
        count(row.totalTokens),
    ) &&
    validSessionStats(value.sessions) &&
    Array.isArray(value.outcomes) &&
    value.outcomes.length === tokenUsageOutcomeWords.length &&
    value.outcomes.every(
      (row, index) =>
        shaped(row, 3) &&
        row.outcome === tokenUsageOutcomeWords[index] &&
        count(row.sessionCount) &&
        count(row.totalTokens),
    ) &&
    shaped(value.trend, 2) &&
    validTrend(value.trend.agents, bucketCount) &&
    validTrend(value.trend.models, bucketCount) &&
    rows(
      value.unreported,
      tokenUsageInsightLimits.unreportedProviders,
      (row) => shaped(row, 3) && text(row.kindId) && text(row.instanceId) && count(row.dispatchCount),
    )
  );
}

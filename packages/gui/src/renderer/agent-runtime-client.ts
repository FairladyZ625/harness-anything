import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
  AgentRuntimeSessionGroupsResult,
  AgentRuntimeSessionGroupStatus,
  AgentRuntimeSessionResult,
} from "@harness-anything/daemon/protocol";
import type {
  AgentRuntimeTokenUsageDetailResult,
  AgentRuntimeTokenUsageMemberIdentity,
  AgentRuntimeTokenUsageRange,
  AgentRuntimeTokenUsageResult,
} from "@harness-anything/daemon/protocol";
import type { DaemonGuiReadPayloadMap } from "@harness-anything/daemon/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import { readUseCaseProjection } from "./use-case-projection-client.ts";
import { invoke } from "./api-client-invoke.ts";
import { drainCursorPages } from "./paginated-read.ts";
import {
  applyLifecycleEventsToSession,
  applyLifecycleEventsToSessionGroups,
  sessionEventTimeline,
  type SessionEventTimeline,
  type SessionLifecycleEvent,
} from "./sessions-model.ts";

type RepoScope = { readonly repoId: string };
/** Keep each runtime overview reply below Fleet's single-frame budget. */
const RUNTIME_OVERVIEW_PAGE_LIMIT = 16;
/** The `runtime-session-groups` projection selector: grouping, range and text query are daemon-side. */
export type SessionGroupsQuery = {
  readonly groupBy?: "task" | "squad" | "agent" | "day";
  readonly since?: string;
  readonly query?: string;
  /** 精确归属过滤(G12 §4b):按派工行 agentId/squadId 精确匹配,不走子串。 */
  readonly agentId?: string;
  readonly squadId?: string;
  /** 状态维度筛选:成员级,与 groupBy/since/query 同一条读的入参,不是第二个读。 */
  readonly status?: readonly AgentRuntimeSessionGroupStatus[];
  readonly sessionIds?: readonly string[];
  readonly limit?: number;
};
/**
 * One query key per daemon read, shared by every view that shows it (task detail, sessions page,
 * runtime workspace): the same dispatch list or runtime overview was fetched under three
 * different keys, so react-query could neither dedupe the requests nor invalidate them together.
 * The sessions-page read families live here too, so the ledger cut fan-out (task-data.ts)
 * invalidates exactly the keys the mounted hooks observe.
 */
export const runtimeQueryKeys = {
  dispatchesAll: (repoId: string) => ["dispatches", repoId] as const,
  dispatches: (repoId: string, taskId: string) => ["dispatches", repoId, taskId] as const,
  overviewAll: (repoId: string) => ["runtime-overview", repoId] as const,
  overview: (repoId: string, taskId: string) => ["runtime-overview", repoId, taskId] as const,
  sessionAll: (repoId: string) => ["runtime-session", repoId] as const,
  session: (repoId: string, runtimeSessionId: string) => ["runtime-session", repoId, runtimeSessionId] as const,
  /** 一个会话一条增量事件流键:所有视图共享,增量合并只写这一处。 */
  events: (repoId: string, runtimeSessionId: string) => ["runtime-session-events", repoId, runtimeSessionId] as const,
  sessionGroupsAll: (repoId: string) => ["session-groups", repoId] as const,
  squadRunsAll: (repoId: string) => ["squad-runs", repoId] as const,
  squadRunDetailAll: (repoId: string) => ["squad-run-detail", repoId] as const,
  relatedDispatchesAll: (repoId: string) => ["related-dispatches", repoId] as const,
  tokenUsageAll: (repoId: string) => ["runtime-token-usage", repoId] as const,
  tokenUsage: (repoId: string, range: AgentRuntimeTokenUsageRange) => ["runtime-token-usage", repoId, range] as const,
  tokenUsageDetailAll: (repoId: string) => ["runtime-token-usage-detail", repoId] as const,
  tokenUsageDetail: (
    repoId: string,
    member: AgentRuntimeTokenUsageMemberIdentity,
    range: AgentRuntimeTokenUsageRange,
  ) => ["runtime-token-usage-detail", repoId, member.kind, memberIdOf(member), range] as const,
};

export const agentRuntimeClient = {
  overview: async (
    repoId: string,
    taskId?: string,
    page?: { readonly limit: number; readonly cursor?: string },
  ): Promise<AgentRuntimeOverviewResult> => {
    const readPage = async (facets: { readonly limit?: number; readonly cursor?: string }) =>
      checked(
        await invoke(
          "repo.agentRuntime.overview",
          {
            repoId,
            ...(taskId ? { taskId } : {}),
            ...facets,
          } as DaemonGuiReadPayloadMap["repo.agentRuntime.overview"] & RepoScope,
          "getAgentRuntimeOverview",
        ),
        "installations",
      ) as AgentRuntimeOverviewResult;
    if (page !== undefined) return readPage(page);

    // Unpaged reads keep the daemon's historical default of live sessions only, but their single
    // Fleet frame grows with every active session and eventually exceeds the protocol's 98,304 B
    // limit. Drain the existing cursor API in bounded replies; scoped history reads keep all rows.
    const [first, ...rest] = await drainCursorPages(
        (facets) => readPage({ limit: RUNTIME_OVERVIEW_PAGE_LIMIT, ...facets }),
        "agent runtime overview",
      ),
      pages = [first, ...rest],
      sessions = new Map<string, AgentRuntimeOverviewResult["sessions"][number]>(),
      installations = new Map<string, AgentRuntimeOverviewResult["installations"][number]>(),
      instances = new Map<string, AgentRuntimeOverviewResult["instances"][number]>();
    for (const result of pages) {
      for (const session of result.sessions)
        if (taskId !== undefined || session.liveness !== "exited") sessions.set(session.runtimeSessionId, session);
      for (const installation of result.installations) installations.set(installation.installationId, installation);
      for (const instance of result.instances) instances.set(instance.instanceId, instance);
    }
    return {
      ok: true,
      status: pages.some((result) => result.status === "pending") ? "pending" : "ready",
      installations: [...installations.values()],
      instances: [...instances.values()],
      sessions: [...sessions.values()],
      watermark: Math.min(...pages.map((result) => result.watermark)),
      sourceRevision: Math.min(...pages.map((result) => result.sourceRevision)),
    };
  },
  sessionGroups: async (repoId: string, query: SessionGroupsQuery = {}): Promise<AgentRuntimeSessionGroupsResult> =>
    checkedSessionGroups(
      await readUseCaseProjection({ repoId, name: "runtime-session-groups", ...query }),
    ) as AgentRuntimeSessionGroupsResult,
  session: async (repoId: string, runtimeSessionId: string): Promise<AgentRuntimeSessionResult> =>
    checked(
      await invoke(
        "repo.agentRuntime.sessions.read",
        {
          repoId,
          runtimeSessionId,
        } as DaemonGuiReadPayloadMap["repo.agentRuntime.sessions.read"] & RepoScope,
        "getAgentRuntimeSession",
      ),
      "session",
    ) as AgentRuntimeSessionResult,
  events: async (
    repoId: string,
    runtimeSessionId: string,
    afterCursor = "lifecycle:0",
  ): Promise<AgentRuntimeEventsResult> =>
    checked(
      await invoke(
        "repo.agentRuntime.events.read",
        {
          repoId,
          runtimeSessionId,
          afterCursor,
        } as DaemonGuiReadPayloadMap["repo.agentRuntime.events.read"] & RepoScope,
        "getAgentRuntimeEvents",
      ),
      "events",
    ) as AgentRuntimeEventsResult,
  tokenUsage: async (
    repoId: string,
    range: AgentRuntimeTokenUsageRange = "today",
  ): Promise<AgentRuntimeTokenUsageResult> =>
    checked(
      await invoke(
        "repo.agentRuntime.tokenUsage",
        {
          repoId,
          range,
        } as DaemonGuiReadPayloadMap["repo.agentRuntime.tokenUsage"] & RepoScope,
        "getAgentRuntimeTokenUsage",
      ),
      "agents",
    ) as AgentRuntimeTokenUsageResult,
  tokenUsageDetail: async (
    repoId: string,
    member: AgentRuntimeTokenUsageMemberIdentity,
    range: AgentRuntimeTokenUsageRange = "today",
  ): Promise<AgentRuntimeTokenUsageDetailResult> =>
    checked(
      await invoke(
        "repo.agentRuntime.tokenUsageDetail",
        {
          repoId,
          range,
          ...(member.kind === "agent" ? { agentId: member.agentId } : { squadId: member.squadId }),
        } as DaemonGuiReadPayloadMap["repo.agentRuntime.tokenUsageDetail"] & RepoScope,
        "getAgentRuntimeTokenUsageDetail",
      ),
      "sessions",
    ) as AgentRuntimeTokenUsageDetailResult,
};
function memberIdOf(member: AgentRuntimeTokenUsageMemberIdentity): string {
  return member.kind === "agent" ? member.agentId : member.squadId;
}
function checked(value: unknown, field: string): Record<string, unknown> {
  if (!isRendererRecord(value) || value.ok !== true || !Object.hasOwn(value, field))
    throw new Error(rendererErrorHint(value, "Agent runtime bridge returned an invalid result."));
  return value;
}
function checkedSessionGroups(value: unknown): Record<string, unknown> {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    !Array.isArray(value.groups) ||
    !isRendererRecord(value.totals) ||
    typeof value.truncated !== "boolean"
  )
    throw new Error(rendererErrorHint(value, "Agent runtime session groups bridge returned an invalid result."));
  return value;
}

// ---- 响应式增量事件流(dec_C0AF8CBBFFECF71F4F34FB76F9/CH3) ----
// daemon 读面没有推送通道,「响应式」落地为:按游标只取新事件,纯合并写回 React Query
// 缓存,并就地补丁依赖该会话的读缓存——不 invalidate 整表,列表不整表重刷、不跳动。
// 本文件不自建定时器:重复节拍由消费方的 useQuery refetchInterval 持有(仓库既有口径,
// 见 agent-runtime-renderer 的 no-polling-path 门),queryFn 直接用 pollSessionEventsOnce。

/** cursor 的序数部分(lifecycle:<workspaceRevision>),用于事件排序与去重。 */
function lifecycleRevision(cursor: string): number {
  const revision = /^lifecycle:(\d+)$/u.exec(cursor)?.[1];
  return revision === undefined ? -1 : Number(revision);
}

/**
 * 事件页的纯合并:按 cursor 去重、按 revision 升序;游标元数据以新页为准(它描述更新的
 * 投影切面)。重复投递/乱序到达都不产生重复事件。
 */
export function mergeAgentRuntimeEventPages(
  previous: AgentRuntimeEventsResult | undefined,
  next: AgentRuntimeEventsResult,
): AgentRuntimeEventsResult {
  if (previous === undefined || previous.runtimeSessionId !== next.runtimeSessionId)
    return { ...next, events: [...next.events] };
  const byCursor = new Map(previous.events.map((event) => [event.cursor, event]));
  for (const event of next.events) byCursor.set(event.cursor, event);
  const events = [...byCursor.values()].sort(
    (left, right) => lifecycleRevision(left.cursor) - lifecycleRevision(right.cursor),
  );
  return { ...next, events };
}

/**
 * 单轮增量同步:从缓存游标起只取新事件,合并进 events 键,并就地补丁 session /
 * overview / session-groups 缓存。游标与事件都无变化时不动缓存(引用不变,不触发重渲)。
 */
export async function pollSessionEventsOnce(
  queryClient: QueryClient,
  repoId: string,
  runtimeSessionId: string,
): Promise<AgentRuntimeEventsResult> {
  const key = runtimeQueryKeys.events(repoId, runtimeSessionId),
    cached = queryClient.getQueryData<AgentRuntimeEventsResult>(key),
    page = await agentRuntimeClient.events(repoId, runtimeSessionId, cached?.cursor ?? "lifecycle:0");
  if (cached !== undefined && page.cursor === cached.cursor && page.events.length === 0) return cached;
  const merged = mergeAgentRuntimeEventPages(cached, page);
  queryClient.setQueryData(key, merged);
  patchSessionCaches(queryClient, repoId, page.events);
  return merged;
}

/** 就地补丁依赖该会话的读缓存:只改命中对象,未命中的缓存保持原引用。 */
function patchSessionCaches(queryClient: QueryClient, repoId: string, events: readonly SessionLifecycleEvent[]): void {
  if (events.length === 0) return;
  const sessionKey = runtimeQueryKeys.session(repoId, events[0]!.runtimeSessionId),
    cachedSession = queryClient.getQueryData<AgentRuntimeSessionResult>(sessionKey);
  if (cachedSession !== undefined)
    queryClient.setQueryData(sessionKey, {
      ...cachedSession,
      session: applyLifecycleEventsToSession(cachedSession.session, events),
    });
  const overviewAllKey = runtimeQueryKeys.overviewAll(repoId),
    cachedOverview = queryClient.getQueryData<AgentRuntimeOverviewResult>(overviewAllKey);
  if (cachedOverview !== undefined) {
    const sessions = applyLifecycleEventsToSessionList(cachedOverview.sessions, events);
    if (sessions !== cachedOverview.sessions) queryClient.setQueryData(overviewAllKey, { ...cachedOverview, sessions });
    for (const taskId of taskIdsOfPatchedSessions(cachedOverview.sessions, events))
      patchTaskOverview(queryClient, repoId, taskId, events);
  }
  const groupsKey = runtimeQueryKeys.sessionGroupsAll(repoId),
    cachedGroups = queryClient.getQueryData<AgentRuntimeSessionGroupsResult>(groupsKey);
  if (cachedGroups !== undefined) {
    const groups = applyLifecycleEventsToSessionGroups(cachedGroups.groups, events);
    if (groups !== cachedGroups.groups) queryClient.setQueryData(groupsKey, { ...cachedGroups, groups });
  }
}

function applyLifecycleEventsToSessionList(
  sessions: AgentRuntimeOverviewResult["sessions"],
  events: readonly SessionLifecycleEvent[],
): AgentRuntimeOverviewResult["sessions"] {
  let changed = false;
  const next = sessions.map((session) => {
    const patched = applyLifecycleEventsToSession(session, events);
    changed ||= patched !== session;
    return patched;
  });
  return changed ? next : sessions;
}

function taskIdsOfPatchedSessions(
  sessions: AgentRuntimeOverviewResult["sessions"],
  events: readonly SessionLifecycleEvent[],
): readonly string[] {
  const touched = new Set(events.map((event) => event.runtimeSessionId)),
    taskIds = new Set<string>();
  for (const session of sessions)
    if (touched.has(session.runtimeSessionId))
      for (const association of session.associations) taskIds.add(association.taskId);
  return [...taskIds];
}

function patchTaskOverview(
  queryClient: QueryClient,
  repoId: string,
  taskId: string,
  events: readonly SessionLifecycleEvent[],
): void {
  const key = runtimeQueryKeys.overview(repoId, taskId),
    cached = queryClient.getQueryData<AgentRuntimeOverviewResult>(key);
  if (cached === undefined) return;
  const sessions = applyLifecycleEventsToSessionList(cached.sessions, events);
  if (sessions !== cached.sessions) queryClient.setQueryData(key, { ...cached, sessions });
}

/** 从缓存中的增量事件流读注意力时间线(无缓存返回空时间线,不虚构)。 */
export function cachedSessionEventTimeline(
  queryClient: QueryClient,
  repoId: string,
  runtimeSessionId: string,
): SessionEventTimeline {
  const cached = queryClient.getQueryData<AgentRuntimeEventsResult>(runtimeQueryKeys.events(repoId, runtimeSessionId));
  return sessionEventTimeline(cached?.events ?? []);
}

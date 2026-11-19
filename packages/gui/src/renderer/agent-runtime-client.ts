import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
  AgentRuntimeSessionGroupMembersResult,
  AgentRuntimeSessionGroupsResult,
  AgentRuntimeSessionGroupStatus,
  AgentRuntimeSessionResult,
  AgentRuntimeUnattributedGroupKey,
} from "@harness-anything/daemon/protocol";
import type {
  AgentRuntimeTokenUsageDetailResult,
  AgentRuntimeTokenUsageMemberIdentity,
  AgentRuntimeTokenUsageRange,
  AgentRuntimeTokenUsageResult,
} from "@harness-anything/daemon/protocol";
import type { DaemonGuiReadPayloadMap } from "@harness-anything/daemon/protocol";
import {
  applyRuntimeStreamSignal,
  emptyRuntimeStreamSnapshot,
  runtimeStreamFrames,
  type AgentRuntimeStreamValue,
  type RuntimeStreamSnapshot,
} from "@harness-anything/daemon/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import { readUseCaseProjection } from "./use-case-projection-client.ts";
import { invoke } from "./api-client-invoke.ts";
import { guiTransport } from "./gui-transport.ts";
import { sessionEventTimeline, type SessionEventTimeline } from "./sessions-model.ts";

type RepoScope = { readonly repoId: string };
/** The `runtime-session-groups` projection selector: grouping, range and text query are daemon-side. */
export type SessionGroupsQuery = {
  readonly groupBy?: "task" | "squad" | "agent" | "day";
  readonly since?: string;
  readonly query?: string;
  /** 精确归属过滤(G12 §4b):按派工行 agentId/squadId 精确匹配,不走子串。 */
  readonly agentId?: string;
  readonly squadId?: string;
  readonly personId?: string;
  readonly nodeId?: string;
  /** 状态维度筛选:成员级,与 groupBy/since/query 同一条读的入参,不是第二个读。 */
  readonly status?: readonly AgentRuntimeSessionGroupStatus[];
  readonly sessionIds?: readonly string[];
  readonly limit?: number;
};
export type SessionGroupMembersQuery = {
  readonly groupKey: AgentRuntimeUnattributedGroupKey;
  readonly groupBy?: "task" | "squad" | "agent" | "day";
  readonly since?: string;
  readonly query?: string;
  readonly agentId?: string;
  readonly squadId?: string;
  readonly personId?: string;
  readonly nodeId?: string;
  readonly status?: readonly AgentRuntimeSessionGroupStatus[];
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
  eventsAll: (repoId: string) => ["runtime-session-events", repoId] as const,
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
    scope?: Pick<DaemonGuiReadPayloadMap["repo.agentRuntime.overview"], "scopePersonId" | "filterNodeId">,
  ): Promise<AgentRuntimeOverviewResult> => {
    const readPage = async (facets: { readonly limit?: number; readonly cursor?: string }) =>
      checked(
        await invoke("repo.agentRuntime.overview", {
          repoId,
          ...(taskId ? { taskId } : {}),
          ...facets,
          ...scope,
        } as DaemonGuiReadPayloadMap["repo.agentRuntime.overview"] & RepoScope),
        "installations",
      ) as AgentRuntimeOverviewResult;
    if (page !== undefined) return readPage(page);

    return readPage({});
  },
  sessionGroups: async (repoId: string, query: SessionGroupsQuery = {}): Promise<AgentRuntimeSessionGroupsResult> =>
    checkedSessionGroups(
      await readUseCaseProjection({ repoId, name: "runtime-session-groups", ...query }),
    ) as AgentRuntimeSessionGroupsResult,
  sessionGroupMembers: async (
    repoId: string,
    query: SessionGroupMembersQuery,
  ): Promise<AgentRuntimeSessionGroupMembersResult> =>
    checkedSessionGroupMembers(
      await readUseCaseProjection({ repoId, name: "runtime-session-groups", facet: "members", ...query }),
    ) as AgentRuntimeSessionGroupMembersResult,
  session: async (repoId: string, runtimeSessionId: string): Promise<AgentRuntimeSessionResult> =>
    checked(
      await invoke("repo.agentRuntime.sessions.read", {
        repoId,
        runtimeSessionId,
      } as DaemonGuiReadPayloadMap["repo.agentRuntime.sessions.read"] & RepoScope),
      "session",
    ) as AgentRuntimeSessionResult,
  events: async (
    repoId: string,
    runtimeSessionId: string,
    afterCursor = "lifecycle:0",
  ): Promise<AgentRuntimeEventsResult> =>
    checked(
      await invoke("repo.agentRuntime.events.read", {
        repoId,
        runtimeSessionId,
        afterCursor,
      } as DaemonGuiReadPayloadMap["repo.agentRuntime.events.read"] & RepoScope),
      "events",
    ) as AgentRuntimeEventsResult,
  tokenUsage: async (
    repoId: string,
    range: AgentRuntimeTokenUsageRange = "today",
  ): Promise<AgentRuntimeTokenUsageResult> =>
    checked(
      await invoke("repo.agentRuntime.tokenUsage", {
        repoId,
        range,
      } as DaemonGuiReadPayloadMap["repo.agentRuntime.tokenUsage"] & RepoScope),
      "agents",
    ) as AgentRuntimeTokenUsageResult,
  tokenUsageDetail: async (
    repoId: string,
    member: AgentRuntimeTokenUsageMemberIdentity,
    range: AgentRuntimeTokenUsageRange = "today",
  ): Promise<AgentRuntimeTokenUsageDetailResult> =>
    checked(
      await invoke("repo.agentRuntime.tokenUsageDetail", {
        repoId,
        range,
        ...(member.kind === "agent" ? { agentId: member.agentId } : { squadId: member.squadId }),
      } as DaemonGuiReadPayloadMap["repo.agentRuntime.tokenUsageDetail"] & RepoScope),
      "sessions",
    ) as AgentRuntimeTokenUsageDetailResult,
  collaboratorTokenUsage: async (
    repoId: string,
    query: DaemonGuiReadPayloadMap["repo.agentRuntime.tokenUsage"] & { readonly groupBy: "person" | "node" },
  ) => {
    const result = await invoke("repo.agentRuntime.tokenUsage", { repoId, ...query });
    if (!result || !("groupBy" in result) || result.groupBy !== query.groupBy)
      throw new Error("Token usage bridge returned an invalid attribution result.");
    return result;
  },
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
function checkedSessionGroupMembers(value: unknown): Record<string, unknown> {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    !Array.isArray(value.dispatches) ||
    !Array.isArray(value.sessions)
  )
    throw new Error(rendererErrorHint(value, "Agent runtime session group members bridge returned an invalid result."));
  return value;
}

/** Native activity comes from the stream. Lifecycle and transcript remain indexed reads. */
export function useSessionEventWakeup(
  repoId: string,
  runtimeSessionId: string | null,
  showNativeActivity = false,
): RuntimeStreamSnapshot["activity"] {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<{
    repoId: string;
    runtimeSessionId: string;
    activity: RuntimeStreamSnapshot["activity"];
  } | null>(null);
  useEffect(() => {
    if (showNativeActivity) setValue(null);
    if (!runtimeSessionId) return;
    const transport = guiTransport();
    if (transport.capabilities().stream?.status !== "available") return;
    const queryKey = runtimeQueryKeys.events(repoId, runtimeSessionId);
    let snapshot = emptyRuntimeStreamSnapshot;
    return transport.subscribe(
      "repo.agentRuntime.attach",
      { repo: { repoId }, payload: { runtimeSessionId } },
      (value) => {
        if (!isRendererRecord(value)) return;
        const frames = runtimeStreamFrames(value as AgentRuntimeStreamValue);
        if (frames.length === 0) return;
        if (showNativeActivity) {
          const priorActivity = snapshot.activity;
          for (const frame of frames) snapshot = applyRuntimeStreamSignal(snapshot, frame, frame.occurredAt);
          if (snapshot.activity !== priorActivity) setValue({ repoId, runtimeSessionId, activity: snapshot.activity });
        }
        void queryClient.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
      },
      (error) => console.warn("Runtime event stream lost", error),
    );
  }, [repoId, queryClient, runtimeSessionId, showNativeActivity]);
  return value?.repoId === repoId && value.runtimeSessionId === runtimeSessionId ? value.activity : null;
}

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
  if (page.events.length > 0)
    await Promise.all(
      [
        runtimeQueryKeys.sessionAll(repoId),
        runtimeQueryKeys.overviewAll(repoId),
        runtimeQueryKeys.sessionGroupsAll(repoId),
        runtimeQueryKeys.dispatchesAll(repoId),
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  return merged;
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

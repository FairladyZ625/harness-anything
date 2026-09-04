import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
  AgentRuntimeSessionGroupsResult,
  AgentRuntimeSessionGroupStatus,
  AgentRuntimeSessionResult,
} from "../../../daemon/src/agent-runtime-contract.ts";
import type { DaemonGuiReadPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import { readUseCaseProjection } from "./use-case-projection-client.ts";

type RuntimeBridge = {
  readonly getAgentRuntimeOverview: (
    payload: DaemonGuiReadPayloadMap["repo.agentRuntime.overview"],
  ) => Promise<unknown>;
  readonly getAgentRuntimeSession: (
    payload: DaemonGuiReadPayloadMap["repo.agentRuntime.sessions.read"],
  ) => Promise<unknown>;
  readonly getAgentRuntimeEvents: (
    payload: DaemonGuiReadPayloadMap["repo.agentRuntime.events.read"],
  ) => Promise<unknown>;
};
type RepoScope = { readonly repoId: string };
const bridge = (): RuntimeBridge => {
  const value = window.harness as unknown as Partial<RuntimeBridge> | undefined;
  if (!value?.getAgentRuntimeOverview || !value.getAgentRuntimeSession || !value.getAgentRuntimeEvents)
    throw new Error("Agent runtime contract bridge is unavailable.");
  return value as RuntimeBridge;
};
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
  readonly limit?: number;
};
/**
 * One query key per daemon read, shared by every view that shows it (task detail, sessions page,
 * runtime workspace): the same dispatch list or runtime overview was fetched under three
 * different keys, so react-query could neither dedupe the requests nor invalidate them together.
 */
export const runtimeQueryKeys = {
  dispatchesAll: (repoId: string) => ["dispatches", repoId] as const,
  dispatches: (repoId: string, taskId: string) => ["dispatches", repoId, taskId] as const,
  overviewAll: (repoId: string) => ["runtime-overview", repoId] as const,
  overview: (repoId: string, taskId: string) => ["runtime-overview", repoId, taskId] as const,
  sessionAll: (repoId: string) => ["runtime-session", repoId] as const,
  session: (repoId: string, runtimeSessionId: string) => ["runtime-session", repoId, runtimeSessionId] as const,
};

export const agentRuntimeClient = {
  overview: async (
    repoId: string,
    taskId?: string,
    page?: { readonly limit: number; readonly cursor?: string },
  ): Promise<AgentRuntimeOverviewResult> =>
    checked(
      await bridge().getAgentRuntimeOverview({
        repoId,
        ...(taskId ? { taskId } : {}),
        ...page,
      } as DaemonGuiReadPayloadMap["repo.agentRuntime.overview"] & RepoScope),
      "installations",
    ) as AgentRuntimeOverviewResult,
  sessionGroups: async (repoId: string, query: SessionGroupsQuery = {}): Promise<AgentRuntimeSessionGroupsResult> =>
    checkedSessionGroups(
      await readUseCaseProjection({ repoId, name: "runtime-session-groups", ...query }),
    ) as AgentRuntimeSessionGroupsResult,
  session: async (repoId: string, runtimeSessionId: string): Promise<AgentRuntimeSessionResult> =>
    checked(
      await bridge().getAgentRuntimeSession({
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
      await bridge().getAgentRuntimeEvents({
        repoId,
        runtimeSessionId,
        afterCursor,
      } as DaemonGuiReadPayloadMap["repo.agentRuntime.events.read"] & RepoScope),
      "events",
    ) as AgentRuntimeEventsResult,
};
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

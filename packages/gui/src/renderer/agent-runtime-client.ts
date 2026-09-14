import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
  AgentRuntimeSessionGroupsResult,
  AgentRuntimeSessionGroupStatus,
  AgentRuntimeSessionResult,
} from "../../../daemon/src/agent-runtime-contract.ts";
import type { AgentRuntimeTokenUsageResult } from "../../../daemon/src/agent-runtime-token-usage.ts";
import type { DaemonGuiReadPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import { readUseCaseProjection } from "./use-case-projection-client.ts";
import { invoke } from "./api-client-invoke.ts";

type RepoScope = { readonly repoId: string };
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
  sessionGroupsAll: (repoId: string) => ["session-groups", repoId] as const,
  squadRunsAll: (repoId: string) => ["squad-runs", repoId] as const,
  squadRunDetailAll: (repoId: string) => ["squad-run-detail", repoId] as const,
  relatedDispatchesAll: (repoId: string) => ["related-dispatches", repoId] as const,
  tokenUsageAll: (repoId: string) => ["runtime-token-usage", repoId] as const,
};

export const agentRuntimeClient = {
  overview: async (
    repoId: string,
    taskId?: string,
    page?: { readonly limit: number; readonly cursor?: string },
  ): Promise<AgentRuntimeOverviewResult> =>
    checked(
      await invoke(
        "repo.agentRuntime.overview",
        {
          repoId,
          ...(taskId ? { taskId } : {}),
          ...page,
        } as DaemonGuiReadPayloadMap["repo.agentRuntime.overview"] & RepoScope,
        "getAgentRuntimeOverview",
      ),
      "installations",
    ) as AgentRuntimeOverviewResult,
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
  tokenUsage: async (repoId: string): Promise<AgentRuntimeTokenUsageResult> =>
    checked(
      await invoke(
        "repo.agentRuntime.tokenUsage",
        {
          repoId,
        } as DaemonGuiReadPayloadMap["repo.agentRuntime.tokenUsage"] & RepoScope,
        "getAgentRuntimeTokenUsage",
      ),
      "agents",
    ) as AgentRuntimeTokenUsageResult,
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

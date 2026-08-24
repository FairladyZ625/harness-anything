import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
  AgentRuntimeSessionResult,
} from "../../../daemon/src/agent-runtime-contract.ts";
import type { AgentRuntimeAttachEvent, AgentRuntimeAttachResult } from "../../../daemon/src/agent-runtime-stream.ts";
import type {
  DaemonGuiReadPayloadMap,
  DaemonGuiStreamPayloadMap,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

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
  readonly attachAgentRuntime: (
    payload: DaemonGuiStreamPayloadMap["repo.agentRuntime.attach"],
    onValue: (value: unknown) => void,
  ) => () => void;
};
type RepoScope = { readonly repoId: string };
const bridge = (): RuntimeBridge => {
  const value = window.harness as unknown as Partial<RuntimeBridge> | undefined;
  if (
    !value?.getAgentRuntimeOverview ||
    !value.getAgentRuntimeSession ||
    !value.getAgentRuntimeEvents ||
    !value.attachAgentRuntime
  )
    throw new Error("Agent runtime contract bridge is unavailable.");
  return value as RuntimeBridge;
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
  attach: (
    repoId: string,
    runtimeSessionId: string,
    afterCursor: string,
    onValue: (value: AgentRuntimeAttachResult | AgentRuntimeAttachEvent) => void,
  ): (() => void) =>
    bridge().attachAgentRuntime(
      { repoId, runtimeSessionId, afterCursor } as DaemonGuiStreamPayloadMap["repo.agentRuntime.attach"] & RepoScope,
      (value) => {
        if (!isRendererRecord(value)) throw new Error("Agent runtime stream returned an invalid value.");
        onValue(value as unknown as AgentRuntimeAttachResult | AgentRuntimeAttachEvent);
      },
    ),
};
export function openAgentRuntimePane(
  repoId: string,
  runtimeSessionId: string,
  afterCursor: string,
  onValue: (value: AgentRuntimeAttachResult | AgentRuntimeAttachEvent) => void,
): { readonly close: () => void } {
  return { close: agentRuntimeClient.attach(repoId, runtimeSessionId, afterCursor, onValue) };
}
function checked(value: unknown, field: string): Record<string, unknown> {
  if (!isRendererRecord(value) || value.ok !== true || !Object.hasOwn(value, field))
    throw new Error(rendererErrorHint(value, "Agent runtime bridge returned an invalid result."));
  return value;
}

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AgentRuntimeStatusResult,
  AgentRuntimeProfilesResult,
  AgentRuntimeEventsResult,
  AgentRuntimeResultResult,
  AgentRuntimeSessionResult,
  AgentRuntimeControlFailure,
  AgentRuntimeSpawnPayload,
  AgentRuntimeSessionStatus,
  AgentRuntimeEventProjection,
  AgentRuntimeAuthProfile,
  AgentRuntimeResultProjection
} from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";

export type AgentRuntimeFailure = AgentRuntimeControlFailure;

const SESSIONS_REFETCH_MS = 2_000;
const EVENTS_REFETCH_MS = 1_500;

type StatusOk = Extract<AgentRuntimeStatusResult, { readonly ok: true }>;
type ProfilesOk = Extract<AgentRuntimeProfilesResult, { readonly ok: true }>;
type EventsOk = Extract<AgentRuntimeEventsResult, { readonly ok: true }>;
type ResultOk = Extract<AgentRuntimeResultResult, { readonly ok: true }>;
type SpawnOk = Extract<AgentRuntimeSessionResult, { readonly ok: true }>;

export function useAgentRuntimeStatusQuery(repoId?: string | null) {
  return useQuery({
    queryKey: ["harness", "agent-runtime", "status", repoId ?? "default"],
    queryFn: async (): Promise<ReadonlyArray<AgentRuntimeSessionStatus>> => {
      const result = await harnessClient.getAgentRuntimeStatus(repoId ?? undefined);
      if (!result.ok) throw new Error(result.error.hint);
      return (result as StatusOk).sessions;
    },
    refetchInterval: SESSIONS_REFETCH_MS,
    staleTime: SESSIONS_REFETCH_MS
  });
}

export function useAgentRuntimeProfilesQuery(repoId?: string | null) {
  return useQuery({
    queryKey: ["harness", "agent-runtime", "profiles", repoId ?? "default"],
    queryFn: async (): Promise<ReadonlyArray<AgentRuntimeAuthProfile>> => {
      const result = await harnessClient.getAgentRuntimeProfiles(repoId ?? undefined);
      if (!result.ok) throw new Error(result.error.hint);
      return (result as ProfilesOk).profiles;
    },
    staleTime: 15_000
  });
}

export function useAgentRuntimeEventsQuery(
  runtimeSessionId: string | null,
  repoId?: string | null,
  cursor = 0
) {
  return useQuery({
    queryKey: ["harness", "agent-runtime", "events", repoId ?? "default", runtimeSessionId, cursor],
    queryKeyHashFn: (key) => JSON.stringify(key),
    queryFn: async (): Promise<{ readonly events: ReadonlyArray<AgentRuntimeEventProjection>; readonly nextCursor: number }> => {
      if (!runtimeSessionId) return { events: [], nextCursor: cursor };
      const result = await harnessClient.getAgentRuntimeEvents({ runtimeSessionId, cursor, ...(repoId ? { repoId } : {}) });
      if (!result.ok) throw new Error(result.error.hint);
      const ok = result as EventsOk;
      return { events: ok.events, nextCursor: ok.nextCursor };
    },
    enabled: runtimeSessionId !== null,
    refetchInterval: EVENTS_REFETCH_MS,
    staleTime: EVENTS_REFETCH_MS
  });
}

export function useAgentRuntimeResultQuery(
  runtimeSessionId: string | null,
  repoId?: string | null
) {
  return useQuery({
    queryKey: ["harness", "agent-runtime", "result", repoId ?? "default", runtimeSessionId],
    queryFn: async (): Promise<AgentRuntimeResultProjection | null> => {
      if (!runtimeSessionId) return null;
      const result = await harnessClient.getAgentRuntimeResult({ runtimeSessionId, ...(repoId ? { repoId } : {}) });
      if (!result.ok) throw new Error(result.error.hint);
      return (result as ResultOk).result;
    },
    enabled: runtimeSessionId !== null,
    staleTime: 5_000
  });
}

export function useSpawnAgentRuntimeMutation(repoId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: AgentRuntimeSpawnPayload): Promise<Extract<AgentRuntimeSessionResult, { readonly ok: true }>["session"]> => {
      const result = await harnessClient.spawnAgentRuntime({ ...payload, ...(repoId ? { repoId } : {}) });
      if (!result.ok) throw new Error(result.error.hint);
      return (result as SpawnOk).session;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["harness", "agent-runtime", "status"] });
    }
  });
}

export interface AgentRuntimeCredentialInput {
  readonly kindId: "claude-code" | "codex";
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export function useWriteAgentRuntimeCredentialsMutation() {
  return useMutation({
    mutationFn: async (payload: AgentRuntimeCredentialInput): Promise<{ readonly path: string }> => {
      const result = await harnessClient.writeAgentRuntimeCredentials(payload);
      if (!result.ok) throw new Error(result.error.hint);
      return { path: result.path };
    }
  });
}

export type { AgentRuntimeSessionStatus, AgentRuntimeEventProjection, AgentRuntimeResultProjection, AgentRuntimeAuthProfile };

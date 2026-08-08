/**
 * Agent Runtime bridge client — extracted from `api-client.ts` so that file
 * stays under the file-complexity cap. Holds the agent-runtime payload/result
 * types, the agent-runtime bridge methods, and their result readers.
 * `api-client.ts` composes `createAgentRuntimeClient(invokeBridge)` into
 * `harnessClient`.
 *
 * The credential writer (`writeAgentRuntimeCredentials`) is a standalone IPC
 * channel (not a daemon JSON-RPC route), so it is consumed via
 * `window.harness.writeAgentRuntimeCredentials` directly.
 */
import type {
  AgentRuntimeProfilesResult,
  AgentRuntimeSessionResult,
  AgentRuntimeStatusResult,
  AgentRuntimeEventsResult,
  AgentRuntimeResultResult,
  AgentRuntimeSpawnPayload,
  AgentRuntimeControlFailure
} from "../api/renderer-dto.ts";
import { t } from "./i18n/core.ts";
import type { RepoScopedPayload } from "./repo-scope.ts";
import { withRepoId } from "./repo-scope.ts";

type AgentRuntimeBridgeMethod =
  | "getAgentRuntimeProfiles"
  | "getAgentRuntimeStatus"
  | "getAgentRuntimeEvents"
  | "getAgentRuntimeResult"
  | "spawnAgentRuntime";

/**
 * Narrowed invoke signature accepted by the agent-runtime client. `api-client`'s
 * `invokeBridge` (typed over the full bridge-method union, a superset) is
 * assignable here by parameter contravariance once the agent-runtime methods
 * are included in that union.
 */
type BridgeInvoker = (method: AgentRuntimeBridgeMethod, payload: object | null) => Promise<unknown>;
type CredentialsWriter = (payload: {
  readonly kindId: "claude-code" | "codex";
  readonly apiKey: string;
  readonly baseUrl?: string;
}) => Promise<
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } }
>;

export interface AgentRuntimeClient {
  readonly getAgentRuntimeProfiles: (repoId?: string) => Promise<AgentRuntimeProfilesResult | AgentRuntimeControlFailure>;
  readonly getAgentRuntimeStatus: (repoId?: string) => Promise<AgentRuntimeStatusResult | AgentRuntimeControlFailure>;
  readonly getAgentRuntimeEvents: (payload: { readonly runtimeSessionId: string; readonly cursor?: number } & RepoScopedPayload) => Promise<AgentRuntimeEventsResult | AgentRuntimeControlFailure>;
  readonly getAgentRuntimeResult: (payload: { readonly runtimeSessionId: string } & RepoScopedPayload) => Promise<AgentRuntimeResultResult | AgentRuntimeControlFailure>;
  readonly spawnAgentRuntime: (payload: AgentRuntimeSpawnPayload & RepoScopedPayload) => Promise<AgentRuntimeSessionResult | AgentRuntimeControlFailure>;
  readonly writeAgentRuntimeCredentials: (payload: {
    readonly kindId: "claude-code" | "codex";
    readonly apiKey: string;
    readonly baseUrl?: string;
  }) => Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } }>;
}

function isAgentRuntimeOk(value: unknown): value is { readonly ok: true } {
  return value !== null && typeof value === "object" && (value as { ok?: unknown }).ok === true;
}

function agentRuntimeFailure(value: unknown): AgentRuntimeControlFailure {
  if (value && typeof value === "object" && (value as { ok?: unknown }).ok === false) {
    const error = (value as { error?: { code?: unknown; hint?: unknown } }).error;
    return {
      ok: false,
      error: {
        code: typeof error?.code === "string" ? error.code : "agent_runtime_error",
        hint: typeof error?.hint === "string" ? error.hint : t("renderer.apiClient.agentRuntimeRequestFailed")
      }
    };
  }
  return { ok: false, error: { code: "invalid_bridge_result", hint: t("renderer.apiClient.agentRuntimeRequestFailed") } };
}

export function createAgentRuntimeClient(invoke: BridgeInvoker, credentialsWriter?: CredentialsWriter): AgentRuntimeClient {
  return {
    getAgentRuntimeProfiles: async (repoId) => {
      const result = await invoke("getAgentRuntimeProfiles", withRepoId(null, repoId));
      return isAgentRuntimeOk(result) ? (result as AgentRuntimeProfilesResult) : agentRuntimeFailure(result);
    },
    getAgentRuntimeStatus: async (repoId) => {
      const result = await invoke("getAgentRuntimeStatus", withRepoId(null, repoId));
      return isAgentRuntimeOk(result) ? (result as AgentRuntimeStatusResult) : agentRuntimeFailure(result);
    },
    getAgentRuntimeEvents: async (payload) => {
      const result = await invoke("getAgentRuntimeEvents", payload);
      return isAgentRuntimeOk(result) ? (result as AgentRuntimeEventsResult) : agentRuntimeFailure(result);
    },
    getAgentRuntimeResult: async (payload) => {
      const result = await invoke("getAgentRuntimeResult", payload);
      return isAgentRuntimeOk(result) ? (result as AgentRuntimeResultResult) : agentRuntimeFailure(result);
    },
    spawnAgentRuntime: async (payload) => {
      const result = await invoke("spawnAgentRuntime", payload);
      return isAgentRuntimeOk(result) ? (result as AgentRuntimeSessionResult) : agentRuntimeFailure(result);
    },
    writeAgentRuntimeCredentials: async (payload) => {
      if (typeof credentialsWriter !== "function") {
        return { ok: false, error: { code: "credential_writer_unavailable", hint: "Credential writer is unavailable in this build." } };
      }
      return credentialsWriter(payload);
    }
  };
}

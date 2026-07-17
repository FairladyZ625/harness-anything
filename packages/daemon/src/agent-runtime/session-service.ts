import type {
  AgentRuntimeControlFailure,
  AgentRuntimeControlService,
  AgentRuntimeEventProjection,
  AgentRuntimeSessionStatus,
  AgentRuntimeSpawnPayload,
  RuntimeAuthenticationProfileProjection
} from "../../../application/src/agent-runtime-control.ts";
import type { RuntimeCapabilityMatrix } from "../../../application/src/agent-runtime-adapter.ts";
import { realpathSync } from "node:fs";
import path from "node:path";

export type RuntimeAdapterProcessEvent =
  | { readonly kind: "provider-session"; readonly providerSessionId: string }
  | { readonly kind: "heartbeat" }
  | { readonly kind: "completed" }
  | { readonly kind: "failed" }
  | { readonly kind: "exit"; readonly exitCode: number | null };

export interface RuntimeAdapterProcess {
  readonly pid: number;
  readonly onEvent: (listener: (event: RuntimeAdapterProcessEvent) => void) => void;
  readonly close: () => void;
}

export interface RuntimeProtocolAdapter {
  readonly kindId: "claude-code" | "codex";
  readonly capabilities: RuntimeCapabilityMatrix;
  readonly spawn: (payload: AgentRuntimeSpawnPayload) => Promise<RuntimeAdapterProcess>;
  readonly attach?: (runtimeSessionId: string) => boolean;
}

export interface StoredRuntimeSession extends AgentRuntimeSessionStatus {
  readonly resultState: "running" | "completed" | "failed" | "unknown";
  readonly events: ReadonlyArray<AgentRuntimeEventProjection>;
}

export interface RuntimeSessionStore {
  readonly load: () => Promise<ReadonlyArray<StoredRuntimeSession>>;
  readonly save: (sessions: ReadonlyArray<StoredRuntimeSession>) => Promise<void>;
}

export interface AgentRuntimeSessionServiceOptions {
  readonly adapters: ReadonlyArray<RuntimeProtocolAdapter>;
  readonly store: RuntimeSessionStore;
  readonly authProfiles: () => Promise<ReadonlyArray<RuntimeAuthenticationProfileProjection>>;
  readonly createId?: () => string;
  readonly now?: () => string;
  readonly workspaceRoot?: string;
}

export function createAgentRuntimeSessionService(
  options: AgentRuntimeSessionServiceOptions
): AgentRuntimeControlService {
  const adapters = new Map(options.adapters.map((adapter) => [adapter.kindId, adapter]));
  const handles = new Map<string, RuntimeAdapterProcess>();
  const sessions = new Map<string, StoredRuntimeSession>();
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? (() => `runtime_${crypto.randomUUID()}`);
  const ready = options.store.load().then((storedSessions) => {
    for (const stored of storedSessions) sessions.set(stored.runtimeSessionId, restartProjection(stored));
  });

  const persist = () => options.store.save([...sessions.values()]);
  const failure = (code: string, hint: string): AgentRuntimeControlFailure => ({ ok: false, error: { code, hint } });
  const find = (runtimeSessionId: string) => sessions.get(runtimeSessionId);

  return {
    profiles: async () => {
      await ready;
      return { ok: true, schema: "agent-runtime-auth-profiles/v1", profiles: await options.authProfiles() };
    },
    spawn: async (payload) => {
      await ready;
      if (options.workspaceRoot && !isWithinWorkspace(options.workspaceRoot, payload.cwd)) {
        return failure("runtime_cwd_outside_workspace", "Runtime cwd must be the repository root or a directory inside it.");
      }
      const adapter = adapters.get(payload.kindId);
      if (!adapter) return failure("runtime_adapter_unavailable", `No adapter is registered for ${payload.kindId}.`);
      const neededCapability = payload.resumeProviderSessionId ? "resume" : "spawn";
      if (!adapter.capabilities[neededCapability]) {
        return failure("runtime_capability_unsupported", `${payload.kindId} does not support ${neededCapability}.`);
      }
      const profiles = await options.authProfiles();
      const profile = profiles.find((candidate) =>
        candidate.kindId === payload.kindId && candidate.profileKind === payload.authenticationProfileKind
      );
      if (!profile || profile.state !== "configured") {
        return failure("runtime_authentication_required", profile?.guidance ?? `Configure ${payload.authenticationProfileKind} for ${payload.kindId}.`);
      }
      let handle: RuntimeAdapterProcess;
      try {
        handle = await adapter.spawn(payload);
      } catch (error) {
        return failure("runtime_spawn_failed", error instanceof Error ? error.message : String(error));
      }
      const runtimeSessionId = createId();
      const startedAt = now();
      const session: StoredRuntimeSession = {
        runtimeSessionId,
        kindId: payload.kindId,
        process: { state: "alive", pid: handle.pid, startedAt, heartbeatAt: startedAt },
        attachable: adapter.capabilities.attach,
        capabilities: adapter.capabilities,
        ...(payload.resumeProviderSessionId ? { providerSessionId: payload.resumeProviderSessionId } : {}),
        ...((payload.taskId || payload.executionId) ? {
          clientBinding: {
            assertion: "client-asserted" as const,
            ...(payload.taskId ? { taskId: payload.taskId } : {}),
            ...(payload.executionId ? { executionId: payload.executionId } : {})
          }
        } : {}),
        resultState: "running",
        events: []
      };
      sessions.set(runtimeSessionId, session);
      handles.set(runtimeSessionId, handle);
      handle.onEvent((event) => { void applyProcessEvent(runtimeSessionId, event, sessions, handles, now, persist); });
      await persist();
      return { ok: true, session: publicSession(session) };
    },
    attach: async ({ runtimeSessionId }) => {
      await ready;
      const session = find(runtimeSessionId);
      if (!session) return failure("runtime_session_not_found", `Runtime session not found: ${runtimeSessionId}`);
      const adapter = adapters.get(session.kindId as "claude-code" | "codex");
      const handle = handles.get(runtimeSessionId);
      if (session.process.state !== "alive" || !handle || !adapter?.capabilities.attach) {
        return failure("runtime_attach_channel_unavailable", "Attach requires a daemon-owned live channel; resume starts a separate process.");
      }
      if (adapter.attach && !adapter.attach(runtimeSessionId)) {
        return failure("runtime_attach_channel_unavailable", "The adapter no longer owns the live channel.");
      }
      return { ok: true, session: publicSession(session) };
    },
    status: async (payload = {}) => {
      await ready;
      const selected = payload.runtimeSessionId ? [find(payload.runtimeSessionId)].filter(isStoredSession) : [...sessions.values()];
      if (payload.runtimeSessionId && selected.length === 0) {
        return failure("runtime_session_not_found", `Runtime session not found: ${payload.runtimeSessionId}`);
      }
      return { ok: true, schema: "agent-runtime-session-status/v1", sessions: selected.map(publicSession) };
    },
    events: async ({ runtimeSessionId, cursor = 0 }) => {
      await ready;
      const session = find(runtimeSessionId);
      if (!session) return failure("runtime_session_not_found", `Runtime session not found: ${runtimeSessionId}`);
      const events = session.events.filter((event) => event.sequence > cursor);
      return { ok: true, events, nextCursor: events.at(-1)?.sequence ?? cursor };
    },
    result: async ({ runtimeSessionId }) => {
      await ready;
      const session = find(runtimeSessionId);
      if (!session) return failure("runtime_session_not_found", `Runtime session not found: ${runtimeSessionId}`);
      return {
        ok: true,
        result: {
          runtimeSessionId,
          state: session.resultState,
          ...(session.process.exitCode !== undefined ? { exitCode: session.process.exitCode } : {})
        }
      };
    }
  };
}

async function applyProcessEvent(
  runtimeSessionId: string,
  event: RuntimeAdapterProcessEvent,
  sessions: Map<string, StoredRuntimeSession>,
  handles: Map<string, RuntimeAdapterProcess>,
  now: () => string,
  persist: () => Promise<void>
): Promise<void> {
  const session = sessions.get(runtimeSessionId);
  if (!session) return;
  const observedAt = now();
  const projection: AgentRuntimeEventProjection = {
    sequence: (session.events.at(-1)?.sequence ?? 0) + 1,
    kind: event.kind,
    observedAt
  };
  let next: StoredRuntimeSession = { ...session, events: [...session.events, projection] };
  if (event.kind === "provider-session") next = { ...next, providerSessionId: event.providerSessionId };
  if (event.kind === "heartbeat") next = { ...next, process: { ...next.process, state: "alive", heartbeatAt: observedAt } };
  if (event.kind === "completed") next = { ...next, resultState: "completed" };
  if (event.kind === "failed") next = { ...next, resultState: "failed" };
  if (event.kind === "exit") {
    handles.delete(runtimeSessionId);
    next = {
      ...next,
      attachable: false,
      resultState: next.resultState === "running" ? (event.exitCode === 0 ? "completed" : "failed") : next.resultState,
      process: { ...next.process, state: "exited", exitedAt: observedAt, exitCode: event.exitCode }
    };
  }
  sessions.set(runtimeSessionId, next);
  await persist();
}

function restartProjection(session: StoredRuntimeSession): StoredRuntimeSession {
  return session.process.state === "alive"
    ? { ...session, attachable: false, process: { ...session.process, state: "unknown" }, resultState: "unknown" }
    : { ...session, attachable: false };
}

function publicSession(session: StoredRuntimeSession): AgentRuntimeSessionStatus {
  const { resultState: _resultState, events: _events, ...projection } = session;
  return projection;
}

function isStoredSession(value: StoredRuntimeSession | undefined): value is StoredRuntimeSession {
  return value !== undefined;
}

function isWithinWorkspace(workspaceRoot: string, cwd: string): boolean {
  try {
    const root = realpathSync(path.resolve(workspaceRoot));
    const candidate = realpathSync(path.resolve(cwd));
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

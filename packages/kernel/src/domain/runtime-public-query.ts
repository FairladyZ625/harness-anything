import { normalizePersistedTimestamp } from "./timestamp.ts";
import {
  agentRuntimeEventTypes,
  type AgentRuntimeEventType,
  type AgentRuntimeEventV1,
  type RuntimeInstallation,
  type RuntimeSession,
} from "./agent-runtime.ts";

/** Binding and installation observations are control metadata; public activity uses their projected rows. */
export const privateRuntimeEventTypes = [
  "runtime_installation_observed",
  "runtime_session_provider_bound",
  "runtime_session_task_bound",
  "runtime_squad_run_observed",
] as const;

/** Validate a runtime event type filter before it becomes SQL; empty or unknown filters fail closed. */
export function assertRuntimeEventTypes(types: readonly AgentRuntimeEventType[]): readonly AgentRuntimeEventType[] {
  if (!Array.isArray(types) || types.length === 0)
    throw new Error("runtime session event type filter requires at least one type");
  for (const type of types)
    if (!agentRuntimeEventTypes.includes(type)) throw new Error(`unknown runtime event type: ${String(type)}`);
  return types;
}

export function publicRuntimeDispatch<T extends Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>>(
  event: T,
): T {
  const { cwd: _cwd, ...payload } = event.payload as T["payload"] & { readonly idempotencyKey?: string };
  const dispatchKey = payload.dispatchKey ?? payload.idempotencyKey;
  if (dispatchKey === undefined) return { ...event, payload };
  const { idempotencyKey: _idempotencyKey, ...current } = payload;
  return { ...event, payload: { ...current, dispatchKey } } as T;
}

export function publicRuntimeSession(session: RuntimeSession): RuntimeSession {
  return {
    ...session,
    transcriptRef: null,
    attachable: false,
    taskBindings: session.taskBindings.map((binding) => ({ ...binding, transcriptRef: null })),
  };
}

export function publicRuntimeInstallation(installation: RuntimeInstallation): Omit<RuntimeInstallation, "hostRef"> {
  const { hostRef: _hostRef, ...publicFields } = installation;
  return publicFields;
}

export function runtimeDispatchPageTimeKey(value: string): number {
  // An empty lower bound is the existing unbounded dispatch-page request.
  if (value === "") return Number.MIN_SAFE_INTEGER;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid dispatch page timestamp");
  return milliseconds;
}

export function runtimeDispatchPageKey(event: Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>) {
  const startedAt = event.payload.startedAt ?? event.occurredAt;
  return {
    startedAt: normalizePersistedTimestamp(startedAt) ?? startedAt,
    dispatchId: event.payload.dispatchId,
  };
}

export function compareRuntimeDispatchPageKeys(
  left: ReturnType<typeof runtimeDispatchPageKey>,
  right: ReturnType<typeof runtimeDispatchPageKey>,
): number {
  const time = runtimeDispatchPageTimeKey(left.startedAt) - runtimeDispatchPageTimeKey(right.startedAt);
  if (time !== 0) return time;
  // SQLite BINARY and PostgreSQL C order the dispatch ID's encoded bytes.
  return Buffer.compare(Buffer.from(left.dispatchId), Buffer.from(right.dispatchId));
}

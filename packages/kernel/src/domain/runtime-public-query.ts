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

export function runtimeDispatchPageTimeKey(value: string): string {
  return normalizePersistedTimestamp(value) ?? value;
}

export function runtimeDispatchPageKey(event: Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>) {
  return {
    startedAt: runtimeDispatchPageTimeKey(event.payload.startedAt ?? event.occurredAt),
    dispatchId: event.payload.dispatchId,
  };
}

export function compareRuntimeDispatchPageKeys(
  left: ReturnType<typeof runtimeDispatchPageKey>,
  right: ReturnType<typeof runtimeDispatchPageKey>,
): number {
  if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? -1 : 1;
  // SQLite BINARY and PostgreSQL C order the dispatch ID's encoded bytes.
  return Buffer.compare(Buffer.from(left.dispatchId), Buffer.from(right.dispatchId));
}

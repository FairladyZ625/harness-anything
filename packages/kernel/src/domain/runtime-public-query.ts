import type { AgentRuntimeEventV1, RuntimeInstallation, RuntimeSession } from "./agent-runtime.ts";

/** Binding and installation observations are control metadata; public activity uses their projected rows. */
export const privateRuntimeEventTypes = [
  "runtime_installation_observed",
  "runtime_session_provider_bound",
  "runtime_session_task_bound",
  "runtime_squad_run_observed",
] as const;

export function publicRuntimeDispatch<T extends Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>>(
  event: T,
): T {
  const { cwd: _cwd, ...payload } = event.payload;
  return { ...event, payload };
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

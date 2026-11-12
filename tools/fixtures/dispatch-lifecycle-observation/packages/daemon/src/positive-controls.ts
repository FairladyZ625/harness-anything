declare function runtimePidIsAlive(pid: number): boolean;
declare function submitLifecycleEvent(event: Readonly<Record<string, unknown>>): unknown;

export function admissionFromPid(summary: { readonly pid: number }): boolean {
  if (!runtimePidIsAlive(summary.pid)) return false;
  return true;
}

export function terminalFromProcessLost(summary: { readonly process_lost: boolean }) {
  return { terminal: summary.process_lost };
}

export function observeProcess(summary: { readonly pid: number; readonly runtimeSessionId: string }) {
  return submitLifecycleEvent({
    type: "runtime_session_liveness_changed",
    payload: {
      runtimeSessionId: summary.runtimeSessionId,
      liveness: runtimePidIsAlive(summary.pid) ? "live" : "unknown",
    },
  });
}

export function capacityFromLocalTables(
  processes: ReadonlyMap<string, unknown>,
  session: { readonly runtimeSessionId: string; readonly liveness: string; readonly fallbackState: string | null },
): boolean {
  if (processes.has(session.runtimeSessionId)) return true;
  if (session.fallbackState === "scheduled") return false;
  return session.liveness === "live";
}

export function adoptionFromProcessTable(
  processes: ReadonlyMap<string, unknown>,
  session: { readonly runtimeSessionId: string },
) {
  return processes.has(session.runtimeSessionId);
}

export function rulingFromPhase(group: { readonly groupPhase: string }): boolean {
  return group.groupPhase === "awaiting_ruling";
}

export function rulingFromPolicy(group: { readonly policy: { readonly canResolveRuling: boolean } }): boolean {
  return group.policy.canResolveRuling;
}

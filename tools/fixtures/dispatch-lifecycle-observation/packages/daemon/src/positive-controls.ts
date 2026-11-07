declare function runtimePidIsAlive(pid: number): boolean;
declare function submitLifecycleEvent(event: Readonly<Record<string, unknown>>): unknown;

export function admissionFromPid(summary: { readonly pid: number }): boolean {
  if (!runtimePidIsAlive(summary.pid)) return false;
  return true;
}

export function terminalFromProcessLost(summary: { readonly process_lost: boolean }) {
  return { terminal: summary.process_lost };
}

export function observeProcess(summary: { readonly pid: number }) {
  return submitLifecycleEvent({
    type: "process_observed",
    processAlive: runtimePidIsAlive(summary.pid),
  });
}

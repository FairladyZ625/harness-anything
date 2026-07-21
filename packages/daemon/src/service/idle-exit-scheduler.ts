export function createDaemonIdleExitScheduler(input: {
  readonly idleMs: number;
  readonly isStopping: () => boolean;
  readonly activeConnections: () => number;
  readonly hasActiveWork: () => boolean;
  readonly requestIdleStop: () => void;
}): { readonly schedule: () => void; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (input.idleMs <= 0 || input.isStopping() || input.activeConnections() !== 0) return;
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      if (input.hasActiveWork()) {
        schedule();
        return;
      }
      input.requestIdleStop();
    }, input.idleMs);
    timer.unref();
  };
  return { schedule, cancel };
}

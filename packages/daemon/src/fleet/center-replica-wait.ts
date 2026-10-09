import { FleetFault } from "./center-types.ts";
import type { ReplicaCutSource, SnapshotCut } from "./replica-cut-store.ts";

// A watch that sees no new cut still answers on the progress interval with the unchanged head, so a
// connected edge can keep confirming freshness without pulling (the same role as etcd's progress notify).
export const headAfterOrProgress = async (
  replica: ReplicaCutSource,
  afterRevision: number,
  progressMs: number,
  signal: AbortSignal,
): Promise<SnapshotCut> => {
  const waiting = new AbortController();
  const stop = AbortSignal.any([signal, waiting.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      replica.waitForCut(afterRevision + 1, stop),
      new Promise<SnapshotCut>((resolve) => {
        timer = setTimeout(() => resolve(replica.latest()!), progressMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    waiting.abort();
  }
};
// The wait starts only once the session is known to be open: a wait started during shutdown would be
// rejected by the closing cut source with nobody left to observe it.
export const untilAborted = <T>(start: () => Promise<T>, stop: AbortSignal): Promise<T> => {
  if (stop.aborted) return Promise.reject(new FleetFault("busy", "The replica session closed.", true));
  const pending = start();
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        stop.reason instanceof FleetFault ? stop.reason : new FleetFault("busy", "The replica session closed.", true),
      );
    stop.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        stop.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        stop.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

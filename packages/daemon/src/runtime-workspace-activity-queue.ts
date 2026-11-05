/** Keep at most one pending writer admission while retaining the latest observed progress. */
export function createWorkspaceActivityQueue(
  schedule: (work: () => void | Promise<void>) => void,
  progress: (observedAtMs: number) => void | Promise<void>,
): (observedAtMs: number) => void {
  let queued = false,
    latest: number | null = null;
  return (observedAtMs) => {
    latest = Math.max(latest ?? -Infinity, observedAtMs);
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      const current = latest;
      latest = null;
      if (current !== null) return progress(current);
    });
  };
}

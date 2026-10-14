import { consumeKnownError } from "@harness-anything/kernel";
import { runFleetReplicaStream, type FleetReplicaStreamOptions } from "./peer.ts";
import { readReplicaGeneration } from "./replica-generation.ts";
export interface ReplicaSyncOptions extends Omit<FleetReplicaStreamOptions, "onApplied"> {
  readonly signal?: AbortSignal;
  /** Runs after the replica applied new commits; overlapping notifications coalesce into one rerun. */
  readonly onConfirmed?: () => void | Promise<void>;
  readonly onFailure?: (error: unknown) => void;
}
type Waiter = { readonly sequence: number; readonly resolve: () => void; readonly reject: (error: unknown) => void };
const waiters = new Map<string, Set<Waiter>>();
const syncKey = (options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">): string =>
  `${options.viewRoot}\u0000${options.repoId}\u0000${options.nodeId}`;
const notify = (key: string, sequence: number): void => {
  const pending = waiters.get(key);
  if (!pending) return;
  for (const waiter of [...pending])
    if (sequence >= waiter.sequence) {
      pending.delete(waiter);
      waiter.resolve();
    }
  if (pending.size === 0) waiters.delete(key);
};
/** Write-then-read: resolves once the resident stream applied the center commit sequence of a write. */
export function waitForFleetReplicaSequence(
  options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">,
  sequence: number,
  signal?: AbortSignal,
): Promise<void> {
  const current = readReplicaGeneration(`${options.viewRoot}/repos/${options.repoId}/views/${options.nodeId}`);
  if (current && current.metadata.position.sequence >= sequence) return Promise.resolve();
  const key = syncKey(options);
  return new Promise<void>((resolve, reject) => {
    const pending = waiters.get(key) ?? new Set<Waiter>();
    const waiter: Waiter = {
      sequence,
      resolve: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      reject,
    };
    const onAbort = () => {
      pending.delete(waiter);
      reject(signal?.reason ?? new Error("replica wait aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.add(waiter);
    waiters.set(key, pending);
  });
}
/** One long-lived stream per node and repository; it reconnects with backoff only after a failure. */
export async function runFleetReplicaSync(options: ReplicaSyncOptions): Promise<void> {
  const key = syncKey(options);
  let failures = 0,
    confirming = false,
    confirmAgain = false;
  const confirm = (): void => {
    if (confirming) {
      confirmAgain = true;
      return;
    }
    confirming = true;
    void (async () => {
      do {
        confirmAgain = false;
        try {
          await options.onConfirmed?.();
        } catch (error) {
          consumeKnownError(error);
          options.onFailure?.(error);
        }
      } while (confirmAgain && !options.signal?.aborted);
      confirming = false;
    })();
  };
  while (!options.signal?.aborted) {
    try {
      await runFleetReplicaStream({
        ...options,
        onApplied: (position) => {
          failures = 0;
          notify(key, position.sequence);
          confirm();
        },
      });
    } catch (error) {
      // The stream only ends by failing; the failure is reported, then the loop reconnects.
      consumeKnownError(error);
      if (options.signal?.aborted) return;
      options.onFailure?.(error);
    }
    const ceiling = Math.min(30_000, 250 * 2 ** Math.min(failures++, 7));
    const delay = Math.floor(Math.random() * (ceiling + 1));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay),
        onAbort = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

import { runFleetReplicaPullClient, type FleetReplicaPullClientOptions } from "./peer.ts";
import { readReplicaGeneration } from "./replica-generation.ts";
export interface ReplicaSyncOptions extends FleetReplicaPullClientOptions {
  readonly signal?: AbortSignal;
  readonly onConfirmed?: (revision: number) => void | Promise<void>;
  readonly onFailure?: (error: unknown) => void;
}
type Waiter = { readonly revision: number; readonly resolve: () => void; readonly reject: (error: unknown) => void };
const waiters = new Map<string, Set<Waiter>>();
const syncKey = (options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">): string =>
  `${options.viewRoot}\u0000${options.repoId}\u0000${options.nodeId}`;
const notify = (key: string, revision: number): void => {
  const pending = waiters.get(key);
  if (!pending) return;
  for (const waiter of [...pending])
    if (revision >= waiter.revision) {
      pending.delete(waiter);
      waiter.resolve();
    }
  if (pending.size === 0) waiters.delete(key);
};
export function waitForFleetReplicaSequence(
  options: Pick<ReplicaSyncOptions, "viewRoot" | "repoId" | "nodeId">,
  revision: number,
  signal?: AbortSignal,
): Promise<void> {
  const current = readReplicaGeneration(`${options.viewRoot}/repos/${options.repoId}/views/${options.nodeId}`);
  if (current && current.metadata.position.revision >= revision) return Promise.resolve();
  const key = syncKey(options);
  return new Promise<void>((resolve, reject) => {
    const pending = waiters.get(key) ?? new Set<Waiter>();
    const waiter: Waiter = {
      revision,
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
export async function runFleetReplicaSync(options: ReplicaSyncOptions): Promise<void> {
  while (!options.signal?.aborted) {
    const attempt = await runFleetReplicaPullClient({ ...options, stopAfterAck: true }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (attempt.ok) {
      const result = attempt.value;
      const revision = result.current.cut.revision;
      notify(syncKey(options), revision);
      await options.onConfirmed?.(revision);
      continue;
    }
    if (options.signal?.aborted) return;
    options.onFailure?.(attempt.error);
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      setImmediate(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }
}

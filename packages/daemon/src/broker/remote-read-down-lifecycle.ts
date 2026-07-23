import type { ReplicaChangeRecord } from "@harness-anything/application";
import type { PersistentSshAuthorityClient } from "../transport/persistent-ssh-authority-client.ts";
import type { RemoteReadDownSessionHealth } from "./remote-read-down-contract.ts";
import { asRemoteReadDownError } from "./remote-read-down-failure.ts";

export function registerRemoteReadDownListeners(
  client: PersistentSshAuthorityClient,
  onNotification: (change: ReplicaChangeRecord) => void,
  onDisconnect: () => void
): { readonly removeNotification: () => void; readonly removeDisconnect: () => void } {
  const removeNotification = client.onNotification(onNotification);
  try {
    return { removeNotification, removeDisconnect: client.onDisconnect(onDisconnect) };
  } catch (error) {
    removeNotification();
    throw error;
  }
}

export async function closeAndJoinRemoteReadDown(
  client: PersistentSshAuthorityClient,
  pending: () => ReadonlyArray<Promise<unknown>>
): Promise<void> {
  const closeResult = await Promise.allSettled([
    Promise.resolve().then(() => client.close())
  ]);
  for (;;) {
    const operations = pending();
    if (operations.length === 0) break;
    await Promise.allSettled(operations);
  }
  const outcome = closeResult[0]!;
  if (outcome.status === "rejected") throw outcome.reason;
}

export function removeRemoteReadDownListeners(
  removals: ReadonlyArray<() => void>,
  onDiagnostic: ((text: string) => void) | undefined
): void {
  for (const remove of removals) {
    try {
      remove();
    } catch (error) {
      onDiagnostic?.(
        `remote read-down listener cleanup failed: ${asRemoteReadDownError(error).message}`
      );
    }
  }
}

export function deriveRemoteReadDownSessionHealth(input: {
  readonly terminal: Error | undefined;
  readonly stopped: boolean;
  readonly active: boolean;
  readonly recovering: boolean;
}): RemoteReadDownSessionHealth {
  if (input.terminal) return { status: "TERMINAL", failure: input.terminal };
  if (input.stopped) return { status: "CLOSED" };
  if (input.active) return { status: "READY" };
  return { status: input.recovering ? "RECOVERING" : "IDLE" };
}

export function publishRemoteReadDownTerminal(
  current: Error | undefined,
  error: unknown,
  onTerminal: ((failure: Error) => void) | undefined,
  onDiagnostic: ((text: string) => void) | undefined
): Error {
  if (current) return current;
  const failure = asRemoteReadDownError(error);
  try {
    onTerminal?.(failure);
  } catch (callbackError) {
    onDiagnostic?.(
      `remote read-down terminal observer failed: ${asRemoteReadDownError(callbackError).message}`
    );
  }
  return failure;
}

export function notifyRemoteReadDownListeners(
  listeners: ReadonlySet<(change: ReplicaChangeRecord) => void>,
  change: ReplicaChangeRecord,
  onDiagnostic: ((text: string) => void) | undefined
): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (error) {
      onDiagnostic?.(
        `remote read-down notification listener failed: ${asRemoteReadDownError(error).message}`
      );
    }
  }
}

export function trackRemoteReadDownOperation<Value>(
  operations: Set<Promise<unknown>>,
  operation: () => Promise<Value>
): Promise<Value> {
  const task = operation();
  operations.add(task);
  void task.then(
    () => operations.delete(task),
    () => operations.delete(task)
  );
  return task;
}

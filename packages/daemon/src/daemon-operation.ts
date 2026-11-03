import { AsyncLocalStorage } from "node:async_hooks";
import { fleetBaseBackupTrace } from "@harness-anything/storage";
import type { JsonRpcRequest } from "./protocol/json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export interface DaemonOperation {
  readonly id: string;
  readonly method: string;
  readonly repoId: string | null;
  readonly actor: string | null;
  readonly startedAt: string;
  readonly phase: string;
}
export type DaemonOperationUpdate = Partial<Pick<DaemonOperation, "phase" | "actor" | "repoId">>;
export interface DaemonOperationObserver {
  readonly begin: (fields: Pick<DaemonOperation, "method"> & DaemonOperationUpdate) => {
    readonly update: (fields: DaemonOperationUpdate) => void;
    readonly end: () => void;
  };
}
const current = new AsyncLocalStorage<{
  readonly observer: DaemonOperationObserver;
  readonly operation?: ReturnType<DaemonOperationObserver["begin"]>;
}>();
const backups = new WeakMap<object, ReturnType<DaemonOperationObserver["begin"]>>();
fleetBaseBackupTrace.start.subscribe((message) => {
  const span = message as { repoId: string | null },
    observer = current.getStore()?.observer;
  if (observer)
    backups.set(
      span,
      observer.begin({ method: "fleet.basebackup", repoId: span.repoId, actor: "daemon", phase: "snapshot" }),
    );
});
fleetBaseBackupTrace.asyncStart.subscribe((message) => {
  const span = message as { repoId: string | null };
  backups.get(span)?.update({ repoId: span.repoId, phase: "archive" });
});
fleetBaseBackupTrace.end.subscribe((message) => {
  const span = message as object;
  backups.get(span)?.end();
  backups.delete(span);
});

/** Bind at the daemon composition root. Async resources inherit the observer, never a global daemon. */
export function withDaemonObservation<T>(observer: DaemonOperationObserver, body: () => T): T {
  return current.run({ observer }, body);
}

/** O(1) incremental registration; synchronous bodies remain synchronous. Always removes on settlement. */
export function observeDaemonOperation<T>(
  fields: Pick<DaemonOperation, "method"> & DaemonOperationUpdate,
  body: () => T,
): T {
  const context = current.getStore();
  if (!context) return body();
  const operation = context.observer.begin(fields);
  return current.run({ observer: context.observer, operation }, () => {
    try {
      const result = body();
      if (result instanceof Promise) return result.finally(operation.end) as T;
      operation.end();
      return result;
    } catch (error) {
      operation.end();
      throw error;
    }
  });
}

/** Single phase port for request tracing (including synchronous reads); no payloads or credentials. */
export function markDaemonOperationPhase(phase: string): void {
  updateDaemonOperation({ phase });
}
export function updateDaemonOperation(fields: DaemonOperationUpdate): void {
  current.getStore()?.operation?.update(fields);
}

export function observeDaemonRequest<T>(request: JsonRpcRequest, auth: DaemonAuthenticationContext, body: () => T): T {
  const params = request.params as Record<string, unknown> | undefined,
    repo = params?.repo as { repoId?: unknown } | undefined;
  return observeDaemonOperation(
    {
      method: String(request.method),
      phase: "authentication",
      repoId:
        typeof repo?.repoId === "string" ? repo.repoId : typeof params?.repoId === "string" ? params.repoId : null,
      actor:
        auth.executionPrincipal?.personId ??
        auth.oidcPrincipal?.personId ??
        auth.nodePrincipal?.personId ??
        (auth.unixSocketOwnerBoundary ? `local-user-${auth.unixSocketOwnerBoundary.ownerUid}` : null),
    },
    body,
  );
}

// @slice-activation PLT-Boundary W2 exports daemon-owned registry reconciliation to the service host.
import type { DaemonRegistryRepo } from "@harness-anything/kernel";

export interface DaemonReconcileError {
  readonly at: string;
  readonly code: "registry_reconcile_failed" | "repo_reconcile_failed";
  readonly message: string;
  readonly repoId: string | null;
}

export interface DaemonReconcileState {
  lastReconcileAt: string | null;
  lastReconcileError: DaemonReconcileError | null;
  readonly repoErrors: Map<string, DaemonReconcileError>;
}

export interface DaemonRepoReconcileStatus {
  readonly state: string;
  readonly lastError?: string;
}

export interface DaemonRepoReconcileAdapter {
  readonly loadDesiredRepos: () => ReadonlyArray<DaemonRegistryRepo>;
  readonly knownRepoIds: () => ReadonlyArray<string>;
  readonly repoStatus: (repoId: string) => DaemonRepoReconcileStatus | undefined;
  readonly attachRepo: (repo: DaemonRegistryRepo) => Promise<DaemonRepoReconcileStatus>;
  readonly bindRepo: (repo: DaemonRegistryRepo) => void | Promise<void>;
  readonly detachRepo: (repoId: string) => Promise<void>;
  readonly removeRepo: (repoId: string) => void;
  readonly now?: () => Date;
}

export function createDaemonReconcileState(): DaemonReconcileState {
  return {
    lastReconcileAt: null,
    lastReconcileError: null,
    repoErrors: new Map()
  };
}

export async function reconcileDaemonRepoRegistry(
  adapter: DaemonRepoReconcileAdapter,
  state: DaemonReconcileState
): Promise<void> {
  const at = (adapter.now ?? (() => new Date()))().toISOString();
  let desiredRepos: ReadonlyArray<DaemonRegistryRepo>;
  try {
    desiredRepos = adapter.loadDesiredRepos();
  } catch (error) {
    state.lastReconcileAt = at;
    state.lastReconcileError = reconcileError(at, null, "registry", error);
    return;
  }

  const failures: DaemonReconcileError[] = [];
  const desiredIds = new Set(desiredRepos.map((repo) => repo.repoId));
  try {
    for (const repo of desiredRepos) {
      const previous = adapter.repoStatus(repo.repoId);
      const attachPhase = previous?.state === "unavailable" ? "retry" : "attach";
      let current = previous;
      if (current?.state !== "attached") {
        try {
          current = await adapter.attachRepo(repo);
        } catch (error) {
          failures.push(recordRepoFailure(state, at, repo.repoId, attachPhase, error));
          continue;
        }
      }

      try {
        await adapter.bindRepo(repo);
      } catch (error) {
        failures.push(recordRepoFailure(state, at, repo.repoId, "bind", error));
        continue;
      }

      if (current.state !== "attached") {
        failures.push(recordRepoFailure(
          state,
          at,
          repo.repoId,
          attachPhase,
          current.lastError ?? `repo remains ${current.state}`
        ));
        continue;
      }
      state.repoErrors.delete(repo.repoId);
    }

    for (const repoId of adapter.knownRepoIds()) {
      if (desiredIds.has(repoId)) continue;
      try {
        await adapter.detachRepo(repoId);
        adapter.removeRepo(repoId);
        state.repoErrors.delete(repoId);
      } catch (error) {
        failures.push(recordRepoFailure(state, at, repoId, "detach", error));
      }
    }
  } catch (error) {
    failures.push(reconcileError(at, null, "registry", error));
  }

  state.lastReconcileAt = at;
  state.lastReconcileError = failures.at(-1) ?? null;
}

function recordRepoFailure(
  state: DaemonReconcileState,
  at: string,
  repoId: string,
  phase: "attach" | "bind" | "detach" | "retry",
  error: unknown
): DaemonReconcileError {
  const failure = reconcileError(at, repoId, phase, error);
  state.repoErrors.set(repoId, failure);
  return failure;
}

function reconcileError(
  at: string,
  repoId: string | null,
  phase: "attach" | "bind" | "detach" | "registry" | "retry",
  error: unknown
): DaemonReconcileError {
  return {
    at,
    code: repoId === null ? "registry_reconcile_failed" : "repo_reconcile_failed",
    message: `${phase} failed: ${describeError(error)}`,
    repoId
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return describeError((error as { readonly cause?: unknown }).cause);
  }
  return String(error);
}

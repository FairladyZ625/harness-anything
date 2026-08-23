import { existsSync } from "node:fs";
import {
  consumeKnownError,
  readDaemonRegistry,
  unregisterDaemonRepo,
  type DaemonRepoMode,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "./protocol/daemon-protocol.contract.ts";

export async function closeCell(context: any, repoId: string): Promise<void> {
  const cell = context.cells.get(repoId),
    closing = cell?.close();
  if (closing) await closing;
  context.cells.delete(repoId);
}

// Registry hygiene: a registered root that no longer exists on disk (an OS-cleaned temp
// fixture, a deleted checkout) is retired instead of attach-failing forever. Unregister
// keeps the row as state=disabled so the root can be re-registered later; the lifecycle
// log records exactly what was retired and when it was first registered.
export function pruneMissingRoot(
  context: any,
  repo: {
    readonly repoId: string;
    readonly canonicalRoot: string;
    readonly registeredAt: string;
  },
): boolean {
  if (existsSync(repo.canonicalRoot)) return false;
  try {
    unregisterDaemonRepo(repo.repoId, {
      userRoot: context.input.userRoot,
      createConvenienceLinks: false,
    });
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
  context.settleWarming(repo.repoId);
  context.unavailable.delete(repo.repoId);
  context.input.recordLifecycle?.({
    event: "repo_registry_pruned",
    repoId: repo.repoId,
    rootDir: repo.canonicalRoot,
    registeredAt: repo.registeredAt,
  });
  return true;
}

// A RepoCell open that never settles must not hold startup hostage: every open races a
// per-repo budget. Losing the race latches the repo unavailable and startup moves on; the
// underlying open keeps running, and a late completion heals the latch through
// performOpenRegistered. The dedupe entry survives until the underlying open truly settles so
// a timed-out caller can never trigger a second concurrent open of the same root.
export function openRegistered(
  context: any,
  repo: {
    readonly repoId: string;
    readonly canonicalRoot: string;
    readonly authoredBranch: string;
    readonly mode: DaemonRepoMode;
  },
  progress?: {
    readonly attachIndex: number;
    readonly attachTotal: number;
  },
): Promise<void> {
  const tracked = context.openings.get(repo.repoId) ?? context.performOpenRegistered(repo, progress);
  if (!context.openings.has(repo.repoId)) {
    context.openings.set(repo.repoId, tracked);
    void tracked.then(clearOpening, clearOpening);
  }
  return context.raceAttachBudget(tracked, repo.repoId, progress);
  function clearOpening(): void {
    if (context.openings.get(repo.repoId) === tracked) context.openings.delete(repo.repoId);
  }
}

export function raceAttachBudget(
  context: any,
  opening: Promise<void>,
  repoId: string,
  progress?: {
    readonly attachIndex: number;
    readonly attachTotal: number;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      context.input.recordLifecycle?.({
        event: "repo_attach_timed_out",
        repoId,
        ...(progress ?? {}),
        durationMs: context.attachTimeoutMs,
      });
      reject(context.attachBudgetError(repoId, context.attachTimeoutMs));
    }, context.attachTimeoutMs);
    timer.unref?.();
    opening.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function performOpenRegistered(
  context: any,
  repo: {
    readonly repoId: string;
    readonly canonicalRoot: string;
    readonly authoredBranch: string;
    readonly mode: DaemonRepoMode;
  },
  progress?: {
    readonly attachIndex: number;
    readonly attachTotal: number;
  },
): Promise<void> {
  const started = performance.now(),
    lifecycle = {
      repoId: repo.repoId,
      rootDir: repo.canonicalRoot,
      ...(progress ?? {}),
    };
  context.input.recordLifecycle?.({ event: "repo_attach_started", ...lifecycle });
  try {
    const cell = await context.openCell({
      repoId: workspaceId(repo.repoId),
      rootDir: canonicalRoot(repo.canonicalRoot),
      mode: repo.mode,
      ownerId: context.input.daemonId,
      runtimeDaemonRoute: context.runtimeDaemonRoute,
      authoredBranch: repo.authoredBranch,
      ...(context.input.shutdownRequested ? { shouldStop: context.input.shutdownRequested } : {}),
      ...context.runtimePorts,
      ...(context.input.runtimeLaunch ? { runtimeLaunch: context.input.runtimeLaunch } : {}),
    });
    context.cells.set(repo.repoId, cell);
    context.settleWarming(repo.repoId);
    context.unavailable.delete(repo.repoId);
    context.input.recordLifecycle?.({
      event: "repo_attach_completed",
      ...lifecycle,
      durationMs: performance.now() - started,
    });
  } catch (error) {
    context.input.recordLifecycle?.({
      event: "repo_attach_failed",
      ...lifecycle,
      durationMs: performance.now() - started,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    throw error;
  }
}

export async function refreshRegistry(context: any): Promise<void> {
  const registry = readDaemonRegistry({ userRoot: context.input.userRoot }),
    enabled = new Map(registry.repos.filter((repo) => repo.state === "enabled").map((repo) => [repo.repoId, repo])),
    invalid = new Map(
      registry.invalidRepos
        .filter((repo) => repo.state !== "disabled")
        .map((repo) => [context.invalidRepoId(repo), repo]),
    );
  for (const [repoId, cell] of [...context.cells]) {
    const repo = enabled.get(repoId);
    if (!repo || cell.status().mode !== repo.mode) {
      await context.closeCell(repoId);
      context.unavailable.delete(repoId);
      context.unavailableProbes.delete(repoId);
    }
  }
  for (const repoId of [...context.warming.keys()])
    if (!enabled.has(repoId) && !invalid.has(repoId)) context.settleWarming(repoId);
  for (const repoId of [...context.unavailable.keys()])
    if (!enabled.has(repoId) && !invalid.has(repoId)) {
      context.unavailable.delete(repoId);
      context.unavailableProbes.delete(repoId);
    }
  for (const repo of invalid.values())
    context.latchUnavailable(context.invalidRepoId(repo), context.invalidRegistryStatus(repo));
  for (const repo of enabled.values())
    if (!context.cells.has(repo.repoId)) {
      if (context.pruneMissingRoot(repo)) continue;
      context.markWarming(repo.repoId, context.warmingStatus(repo));
      try {
        await context.openRegistered(repo);
      } catch (error) {
        consumeKnownError(error);
        context.latchUnavailable(
          repo.repoId,
          context.unavailableStatus(repo.repoId, repo.canonicalRoot, repo.mode, error),
        );
      }
    }
}

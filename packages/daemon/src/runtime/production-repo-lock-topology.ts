import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  createHarnessRuntimeContext,
  resolveHarnessLayout,
  type HarnessLayoutOverrides
} from "@harness-anything/kernel";
import { acquireDaemonGlobalLock } from "@harness-anything/kernel/daemon-runtime-support";
import type { RepoWriteProcessSupervisor } from "./repo-write-process-supervisor.ts";

export interface ProductionRepoLockTarget {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

export function prepareProductionRepoLocks(input: {
  readonly repos: ReadonlyArray<ProductionRepoLockTarget>;
  readonly userRoot: string;
  readonly endpoint: string;
  readonly lockTtlMs: number;
  readonly layoutOverrides?: HarnessLayoutOverrides;
}): void {
  const failures: Array<{ readonly repo: ProductionRepoLockTarget; readonly error: unknown }> = [];
  for (const repo of [...input.repos].sort((left, right) => left.repoId.localeCompare(right.repoId))) {
    const runtimeContext = createHarnessRuntimeContext(repo.canonicalRoot, input.layoutOverrides);
    const layout = resolveHarnessLayout(runtimeContext);
    try {
      acquireProductionPreflightLock({
        repo,
        runtimeContext,
        journalPath: layout.journalPath,
        lockTtlMs: input.lockTtlMs,
        userRoot: input.userRoot,
        endpoint: input.endpoint
      });
    } catch (error) {
      failures.push({ repo, error });
    }
  }
  if (failures.length > 0) throw daemonRepoLockSetConflict(input.repos, failures);
}

export async function startProductionRepoWriteSupervisors(input: {
  readonly supervisors: ReadonlyMap<string, RepoWriteProcessSupervisor>;
  readonly repos: ReadonlyArray<ProductionRepoLockTarget>;
  readonly userRoot: string;
  readonly endpoint: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
}): Promise<void> {
  const orderedEntries = [...input.supervisors.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  const [sentinelEntry, ...remainingEntries] = orderedEntries;
  // The first repo is a deterministic topology sentinel. Identical manifests
  // contend here before either daemon can fan out children for other repos.
  if (sentinelEntry) {
    const [repoId, sentinel] = sentinelEntry;
    try {
      await sentinel.start();
    } catch (error) {
      const repo = input.repos.find((candidate) => candidate.repoId === repoId);
      if (!repo || !repoLockOwnedByOtherDaemon(repo, input)) throw error;
      throw daemonRepoLockSetConflict(input.repos, [{ repo, error }]);
    }
  }

  const results = await Promise.allSettled(
    remainingEntries.map(([, supervisor]) => supervisor.start())
  );
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [];
    const repoId = remainingEntries[index]?.[0];
    const repo = input.repos.find((candidate) => candidate.repoId === repoId);
    return repo ? [{ repo, error: result.reason }] : [];
  });
  if (failures.length === 0) return;

  const classified = failures.map((failure) => ({
    ...failure,
    otherDaemonOwnsLock: repoLockOwnedByOtherDaemon(failure.repo, input)
  }));
  const lockFailures = classified
    .filter(({ otherDaemonOwnsLock }) => otherDaemonOwnsLock)
    .map(({ repo, error }) => ({ repo, error }));
  if (lockFailures.length === failures.length) {
    throw daemonRepoLockSetConflict(input.repos, lockFailures);
  }
  const nonLockFailures = classified
    .filter(({ otherDaemonOwnsLock }) => !otherDaemonOwnsLock)
    .map(({ error }) => error);
  if (nonLockFailures.length === 1) throw nonLockFailures[0];
  throw new AggregateError(
    nonLockFailures,
    "one or more repo-write children failed to start for reasons other than lock ownership"
  );
}

function acquireProductionPreflightLock(input: {
  readonly repo: ProductionRepoLockTarget;
  readonly runtimeContext: ReturnType<typeof createHarnessRuntimeContext>;
  readonly journalPath: string;
  readonly lockTtlMs: number;
  readonly userRoot: string;
  readonly endpoint: string;
}): void {
  const deadline = Date.now() + 250;
  while (true) {
    try {
      const lock = acquireDaemonGlobalLock(
        input.repo.canonicalRoot,
        input.runtimeContext,
        input.journalPath,
        { scope: "operational", kind: "system", id: "daemon-startup-lock-preflight" },
        input.lockTtlMs,
        {
          repoId: input.repo.repoId,
          canonicalRoot: input.repo.canonicalRoot,
          userRoot: input.userRoot,
          endpoint: input.endpoint
        }
      );
      lock.release();
      return;
    } catch (error) {
      if (!transientPreflightConflict(error) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function transientPreflightConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("reason" in error)) return false;
  return error.reason === "takeover-in-progress" || error.reason === "lock-record-publishing";
}

function daemonRepoLockSetConflict(
  repos: ReadonlyArray<ProductionRepoLockTarget>,
  failures: ReadonlyArray<{ readonly repo: ProductionRepoLockTarget; readonly error: unknown }>
): Error {
  const repoSet = repos
    .map((repo) => `${repo.repoId}@${repo.canonicalRoot}`)
    .sort()
    .join(", ");
  const conflicts = failures
    .map(({ repo, error }) => `${repo.repoId}@${repo.canonicalRoot}: ${error instanceof Error ? error.message : String(error)}`)
    .join("; ");
  return new Error(
    `DAEMON_REPO_LOCK_SET_CONFLICT: manifest repo set=[${repoSet}]; conflicts=[${conflicts}]. `
    + "One canonicalRoot may belong to only one live daemon; each explicit manifest is the daemon's complete enabled repo set; daemon repo sets must not overlap. "
    + "See docs-release/operations-server-daemon.md#daemon-repository-ownership-invariants."
  );
}

function repoLockOwnedByOtherDaemon(
  repo: ProductionRepoLockTarget,
  input: {
    readonly userRoot: string;
    readonly endpoint: string;
    readonly layoutOverrides?: HarnessLayoutOverrides;
  }
): boolean {
  const layout = resolveHarnessLayout(createHarnessRuntimeContext(repo.canonicalRoot, input.layoutOverrides));
  const lockPath = path.join(layout.locksRoot, "global.lock");
  if (!existsSync(lockPath)) return false;
  try {
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    if (record.ownerKind !== "daemon") return false;
    const differentUserRoot = typeof record.userRoot === "string"
      && canonicalExistingPath(record.userRoot) !== canonicalExistingPath(input.userRoot);
    const differentEndpoint = typeof record.endpoint === "string"
      && record.endpoint !== input.endpoint;
    return differentUserRoot || differentEndpoint;
  } catch {
    return false;
  }
}

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
}

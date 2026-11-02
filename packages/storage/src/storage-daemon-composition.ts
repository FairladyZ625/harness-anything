import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolvePostgresEventStoreScope } from "./pg/backend.ts";
import { consumeKnownError, resolveHarnessLayout } from "@harness-anything/kernel";
import { resolveActiveGeneration, sqliteLedgerPath } from "./store/sqlite-event-store.ts";
import { removeFileDurably } from "./durable-file.ts";
import { makeTaskProjectionReader } from "./projection/rebuildable-task-projection-factory.ts";
import { openSqliteEventStore } from "./store/sqlite-event-store.ts";
import { createPgTaskQueryReader } from "./pg/pg-task-query-reader.ts";
import { startBaseBackup } from "./fleet-basebackup.ts";
import type { ReplicationPosition, ReplicationCommit } from "./store/replication-log.ts";
import {
  canonicalDaemonRegistryRoot,
  writeDaemonRegistryRepo,
  type DaemonRegistryRegisterInput,
} from "@harness-anything/kernel/daemon-registry";
import { resolveLedgerGitLayout } from "./store/ledger-git-layout.ts";
import {
  configureLedgerMaintenance,
  installLedgerCommitGuard,
  makeLocalVersionControlSystem,
} from "./store/local-version-control-system.ts";

export function registerDaemonRepo(input: DaemonRegistryRegisterInput) {
  if (!input.canonicalRoot || input.mode === "remote-proxy") return writeDaemonRegistryRepo(input);
  const storage = input.repoId ? readDaemonStorageConfig(input.userRoot)[input.repoId] : undefined;
  if (storage?.backend === "postgres") {
    return writeDaemonRegistryRepo({ ...input, authoredBranch: storage.gitFollower?.branch ?? null });
  }
  const canonicalRoot = canonicalDaemonRegistryRoot(input.canonicalRoot);
  const ledger = resolveLedgerGitLayout(canonicalRoot);
  const vcs = makeLocalVersionControlSystem();
  configureLedgerMaintenance(ledger.rootDir);
  installLedgerCommitGuard(ledger.authoredRoot);
  const branch = vcs.originHeadBranch(ledger.rootDir) ?? vcs.currentBranch(ledger.rootDir);
  if (!branch) throw new Error(`canonicalRoot must have an attached default Git branch: ${ledger.rootDir}`);
  return writeDaemonRegistryRepo({ ...input, canonicalRoot, authoredBranch: branch });
}

export type DaemonStorageConfig =
  | import("./storage-backend.ts").SqliteStorageBackendConfig
  | import("./storage-backend.ts").PostgresStorageBackendConfig;

export function hasDaemonGitFollower(storage?: DaemonStorageConfig): boolean {
  return storage?.backend !== "postgres" || storage.gitFollower !== undefined;
}

export function readDaemonHarnessConfig(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly storage?: DaemonStorageConfig;
}): string {
  if (input.storage?.backend !== "postgres")
    return readFileSync(path.join(resolveHarnessLayout(input.rootDir).authoredRoot, "harness.yaml"), "utf8");
  const reader = makeDaemonProjectionReader(input);
  try {
    const document = reader.withSession((queries) => queries.readDocument("harness.yaml")).document;
    if (!document) throw new Error("Canonical repository configuration is unavailable");
    return document.body;
  } finally {
    reader.close();
  }
}

/** An absent deployment file preserves SQLite. Invalid explicit deployment input never falls back. */
export function readDaemonStorageConfig(userRoot?: string): Readonly<Record<string, DaemonStorageConfig>> {
  if (!userRoot) return {};
  const file = path.join(userRoot, "daemon-storage.json");
  if (!existsSync(file)) return {};
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("daemon-storage.json must contain a repository config object");
  for (const [repoId, raw] of Object.entries(value)) {
    if (!repoId || !raw || typeof raw !== "object" || Array.isArray(raw))
      throw new TypeError("daemon storage repository config is invalid");
    const config = raw as Record<string, unknown>;
    if (config.backend === "sqlite") continue;
    if (
      config.backend !== "postgres" ||
      typeof config.connectionString !== "string" ||
      !config.connectionString ||
      typeof config.authorityConnectionString !== "string" ||
      !config.authorityConnectionString
    )
      throw new TypeError("PostgreSQL daemon config requires runtime and authority connection strings");
    resolvePostgresEventStoreScope(config.scope as import("./storage-backend.ts").StorageScope | undefined);
    if (config.materialize !== undefined && typeof config.materialize !== "boolean")
      throw new TypeError("materialize must be boolean");
    if (
      config.gitFollower !== undefined &&
      (!config.gitFollower ||
        typeof config.gitFollower !== "object" ||
        typeof (config.gitFollower as { branch?: unknown }).branch !== "string" ||
        !(config.gitFollower as { branch: string }).branch)
    )
      throw new TypeError("Git follower requires a branch");
  }
  return value as Readonly<Record<string, DaemonStorageConfig>>;
}

export function prepareDaemonRepoStorage(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly mode: string;
  readonly storage?: DaemonStorageConfig;
}): void {
  if (input.storage?.backend === "postgres") return;
  // A remote edge is read-only against the center's replica. Its prior local ledger is disposable;
  // canonical repositories still go through the kernel's strict offline-conversion requirement.
  if (input.mode === "remote-edge") {
    try {
      resolveActiveGeneration({ rootInput: input.rootDir, repoId: input.repoId });
    } catch (error) {
      consumeKnownError(error);
      const generationTwo = sqliteLedgerPath(input.rootDir, 2);
      const isIncompleteUpgrade =
        error instanceof Error &&
        error.name === "TaskEventStoreError" &&
        "code" in error &&
        error.code === "invalid_store" &&
        error.message.startsWith("generation 3 upgrade is incomplete;");
      if (!isIncompleteUpgrade || !existsSync(generationTwo)) throw error;
      for (const stalePath of [
        generationTwo,
        `${generationTwo}-wal`,
        `${generationTwo}-shm`,
        `${generationTwo}.activation.json`,
        `${generationTwo}.import-source.json`,
      ])
        removeFileDurably(stalePath);
    }
  }
  // Maintenance pins and the commit guard both belong to the ledger repository, never the project
  // repository around it: the pins tune the WAL write path, and refusing a project commit is the
  // exact harm the guard exists to prevent.
  const ledgerRoot = resolveHarnessLayout(input.rootDir).authoredRoot;
  // A repository attached before its first authored write has no ledger directory yet; bootstrap
  // pins it on creation.
  if (existsSync(ledgerRoot)) {
    configureLedgerMaintenance(ledgerRoot);
    installLedgerCommitGuard(ledgerRoot);
  }
}

export async function acquireRepoStorageLock(
  storage: DaemonStorageConfig | undefined,
  acquireLocal: () => Promise<{ readonly close: () => Promise<void> }>,
) {
  return storage?.backend === "postgres" ? { close: async () => undefined } : acquireLocal();
}

export function makeDaemonProjectionReader(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly storage?: DaemonStorageConfig;
  readonly now?: () => string;
}) {
  if (input.storage?.backend === "postgres") return makeTaskProjectionReader({ ...input, storage: input.storage });
  return makeTaskProjectionReader({ rootDir: input.rootDir, storage: input.storage, now: input.now });
}

export function openFleetStorage(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly storage?: DaemonStorageConfig;
}) {
  const storage = input.storage;
  if (storage?.backend === "postgres") {
    const reader = createPgTaskQueryReader({
      connectionString: storage.connectionString,
      scope: resolvePostgresEventStoreScope(storage.scope),
      repoId: input.repoId,
      requireRuntimeRole: true,
    });
    return {
      replicationPosition: () => reader.replication("head") as ReplicationPosition,
      replicationCommits: (after: ReplicationPosition, limit: number) =>
        reader.replication("page", { after, limit }) as {
          readonly commits: readonly ReplicationCommit[];
          readonly head: ReplicationPosition;
          readonly done: boolean;
        },
      readContentObject: (sha256: string) =>
        reader.executeCanonical({ operation: "content", sha256 }) as Uint8Array | null,
      close: reader.close,
      startBackup: (directory: string, _projectionPath: string, signal?: AbortSignal) =>
        startBaseBackup({ repoId: input.repoId, storage, directory }, signal),
    };
  }
  const ledger = openSqliteEventStore({
    databasePath: sqliteLedgerPath(input.rootDir),
    rootInput: input.rootDir,
    repoId: input.repoId,
    readOnly: true,
  });
  return {
    ...ledger,
    startBackup: (directory: string, projectionPath: string, signal?: AbortSignal) =>
      startBaseBackup({ ledgerPath: ledger.databasePath, projectionPath, directory }, signal),
  };
}

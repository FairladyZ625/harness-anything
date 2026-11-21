import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolvePostgresEventStoreScope } from "./pg/backend.ts";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { normalizeNodeTaskMaterializationPolicy } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import { sqliteLedgerPath } from "./store/sqlite-event-store.ts";
import { generationThreeUpgradeStatus } from "./store/generation-three-selection.ts";
import { removeFileDurably } from "./durable-file.ts";
import { makeTaskProjectionReader } from "./projection/rebuildable-task-projection-factory.ts";
import { openSqliteEventStore } from "./store/sqlite-event-store.ts";
import { createSqlTaskQueryReader } from "./pg/sql-task-query-reader.ts";
import { retainPGliteOwner } from "./pglite/query-owner.ts";
import { startBaseBackup, type BaseBackupMode } from "./fleet-basebackup.ts";
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
  if (storage?.backend === "postgres" || storage?.backend === "pglite") {
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
  | import("./storage-backend.ts").PostgresStorageBackendConfig
  | import("./storage-backend.ts").PGliteStorageBackendConfig;

export function resolveRequiredStorageBackend(
  explicit?: import("./storage-backend.ts").StorageBackend,
  env: Readonly<Record<string, string | undefined>> = process.env,
): import("./storage-backend.ts").StorageBackend | undefined {
  if (explicit !== undefined) return explicit;
  const raw = env.HARNESS_STORAGE_BACKEND?.trim();
  if (!raw) return undefined;
  if (raw === "postgres" || raw === "sqlite" || raw === "pglite") return raw;
  throw new Error(`Invalid HARNESS_STORAGE_BACKEND: ${JSON.stringify(raw)} (expected postgres, sqlite, or pglite).`);
}

export function enforceRepoStorageBackend(input: {
  readonly requiredBackend?: import("./storage-backend.ts").StorageBackend;
  readonly repoId: string;
  readonly mode?: string;
  readonly storage?: DaemonStorageConfig;
  readonly hostCodedError: (code: string, message: string) => Error;
}): void {
  if (!input.requiredBackend || input.mode === "remote-proxy") return;
  if (input.requiredBackend === "postgres") {
    const valid =
      input.storage?.backend === "postgres" &&
      typeof input.storage.connectionString === "string" &&
      input.storage.connectionString.trim().length > 0 &&
      typeof input.storage.authorityConnectionString === "string" &&
      input.storage.authorityConnectionString.trim().length > 0;
    if (!valid) {
      throw input.hostCodedError(
        "invalid_field",
        `Repository ${input.repoId} requires a valid postgres entry in daemon-storage.json because this daemon enforces storage.backend=postgres.`,
      );
    }
    return;
  }
  if (input.requiredBackend === "sqlite") {
    if (input.storage && input.storage.backend && input.storage.backend !== "sqlite") {
      throw input.hostCodedError(
        "invalid_field",
        `Repository ${input.repoId} declares storage backend "${input.storage.backend}" which conflicts with enforced storage.backend=sqlite.`,
      );
    }
    return;
  }
  if (input.requiredBackend === "pglite" && input.storage?.backend !== "pglite") {
    throw input.hostCodedError(
      "invalid_field",
      `Repository ${input.repoId} requires a pglite entry in daemon-storage.json because this daemon enforces storage.backend=pglite.`,
    );
  }
}

export function hasDaemonGitFollower(storage?: DaemonStorageConfig): boolean {
  return (storage?.backend !== "postgres" && storage?.backend !== "pglite") || storage.gitFollower !== undefined;
}

export function readDaemonHarnessConfig(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly storage?: DaemonStorageConfig;
}): string {
  if (input.storage?.backend !== "postgres" && input.storage?.backend !== "pglite")
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
    if (config.nodeTaskMaterializationPolicy !== undefined)
      normalizeNodeTaskMaterializationPolicy(config.nodeTaskMaterializationPolicy);
    if (config.backend === "sqlite") continue;
    if (config.backend === "pglite") {
      if (typeof config.dataDir !== "string" || !path.isAbsolute(config.dataDir))
        throw new TypeError("PGlite daemon config requires an absolute filesystem dataDir");
    } else if (
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
  if (input.storage?.backend === "postgres" || input.storage?.backend === "pglite") return;
  // A remote edge is read-only against the center's replica. Its prior local ledger is disposable;
  // canonical repositories still go through the kernel's strict offline-conversion requirement.
  if (
    input.mode === "remote-edge" &&
    generationThreeUpgradeStatus({ rootInput: input.rootDir, repoId: input.repoId }) === "incomplete"
  ) {
    const generationTwo = sqliteLedgerPath(input.rootDir, 2);
    if (existsSync(generationTwo))
      for (const stalePath of [
        generationTwo,
        `${generationTwo}-wal`,
        `${generationTwo}-shm`,
        `${generationTwo}.activation.json`,
        `${generationTwo}.import-source.json`,
      ])
        removeFileDurably(stalePath);
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
  repoId?: string,
) {
  if (storage?.backend === "postgres") return { close: async () => undefined };
  const lock = await acquireLocal();
  if (storage?.backend !== "pglite") return lock;
  try {
    if (!repoId) throw new TypeError("PGlite storage owner requires repoId");
    const release = retainPGliteOwner(repoId, storage);
    return {
      close: async () => {
        try {
          release();
        } finally {
          await lock.close();
        }
      },
    };
  } catch (error) {
    await lock.close();
    throw error;
  }
}

export function makeDaemonProjectionReader(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly storage?: DaemonStorageConfig;
  readonly now?: () => string;
}) {
  if (input.storage?.backend === "postgres" || input.storage?.backend === "pglite")
    return makeTaskProjectionReader({ ...input, storage: input.storage });
  return makeTaskProjectionReader({ rootDir: input.rootDir, storage: input.storage, now: input.now });
}

/** SQL workers publish the shared commit phase; synchronous SQLite batches drain on close. */
export function daemonWriterSupportsCommitPhase(storage?: DaemonStorageConfig): boolean {
  return storage?.backend === "postgres" || storage?.backend === "pglite";
}

/** Storage owns backend dispatch; the host only resolves its physical Worker module. */
export function daemonWriterEntryName(storage?: DaemonStorageConfig): string {
  return storage?.backend === "postgres"
    ? "repo-writer-worker-pg"
    : storage?.backend === "pglite"
      ? "repo-writer-worker-pglite"
      : "repo-writer-worker";
}

/** Network PostgreSQL pins its own MVCC backup cut; local engines retain the writer barrier. */
export function fleetBackupRequiresWriter(storage?: DaemonStorageConfig): boolean {
  return storage?.backend !== "postgres";
}

export function openFleetStorage(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly storage?: DaemonStorageConfig;
  /** Backup-only callers need no query worker; ordinary readers initialize before they are exposed. */
  readonly deferReader?: boolean;
}) {
  const storage = input.storage;
  if (storage?.backend === "postgres" || storage?.backend === "pglite") {
    let opened: ReturnType<typeof createSqlTaskQueryReader> | undefined;
    const reader = () =>
      (opened ??= createSqlTaskQueryReader({
        storage,
        repoId: input.repoId,
        requireRuntimeRole: true,
      }));
    if (!input.deferReader) reader();
    return {
      replicationPosition: () => reader().replication("head") as ReplicationPosition,
      replicationCommits: (after: ReplicationPosition, limit: number) =>
        reader().replication("page", { after, limit }) as {
          readonly commits: readonly ReplicationCommit[];
          readonly head: ReplicationPosition;
          readonly done: boolean;
        },
      readContentObject: (sha256: string) =>
        reader().executeCanonical({ operation: "content", sha256 }) as Uint8Array | null,
      close: () => opened?.close(),
      startBackup: (
        directory: string,
        _projectionPath: string,
        signal?: AbortSignal,
        backupOptions?: { readonly mode?: BaseBackupMode },
      ) => startBaseBackup({ repoId: input.repoId, storage, directory, mode: backupOptions?.mode }, signal),
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
    startBackup: (
      directory: string,
      projectionPath: string,
      signal?: AbortSignal,
      backupOptions?: { readonly mode?: BaseBackupMode },
    ) =>
      startBaseBackup(
        { ledgerPath: ledger.databasePath, projectionPath, directory, mode: backupOptions?.mode },
        signal,
      ),
  };
}

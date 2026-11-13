import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { replayTaskStatuses } from "@harness-anything/kernel/internal/domain/task.ts";
import { taskIncludedByNodeMaterializationPolicy } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import type { TaskProjectionQueries } from "@harness-anything/kernel/internal/ports/task-projection.ts";
import type { StorageScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";
import type { NodeTaskMaterializationPolicy } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
export type { StorageScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";

export interface SqliteStorageBackendConfig {
  readonly backend?: "sqlite";
  readonly scope?: StorageScope;
  readonly nodeTaskMaterializationPolicy?: NodeTaskMaterializationPolicy;
}

export interface PostgresStorageBackendConfig {
  readonly backend: "postgres";
  readonly connectionString: string;
  readonly scope?: StorageScope;
  /** Management connection owns writer epochs; runtime traffic still uses the RLS role. */
  readonly authorityConnectionString?: string;
  /** Omitted means canonical data does not require a Git repository. */
  readonly gitFollower?: { readonly branch: string };
  /** Centers without agents may leave their authored tree unmaterialized. */
  readonly materialize?: boolean;
  readonly nodeTaskMaterializationPolicy?: NodeTaskMaterializationPolicy;
}

export interface PGliteStorageBackendConfig {
  /** A filesystem directory, `memory://...`, or another PGlite data-dir URI. */
  readonly backend: "pglite";
  readonly dataDir?: string;
  readonly scope?: StorageScope;
  readonly gitFollower?: { readonly branch: string };
  readonly materialize?: boolean;
  readonly nodeTaskMaterializationPolicy?: NodeTaskMaterializationPolicy;
}

export type StorageBackendConfig =
  | SqliteStorageBackendConfig
  | PostgresStorageBackendConfig
  | PGliteStorageBackendConfig;
export type StorageBackend = "sqlite" | "postgres" | "pglite";

/** Factories accept one configuration field; omitting it keeps the SQLite default. */
export interface StorageBackendOptions {
  readonly storage?: StorageBackendConfig;
}

export interface ResolvedStorageBackend {
  readonly backend: StorageBackend;
  readonly connectionString?: string;
  readonly dataDir?: string;
  readonly scope?: StorageScope;
}

export class UnsupportedStorageBackendError extends Error {
  readonly code = "backend_not_implemented";

  constructor(backend: StorageBackend) {
    super(`storage backend "${backend}" is not implemented by kernel Wave 1`);
    this.name = "UnsupportedStorageBackendError";
  }
}

export function resolveStorageBackend(options: StorageBackendOptions = {}): ResolvedStorageBackend {
  const config = options.storage;
  return {
    backend: config?.backend ?? "sqlite",
    ...(config?.backend === "postgres" ? { connectionString: config.connectionString } : {}),
    ...(config?.backend === "pglite" && config.dataDir !== undefined ? { dataDir: config.dataDir } : {}),
    ...(config?.scope === undefined ? {} : { scope: config.scope }),
  };
}

export function unsupportedStorageBackendError(backend: StorageBackend): UnsupportedStorageBackendError {
  return new UnsupportedStorageBackendError(backend);
}

/** Enumerate only the node working set with indexed status and package-prefix reads. */
export function readNodeMaterializationDocuments(
  q: TaskProjectionQueries,
  policy: NodeTaskMaterializationPolicy,
  forced: readonly string[] = [],
) {
  type Descriptor = ReturnType<typeof q.readDocuments>["documents"][number];
  const documents = new Map<string, Descriptor>();
  const page = (prefix: string, excludeTaskPackages = false) => {
    let afterPath: string | undefined;
    for (;;) {
      const result = q.readDocuments(prefix, {
        limit: storageReadPolicy.defaultValue.pageSizes.standard,
        excludeTaskPackages,
        ...(afterPath === undefined ? {} : { afterPath }),
      });
      if (result.status !== "ready" || result.watermark !== result.sourceRevision)
        throw new TaskEventStoreError("publication_indeterminate", "Materialization projection is catching up");
      for (const document of result.documents) documents.set(document.path, document);
      if (result.page!.nextPath === null) break;
      afterPath = result.page!.nextPath;
    }
  };
  if (policy !== "none") {
    page("", true);
    const tasks = replayTaskStatuses
        .filter((status) => taskIncludedByNodeMaterializationPolicy(policy, { status }))
        .flatMap((status) => q.readTaskIndex({ status, activePackagesOnly: true }).rows),
      full = new Set(tasks.map(({ taskId }) => taskId));
    for (const task of tasks) if (task.packagePath) page(`${task.packagePath}/`);
    const sources = tasks
        .filter((task) => taskIncludedByNodeMaterializationPolicy("in_flight", task))
        .map(({ taskId }) => `task/${taskId}`),
      dependencies = sources.length ? q.readTaskRelationsBySources(sources, "depends-on").rows : [],
      targets = [
        ...new Set(
          dependencies
            .filter(({ state }) => state === "active")
            .flatMap(({ targetRef }) => /^task\/([^/]+)$/u.exec(targetRef)?.[1] ?? []),
        ),
      ].filter((id) => !full.has(id));
    for (const task of targets.length ? q.readTaskIndex({ taskIds: targets }).rows : [])
      if (task.packagePath)
        for (const name of ["INDEX.md", "task_plan.md", "task-contract.json"]) {
          const document = q.readDocument(`${task.packagePath}/${name}`).document;
          if (document) documents.set(document.path, document);
        }
  }
  for (const path of forced) {
    const document =
      q.readDocument(path).document ?? (path.startsWith("tasks/") ? q.readDocumentHistory?.(path).document : null);
    if (document) documents.set(path, document);
  }
  return [...documents.values()].sort((a, b) => a.path.localeCompare(b.path));
}

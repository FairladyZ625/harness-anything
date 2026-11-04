export interface StorageScope {
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly readers?: readonly string[];
  readonly policyEpoch?: number;
}

export interface SqliteStorageBackendConfig {
  readonly backend?: "sqlite";
  readonly scope?: StorageScope;
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
}

export interface PGliteStorageBackendConfig {
  /** A filesystem directory, `memory://...`, or another PGlite data-dir URI. */
  readonly backend: "pglite";
  readonly dataDir?: string;
  readonly scope?: StorageScope;
  readonly gitFollower?: { readonly branch: string };
  readonly materialize?: boolean;
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

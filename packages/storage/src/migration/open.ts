import { Pool } from "pg";
import type { StorageBackendConfig } from "../storage-backend.ts";
import { openPGliteOwnerMigrationEndpoint } from "../pglite/owner-service.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import { openSqliteMigrationEndpoint } from "./sqlite-endpoint.ts";
import { openPgMigrationEndpoint } from "./postgres-endpoint.ts";
import { migrateStorage } from "./engine.ts";
import { StorageMigrationError } from "./types.ts";

export interface StorageMigrationLocation {
  readonly rootDir?: string;
  readonly storage: StorageBackendConfig;
}
export async function openStorageMigrationEndpoint(
  repoId: string,
  location: StorageMigrationLocation,
  role: "source" | "target" = "source",
) {
  const storage = location.storage,
    scope = resolvePostgresEventStoreScope(storage.scope);
  if (storage.backend === undefined || storage.backend === "sqlite") {
    if (!location.rootDir)
      throw new StorageMigrationError("storage_migration_invalid", "SQLite endpoint requires rootDir");
    return openSqliteMigrationEndpoint({ repoId, rootDir: location.rootDir, role, scope });
  }
  if (storage.backend === "pglite") {
    return openPGliteOwnerMigrationEndpoint(repoId, storage);
  }
  if (storage.backend !== "postgres")
    throw new StorageMigrationError("storage_migration_invalid", "unknown storage backend");
  const pool = new Pool({
    connectionString: storage.authorityConnectionString || storage.connectionString,
    max: 2,
  });
  try {
    const endpoint = await openPgMigrationEndpoint({ pool, repoId, scope });
    return { ...endpoint, close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
export async function runStorageMigration(input: {
  readonly repoId: string;
  readonly runId: string;
  readonly source: StorageMigrationLocation;
  readonly target: StorageMigrationLocation;
  readonly exportDirectory: string;
  readonly mode?: "migrate" | "resume" | "abort" | "preflight";
}) {
  const source = await openStorageMigrationEndpoint(input.repoId, input.source);
  try {
    const target = await openStorageMigrationEndpoint(input.repoId, input.target, "target");
    try {
      return await migrateStorage({ ...input, source, target });
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

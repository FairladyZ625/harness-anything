import { randomUUID } from "node:crypto";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import { createPgTaskQueryReader, type PgTaskQueryReader } from "../pg/pg-task-query-reader.ts";
import { requireSqlTaskQueryReader } from "../sql-backend-adapters.ts";
import type { PostgresStorageBackendConfig, PGliteStorageBackendConfig } from "../storage-backend.ts";
import { WriterEpochError, type PersistentWriterEpoch, type WriterEpochLease } from "../writer-epoch-contract.ts";
import type { PgEpochOperation } from "./pg-epoch-transaction.ts";
import { configureWriterEpochStorage } from "../writer-epoch-storage.ts";

export function openPgWriterEpoch(options: {
  readonly stateRoot: string;
  readonly storage: PostgresStorageBackendConfig | PGliteStorageBackendConfig;
  readonly holderId?: string;
  readonly now?: () => string;
}): PersistentWriterEpoch {
  if (options.storage.backend === "postgres" && !options.storage.authorityConnectionString)
    throw new WriterEpochError("writer_epoch_invalid", "PostgreSQL writer epoch requires an authority connection");
  const holderId = options.holderId ?? `center-${process.pid}-${randomUUID()}`,
    now = options.now ?? (() => new Date().toISOString()),
    readers = new Map<string, PgTaskQueryReader>(),
    readerFor = (repoId: string, lane = "append") => {
      const key = `${repoId}\0${lane}`;
      let reader = readers.get(key);
      if (!reader) {
        reader =
          options.storage.backend === "postgres"
            ? createPgTaskQueryReader({
                scope: resolvePostgresEventStoreScope(options.storage.scope),
                connectionString: options.storage.connectionString,
                authorityConnectionString: options.storage.authorityConnectionString,
                requireRuntimeRole: true,
                repoId,
              })
            : requireSqlTaskQueryReader("pglite")({
                storage: options.storage,
                epochAuthority: true,
                requireRuntimeRole: true,
                repoId,
              });
        readers.set(key, reader);
      }
      return reader;
    },
    execute = (
      operation: PgEpochOperation,
      repoId: string,
      epoch?: number,
      expectedHolder = holderId,
      floor?: number,
      lane = "append",
    ) => readerFor(repoId, lane).writerEpoch({ operation, repoId, holderId: expectedHolder, now: now(), epoch, floor });
  const fenceFor = (lane: string): PersistentWriterEpoch["withAppendFence"] => {
    let held: { repoId: string; epoch: number; holder: string } | null = null;
    return (repoId, epoch, holder, operation) => {
      if (held) {
        if (held.repoId !== repoId || held.epoch !== epoch || held.holder !== holder)
          throw new WriterEpochError("writer_epoch_invalid", "Nested PG fence names another owner");
        return operation();
      }
      execute("begin", repoId, epoch, holder, undefined, lane);
      held = { repoId, epoch, holder };
      try {
        return operation();
      } finally {
        held = null;
        execute("end", repoId, undefined, holderId, undefined, lane);
      }
    };
  };
  const fenceForAsync = (lane: string): NonNullable<PersistentWriterEpoch["withFollowerFenceAsync"]> => {
    let queue: Promise<void> = Promise.resolve();
    return async (repoId, epoch, holder, operation) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        execute("begin", repoId, epoch, holder, undefined, lane);
        try {
          return await operation();
        } finally {
          execute("end", repoId, undefined, holderId, undefined, lane);
        }
      } finally {
        release();
      }
    };
  };
  const appendFence = fenceFor("append");
  return {
    acquire: (repoId, floor = 0) => {
      configureWriterEpochStorage({ stateRoot: options.stateRoot, repoId }, options.storage);
      return execute("acquire", repoId, undefined, holderId, floor) as WriterEpochLease;
    },
    current: (repoId) => execute("current", repoId) as WriterEpochLease | null,
    highWatermark: (repoId) => execute("floor", repoId) as number,
    retireCurrent: (repoId) => {
      execute("retire", repoId);
    },
    assert: (repoId, epoch, holder = holderId) => appendFence(repoId, epoch, holder, () => undefined),
    withAppendFence: appendFence,
    withFollowerFence: fenceFor("follower"),
    withFollowerFenceAsync: fenceForAsync(options.storage.backend === "postgres" ? "follower-async" : "follower"),
    close: () => {
      for (const reader of readers.values()) reader.close();
      readers.clear();
    },
  };
}

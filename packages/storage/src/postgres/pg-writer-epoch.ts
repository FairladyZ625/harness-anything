import { randomUUID } from "node:crypto";
import { createPgTaskQueryReader } from "../pg/pg-task-query-reader.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import type { PostgresStorageBackendConfig } from "../storage-backend.ts";
import { WriterEpochError, type PersistentWriterEpoch, type WriterEpochLease } from "../writer-epoch-contract.ts";
import type { PgEpochOperation } from "./pg-epoch-transaction.ts";
import { configureWriterEpochStorage } from "../writer-epoch-storage.ts";

export function openPgWriterEpoch(options: {
  readonly stateRoot: string;
  readonly storage: PostgresStorageBackendConfig;
  readonly holderId?: string;
  readonly now?: () => string;
}): PersistentWriterEpoch {
  if (!options.storage.authorityConnectionString)
    throw new WriterEpochError("writer_epoch_invalid", "PostgreSQL writer epoch requires an authority connection");
  const holderId = options.holderId ?? `center-${process.pid}-${randomUUID()}`,
    now = options.now ?? (() => new Date().toISOString()),
    readers = new Map<string, ReturnType<typeof createPgTaskQueryReader>>(),
    readerFor = (repoId: string) => {
      let reader = readers.get(repoId);
      if (!reader) {
        reader = createPgTaskQueryReader({
          connectionString: options.storage.connectionString,
          authorityConnectionString: options.storage.authorityConnectionString,
          requireRuntimeRole: true,
          scope: resolvePostgresEventStoreScope(options.storage.scope),
          repoId,
        });
        readers.set(repoId, reader);
      }
      return reader;
    },
    execute = (
      operation: PgEpochOperation,
      repoId: string,
      epoch?: number,
      expectedHolder = holderId,
      floor?: number,
    ) => readerFor(repoId).writerEpoch({ operation, repoId, holderId: expectedHolder, now: now(), epoch, floor });
  let held: { repoId: string; epoch: number; holder: string } | null = null;
  const fenced: PersistentWriterEpoch["withAppendFence"] = (repoId, epoch, holder, operation) => {
    if (held) {
      if (held.repoId !== repoId || held.epoch !== epoch || held.holder !== holder)
        throw new WriterEpochError("writer_epoch_invalid", "Nested PG fence names another owner");
      return operation();
    }
    execute("begin", repoId, epoch, holder);
    held = { repoId, epoch, holder };
    try {
      return operation();
    } finally {
      held = null;
      execute("end", repoId);
    }
  };
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
    assert: (repoId, epoch, holder = holderId) => fenced(repoId, epoch, holder, () => undefined),
    withAppendFence: fenced,
    close: () => {
      for (const reader of readers.values()) reader.close();
      readers.clear();
    },
  };
}
